// Exercise the live-key HTTP flow through the real provider selection. Only provider I/O and
// the display-only gas estimate are stubbed: no real deposit address or funds are used in CI.
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import {
  HttpOneClick,
  resetOneClickProviders,
  SimulatedOneClick,
} from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import * as gasFees from '../gas/fees.js';
import { prisma } from '../lib/prisma.js';
import { createApiKey, createMerchant, createRow, resetDb, setLiveMode } from '../test/helpers.js';

const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ETH_USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const ACCOUNT = 'live-checkout.tendr.near';

describe('live payment-link API through checkout quoting', () => {
  let app: FastifyInstance;
  let liveKey: string;
  let merchantId: string;

  beforeEach(async () => {
    await resetDb();
    resetTokenCache();
    resetOneClickProviders();
    setLiveMode(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(gasFees, 'estimateNetworkFeeUsd').mockResolvedValue('0.02');
    vi.spyOn(HttpOneClick.prototype, 'tokens').mockResolvedValue(
      [
        [NEAR_USDC, 'near'],
        [BASE_USDC, 'base'],
        [ETH_USDC, 'eth'],
      ].map(([assetId, blockchain]) => ({
        assetId: assetId!,
        blockchain: blockchain!,
        symbol: 'USDC',
        decimals: 6,
        priceUsd: '1',
      })),
    );
    app = await buildApp();
    await app.ready();
    const merchant = await createMerchant({ slug: 'live-checkout', defaultGasPayer: 'buyer' });
    merchantId = merchant.id;
    await createRow('MerchantAccount', merchantId, true, {
      status: 'active',
      nearAccountId: ACCOUNT,
    });
    await createRow('SettlementConfig', merchantId, true, {
      destAssetId: NEAR_USDC,
      destChain: 'near',
      payoutMode: 'intents',
      isDefault: true,
    });
    liveKey = (await createApiKey(merchantId, { livemode: true })).raw;
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    resetTokenCache();
    resetOneClickProviders();
    setLiveMode(undefined);
  });
  afterAll(() => prisma.$disconnect());

  it.each([undefined, BASE_USDC])('quotes %s into the same live account', async (override) => {
    const destination = override ?? NEAR_USDC;
    const quote = vi.spyOn(HttpOneClick.prototype, 'quote').mockImplementation(async (req) => ({
      correlationId: 'live-route-fixture',
      quote: {
        amountIn: req.amount,
        amountInUsd: String(Number(req.amount) / 1e6),
        amountOut: req.amount,
        amountOutUsd: String(Number(req.amount) / 1e6),
        deadline: req.deadline,
        ...(!req.dry ? { depositAddress: '0x1111111111111111111111111111111111111111' } : {}),
      },
    }));
    const simulated = vi.spyOn(SimulatedOneClick.prototype, 'quote');
    const headers = { authorization: `Bearer ${liveKey}` };
    const options = await app.inject({ url: '/v1/payment_links/settlement-options', headers });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json()).toMatchObject({ livemode: true });
    expect(options.json().tokens).toContainEqual({
      asset: BASE_USDC,
      chain: 'base',
      symbol: 'USDC',
      decimals: 6,
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/payment_links',
      headers,
      payload: {
        title: 'Live invoice',
        amount_type: 'fixed',
        amount: '5.00',
        currency: 'USD',
        fee_payer: 'shopper',
        ...(override ? { settlement_asset: override } : {}),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const link = created.json();
    expect(link.livemode).toBe(true);
    const publicSession = await app.inject({
      method: 'POST',
      url: `/v1/payment_links/public/live-checkout/${link.slug}/sessions`,
      payload: {},
    });
    expect(publicSession.statusCode, publicSession.body).toBe(201);
    const session = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers,
      payload: {
        payment_link_id: link.id,
        amount: '5.00',
        amount_currency: 'USD',
        external_ref: 'live-order',
        success_url: 'https://shop.example/paid',
        cancel_url: 'https://shop.example/cancel',
      },
    });
    expect(session.statusCode, session.body).toBe(201);
    const client = { authorization: `Bearer ${session.json().client_secret}` };
    const result = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: client,
      payload: { origin_asset: ETH_USDC },
    });
    expect(result.statusCode, result.body).toBe(201);
    expect(simulated).not.toHaveBeenCalled();
    expect(quote).toHaveBeenCalled();
    for (const [request] of quote.mock.calls) {
      expect(request).toMatchObject({
        originAsset: ETH_USDC,
        destinationAsset: destination,
        recipient: ACCOUNT,
        recipientType: 'INTENTS',
        refundTo: ACCOUNT,
        refundType: 'INTENTS',
      });
    }
    expect(quote.mock.calls.some(([request]) => !request.dry)).toBe(true);
    const sessions = await prisma.session.findMany({ where: { merchantId } });
    expect(sessions).toHaveLength(2);
    for (const row of sessions)
      expect(row).toMatchObject({
        livemode: true,
        destAsset: destination,
        destChain: 'near',
        recipient: ACCOUNT,
      });
    setLiveMode(false);
    const disabled = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: client,
      payload: { origin_asset: ETH_USDC },
    });
    expect(disabled.statusCode, disabled.body).toBe(403);
    expect(disabled.json().error.code).toBe('LIVE_MODE_UNAVAILABLE');
  });
});
