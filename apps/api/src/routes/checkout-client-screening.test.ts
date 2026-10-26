// I-3: a refund address that could not be screened is never handed to 1Click as `refundTo`.
// Screening is mocked here (test mode never reaches Chainalysis): `unavailable` for every address.
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import type * as Screening from '../checkout/screening.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { prisma } from '../lib/prisma.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';

vi.mock('../checkout/screening.js', async (importOriginal) => {
  const real = await importOriginal<typeof Screening>();
  return { ...real, screenAddress: vi.fn(async () => ({ decision: 'unavailable' as const })) };
});

const sim1click = isolatedSimStore();
const ETH = 'nep141:eth.test';
const USDC = 'nep141:usdc.test';
const WALLET = '0x1111111111111111111111111111111111111111';

describe('quote with screening unavailable (I-3)', () => {
  let app: FastifyInstance;
  let testKey: string;
  let accountId: string;
  let sim: SimulatedOneClick;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    const merchant = await createMerchant({
      defaultFeePayer: 'merchant',
      defaultGasPayer: 'buyer',
    });
    const account = await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    accountId = account.nearAccountId as string;
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC,
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    resetTokenCache();
    resetOneClickProviders();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  it('quotes with refundType INTENTS (the store path), never the unscreened address', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${testKey}` },
      payload: {
        amount: '25.00',
        amount_currency: 'USD',
        external_ref: 'order-i3',
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { client_secret } = created.json() as { client_secret: string };
    const quoteSpy = vi.spyOn(sim, 'quote');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${client_secret}` },
      payload: { origin_asset: ETH, refund_address: WALLET },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ refund: 'store', refund_address: null });
    for (const [req] of quoteSpy.mock.calls) {
      expect(req.refundTo).toBe(accountId);
      expect(req.refundType).toBe('INTENTS');
    }
    const row = await prisma.quote.findFirstOrThrow({ where: { refundTo: accountId } });
    expect(row.refundType).toBe('INTENTS');
    expect(await prisma.quote.count({ where: { refundTo: WALLET } })).toBe(0);
  });
});
