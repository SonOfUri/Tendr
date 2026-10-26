import type { Merchant } from '@prisma/client';
import type { MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryMailer, setMailer } from '../auth/mailer.js';
import { feeKindOf } from '../checkout/payment-views.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { registerRefundHooks, setRefundDeps } from '../checkout/refunds.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { onReturnNeeded, pollDeposit, registerWatcherHooks } from '../checkout/watcher.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { createApiKey, createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';

const sim1click = isolatedSimStore();
const ETH = 'nep141:eth.omft.near';
const USDC = 'nep141:usdc.test';

describe('fee line kinds', () => {
  it('maps every revenue source, and an unknown one to other', () => {
    expect(feeKindOf('app_fee')).toBe('tendr_fee');
    expect(feeKindOf('oneclick_fee')).toBe('oneclick_fee');
    expect(feeKindOf('spread')).toBe('oneclick_fee');
    expect(feeKindOf('network_fee')).toBe('network_fee');
    expect(feeKindOf('gas_reimbursement')).toBe('gas_reimbursement');
    expect(feeKindOf('future_source')).toBe('other');
    expect(feeKindOf('toString')).toBe('other');
  });
});

describe('dashboard payments', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let viewer: Login;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetNearClients();
    fakeNearClient(false);
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    registerRefundHooks();
    setMailer(new MemoryMailer());
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Bean Shop' });
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC,
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    viewer = await member('viewer');
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    setRefundDeps(null);
    onReturnNeeded(null);
    setMailer(null);
    resetTokenCache();
    resetOneClickProviders();
    resetNearClients();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  async function member(role: MerchantUserRole, m: Merchant = merchant) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', m.id, false, { userId: user.id, role });
    return loginAs(user.id);
  }

  const get = (url: string, who = viewer, opts: { livemode?: boolean; merchantId?: string } = {}) =>
    app.inject({
      method: 'GET',
      url,
      headers: dashHeaders(who, {
        merchantId: opts.merchantId ?? merchant.id,
        livemode: opts.livemode ?? false,
      }),
    });

  async function settled(scenario: 'exact' | 'overpay' = 'exact') {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${testKey}` },
      payload: {
        amount: '25.00',
        amount_currency: 'USD',
        external_ref: `order-${Math.random().toString(36).slice(2)}`,
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json() as { id: string; client_secret: string };
    const qr = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${s.client_secret}` },
      payload: { origin_asset: ETH },
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const q = qr.json() as { id: string; deposit_address: string; amount_in: string };
    await sim.simulate(q.deposit_address, scenario);
    await pollDeposit(q.deposit_address, { livemode: false });
    const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: q.id } });
    expect(p.status).toBe('SETTLED');
    return { s, q, p };
  }

  it('lists this store and mode only, newest first, with filters and a cursor', async () => {
    const a = await settled();
    const b = await settled();
    const other = await createMerchant();
    await createRow('Payment', other.id, false, {});
    const live = await createRow('Payment', merchant.id, true, {});

    let res = await get('/v1/payments');
    expect(res.statusCode, res.body).toBe(200);
    let body = res.json();
    expect(body.payments.map((x: { id: string }) => x.id)).toEqual([b.p.id, a.p.id]);
    expect(body.payments[0]).toMatchObject({
      status: 'SETTLED',
      session_id: b.s.id,
      order: { amount: '25', currency: 'USD' },
      source: { asset: ETH },
      received: { asset: ETH },
      settlement: { asset: USDC, chain: 'near' },
    });
    expect(body.payments[0].received.amount).toMatch(/^\d+$/);

    res = await get('/v1/payments?limit=1');
    body = res.json();
    expect(body.payments.map((x: { id: string }) => x.id)).toEqual([b.p.id]);
    expect(body.has_more).toBe(true);
    res = await get(`/v1/payments?limit=1&starting_after=${body.next_cursor}`);
    expect(res.json().payments.map((x: { id: string }) => x.id)).toEqual([a.p.id]);
    expect(res.json().has_more).toBe(false);

    expect((await get('/v1/payments?status=HELD')).json().payments).toEqual([]);
    expect((await get('/v1/payments?status=SETTLED')).json().payments).toHaveLength(2);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await get(`/v1/payments?created_from=${future}`)).json().payments).toEqual([]);
    expect((await get(`/v1/payments?created_to=${future}`)).json().payments).toHaveLength(2);
    expect((await get('/v1/payments?status=PAID')).statusCode).toBe(400);
    expect((await get('/v1/payments?created_from=yesterday')).statusCode).toBe(400);

    const liveRes = await get('/v1/payments', viewer, { livemode: true });
    expect(liveRes.json().payments.map((x: { id: string }) => x.id)).toEqual([live.id]);
  });

  it('the detail breaks the fees out (network fee estimated) with integer-string amounts', async () => {
    const { p, q } = await settled('overpay');
    const res = await get(`/v1/payments/${p.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d.id).toBe(p.id);
    expect(d.fees_recorded).toBe(true);
    const kinds = d.fees.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tendr_fee', 'network_fee']));
    for (const f of d.fees) {
      expect(f.amount).toMatch(/^\d+$/);
      expect(f.asset).toBe(ETH);
      expect(f.estimated).toBe(f.kind === 'network_fee' || f.kind === 'gas_reimbursement');
      if (f.amount_usd !== null) expect(f.amount_usd).toMatch(/^\d+(\.\d+)?$/);
    }
    expect(d.quote.amount_in).toBe(q.amount_in);
    expect(d.source.asset).toBe(ETH);
    expect(d.source.chain).toBeTruthy();
    expect(d.transactions.settlement).toMatchObject({ chain: 'near' });
    expect(d.transactions.settlement.hash).toBeTruthy();
    // The overpay excess return is listed with its status.
    expect(d.refunds).toHaveLength(1);
    expect(d.refunds[0]).toMatchObject({ reason: 'overpaid', status: 'pending' });
    expect(d.refunds[0].amount).toMatch(/^\d+$/);
  });

  it("another store's or mode's payment is 404; every role can read; no store header is 400", async () => {
    const { p } = await settled();
    const other = await createMerchant();
    const theirs = await createRow('Payment', other.id, false, {});
    expect((await get(`/v1/payments/${theirs.id}`)).statusCode).toBe(404);
    expect((await get(`/v1/payments/${p.id}`, viewer, { livemode: true })).statusCode).toBe(404);
    // A member of the other store cannot see ours either.
    const outsider = await member('owner', other);
    expect((await get(`/v1/payments/${p.id}`, outsider, { merchantId: other.id })).statusCode).toBe(
      404,
    );
    expect((await get('/v1/payments', outsider)).statusCode).toBe(403);
    for (const role of ['finance', 'admin', 'owner'] as const) {
      expect((await get(`/v1/payments/${p.id}`, await member(role))).statusCode).toBe(200);
    }
    const noStore = await app.inject({
      method: 'GET',
      url: '/v1/payments',
      headers: dashHeaders(viewer),
    });
    expect(noStore.statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: '/v1/payments' });
    expect(anon.statusCode).toBe(401);
    const apiKey = await app.inject({
      method: 'GET',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${testKey}` },
    });
    expect(apiKey.statusCode).toBe(403);
  });
});
