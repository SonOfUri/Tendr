import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';

const sim1click = isolatedSimStore();
const ETH = 'nep141:eth.test'; // blockchain "eth", 18 decimals, $2500 in the simulation
const USDC = 'nep141:usdc.test'; // blockchain "near", 6 decimals, $1
const WALLET = '0x1111111111111111111111111111111111111111';
const SANCTIONED = '0x000000000000000000000000000000000000dEaD';

describe('shopper checkout routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
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
    merchant = await createMerchant({
      name: 'Bean Shop',
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
    vi.restoreAllMocks();
    resetTokenCache();
    resetOneClickProviders();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  async function newSession(over: Record<string, unknown> = {}, key = testKey) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        amount: '25.00',
        amount_currency: 'USD',
        external_ref: `order-${Math.random().toString(36).slice(2)}`,
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
        ...over,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; client_secret: string };
  }

  function call(method: 'GET' | 'POST', path: string, secret: string, payload?: unknown) {
    return app.inject({
      method,
      url: `/v1/checkout/client/${path}`,
      headers: { authorization: `Bearer ${secret}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  it('the session view is shopper-safe and has no quote before one is requested', async () => {
    const s = await newSession();
    const res = await call('GET', 'session', s.client_secret);
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json();
    expect(v.id).toBe(s.id);
    expect(v.merchant).toEqual({ name: 'Bean Shop', logo_url: null });
    expect(v.amount).toBe('25');
    expect(v.amount_currency).toBe('USD');
    expect(v.status).toBe('PENDING_DEPOSIT');
    expect(v.quote).toBeNull();
    expect(v.payments).toEqual([]);
    expect(v.needs_email).toBe(false);
    const raw = res.body;
    expect(raw).not.toContain(merchant.id);
    expect(raw).not.toContain(accountId);
    expect(raw).not.toContain('client_secret');
    expect(raw).not.toContain('external_ref');
  });

  it('lists tokens with popular ones first', async () => {
    const s = await newSession();
    const res = await call('GET', 'tokens', s.client_secret);
    expect(res.statusCode, res.body).toBe(200);
    const tokens = res.json().tokens as { asset_id: string; symbol: string; popular: boolean }[];
    expect(tokens.length).toBeGreaterThan(5);
    // Popular ones form a prefix, in popularity order (USDC first).
    const firstNonPopular = tokens.findIndex((t) => !t.popular);
    if (firstNonPopular !== -1) {
      expect(tokens.slice(firstNonPopular).every((t) => !t.popular)).toBe(true);
    }
    expect(tokens[0]!.symbol).toBe('USDC');
    expect(tokens.findIndex((t) => t.symbol === 'ETH')).toBeLessThan(
      tokens.findIndex((t) => t.symbol === 'BTC'),
    );
    expect(tokens.some((t) => t.asset_id === ETH)).toBe(true);
  });

  it('a connected wallet is refundTo on the origin chain, and the quote is stored', async () => {
    const s = await newSession();
    const quoteSpy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, {
      origin_asset: ETH,
      refund_address: WALLET,
    });
    expect(res.statusCode, res.body).toBe(201);
    const q = res.json();
    expect(q.deposit_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(BigInt(q.amount_in)).toBeGreaterThan(0n);
    expect(q.fee_lines).toEqual([]); // merchant pays fees
    expect(q.small_overpay_notice).toBe(true);
    // dry then real, both refunding to the wallet on the origin chain
    expect(quoteSpy).toHaveBeenCalledTimes(2);
    const [dry, real] = quoteSpy.mock.calls.map((c) => c[0]);
    expect(dry!.dry).toBe(true);
    expect(real!.dry).toBe(false);
    expect(real!.refundTo).toBe(WALLET);
    expect(real!.refundType).toBe('ORIGIN_CHAIN');
    expect(real!.recipient).toBe(accountId);
    expect(real!.recipientType).toBe('INTENTS');
    expect(real!.appFees).toEqual([{ recipient: env().FEE_ACCOUNT_TEST, fee: 50 }]);

    const row = await prisma.quote.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(row.depositAddress).toBe(q.deposit_address);
    expect(row.refundTo).toBe(WALLET);
    expect(row.refundType).toBe('ORIGIN_CHAIN');
    expect(row.amountIn.toFixed()).toBe(q.amount_in);
    expect(row.amountInUsd?.toFixed()).toBe('25');
    expect(row.supersededAt).toBeNull();
    // A screening decision was recorded for the wallet.
    const scr = await prisma.screeningResult.findMany({ where: { sessionId: s.id } });
    expect(scr.map((r) => [r.address, r.decision])).toEqual([[WALLET, 'allow']]);
  });

  it('a manual send without an address refunds to the merchant intents account', async () => {
    const s = await newSession();
    const quoteSpy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(res.statusCode, res.body).toBe(201);
    const real = quoteSpy.mock.calls.at(-1)![0];
    expect(real.refundTo).toBe(accountId);
    expect(real.refundType).toBe('INTENTS');
    const row = await prisma.quote.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(row.refundTo).toBe(accountId);
    expect(row.refundType).toBe('INTENTS');
    expect(await prisma.screeningResult.count()).toBe(0);
  });

  it('a new quote supersedes the previous one', async () => {
    const s = await newSession();
    const first = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(first.statusCode, first.body).toBe(201);
    const second = await call('POST', 'quote', s.client_secret, { origin_asset: USDC });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().deposit_address).not.toBe(first.json().deposit_address);

    const rows = await prisma.quote.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.supersededAt).not.toBeNull();
    expect(rows[1]!.supersededAt).toBeNull();
    const view = (await call('GET', 'session', s.client_secret)).json();
    expect(view.quote.deposit_address).toBe(second.json().deposit_address);
    expect(view.quote.origin_asset).toBe(USDC);
  });

  it('a sanctioned connected wallet gets 403 and 1Click is never called', async () => {
    const s = await newSession();
    const quoteSpy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, {
      origin_asset: ETH,
      refund_address: SANCTIONED,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('WALLET_NOT_ALLOWED');
    expect(quoteSpy).not.toHaveBeenCalled();
    expect(await prisma.quote.count()).toBe(0);
    const scr = await prisma.screeningResult.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(scr.decision).toBe('block');
  });

  it('rejects a refund address in the wrong format for the origin chain', async () => {
    const s = await newSession();
    const quoteSpy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, {
      origin_asset: ETH,
      refund_address: 'alice.near',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(quoteSpy).not.toHaveBeenCalled();
  });

  it('merchant-pays: retries once when the price moved, then gives 409 QUOTE_PRICE_MOVED', async () => {
    const original = sim.quote.bind(sim);
    let movedLeft = 1;
    const spy = vi.spyOn(sim, 'quote').mockImplementation(async (req) => {
      const res = await original(req);
      if (!req.dry && movedLeft > 0) {
        movedLeft--;
        return { ...res, quote: { ...res.quote, amountInUsd: '30' } };
      }
      return res;
    });
    const s = await newSession();
    const ok = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(spy).toHaveBeenCalledTimes(4); // dry, real (moved), dry, real

    movedLeft = 2;
    spy.mockClear();
    const moved = await call('POST', 'quote', s.client_secret, { origin_asset: USDC });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json().error.code).toBe('QUOTE_PRICE_MOVED');
    expect(spy).toHaveBeenCalledTimes(4);
    // The first quote is still the current one.
    const view = (await call('GET', 'session', s.client_secret)).json();
    expect(view.quote.deposit_address).toBe(ok.json().deposit_address);
  });

  it('shopper-pays quotes show the fee line', async () => {
    const s = await newSession({ fee_payer: 'shopper' });
    const res = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(res.statusCode, res.body).toBe(201);
    const q = res.json();
    expect(q.fee_lines).toHaveLength(1);
    expect(q.fee_lines[0].kind).toBe('network_and_service');
    expect(Number(q.fee_lines[0].amount_usd)).toBeGreaterThan(0);
    expect(Number(q.amount_in_usd)).toBeGreaterThan(25);
  });

  it('no quote after the session expired (409 SESSION_EXPIRED)', async () => {
    const s = await newSession();
    await prisma.session.update({
      where: { id: s.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const quoteSpy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SESSION_EXPIRED');
    expect(quoteSpy).not.toHaveBeenCalled();
  });

  it('submits a deposit tx hash for the current quote', async () => {
    const s = await newSession();
    const noQuote = await call('POST', 'deposit', s.client_secret, { tx_hash: '0xabc' });
    expect(noQuote.statusCode, noQuote.body).toBe(409);

    const q = (await call('POST', 'quote', s.client_secret, { origin_asset: ETH })).json();
    const spy = vi.spyOn(sim, 'submitDeposit');
    const res = await call('POST', 'deposit', s.client_secret, { tx_hash: '0xabc123' });
    expect(res.statusCode, res.body).toBe(202);
    expect(spy).toHaveBeenCalledWith('0xabc123', q.deposit_address);
    expect((await sim.status(q.deposit_address)).status).toBe('KNOWN_DEPOSIT_TX');
  });

  it('accepts an email only when one is needed', async () => {
    const s = await newSession();
    const refused = await call('POST', 'email', s.client_secret, { email: 'a@b.example' });
    expect(refused.statusCode, refused.body).toBe(409);

    // An exchange-sender refund waiting for an address, and no email on file.
    const quote = await createRow('Quote', merchant.id, false, { sessionId: s.id });
    const payment = await createRow('Payment', merchant.id, false, {
      sessionId: s.id,
      quoteId: quote.id,
      status: 'REFUNDED',
    });
    await createRow('Refund', merchant.id, false, {
      paymentId: payment.id,
      needsAddress: true,
    });
    const view = (await call('GET', 'session', s.client_secret)).json();
    expect(view.needs_email).toBe(true);
    expect(view.payments[0].state).toBe('refunded');

    const bad = await call('POST', 'email', s.client_secret, { email: 'nope' });
    expect(bad.statusCode).toBe(400);
    const ok = await call('POST', 'email', s.client_secret, { email: 'Shopper@Example.com' });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.customerEmail).toBe('shopper@example.com');
    expect((await call('GET', 'session', s.client_secret)).json().needs_email).toBe(false);
  });

  it('simulates a deposit in test mode', async () => {
    const s = await newSession();
    const q = (await call('POST', 'quote', s.client_secret, { origin_asset: ETH })).json();
    const res = await call('POST', 'simulate', s.client_secret, { scenario: 'underpay' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('INCOMPLETE_DEPOSIT');
    expect((await sim.status(q.deposit_address)).status).toBe('INCOMPLETE_DEPOSIT');
    const again = await call('POST', 'simulate', s.client_secret, { scenario: 'exact' });
    expect(again.statusCode, again.body).toBe(409);
  });

  it('simulate is 404 in live mode', async () => {
    await createRow('MerchantAccount', merchant.id, true, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, true, {
      destAssetId: USDC,
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    const liveKey = (await createApiKey(merchant.id, { livemode: true })).raw;
    const s = await newSession({}, liveKey);
    const spy = vi.spyOn(sim, 'simulate');
    const res = await call('POST', 'simulate', s.client_secret, { scenario: 'exact' });
    expect(res.statusCode, res.body).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("session A's client secret cannot read session B", async () => {
    const a = await newSession();
    const b = await newSession();
    const va = (await call('GET', 'session', a.client_secret)).json();
    expect(va.id).toBe(a.id);
    // B's id with A's secret part: rejected.
    const forged = a.client_secret.replace(a.id, b.id);
    const res = await call('GET', 'session', forged);
    expect(res.statusCode).toBe(401);
    // A quote through A's secret never touches B.
    await call('POST', 'quote', a.client_secret, { origin_asset: ETH });
    expect(await prisma.quote.count({ where: { sessionId: b.id } })).toBe(0);
  });

  it('limits quotes per session per minute (429 RATE_LIMITED)', async () => {
    await app.close();
    app = await buildApp({ rateLimitOverrides: { session_quote: 2 } });
    await app.ready();
    const s = await newSession();
    const other = await newSession();
    for (const asset of [ETH, USDC]) {
      const ok = await call('POST', 'quote', s.client_secret, { origin_asset: asset });
      expect(ok.statusCode, ok.body).toBe(201);
    }
    const spy = vi.spyOn(sim, 'quote');
    const limited = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(spy).not.toHaveBeenCalled();
    // Per session: another session still quotes.
    const fine = await call('POST', 'quote', other.client_secret, { origin_asset: ETH });
    expect(fine.statusCode, fine.body).toBe(201);
  });

  it('caps a session at 30 quotes in its lifetime', async () => {
    const s = await newSession();
    for (let i = 0; i < 30; i++) {
      await createRow('Quote', merchant.id, false, {
        sessionId: s.id,
        supersededAt: new Date(),
      });
    }
    const spy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a new quote while a reported deposit is in flight (409 DEPOSIT_IN_PROGRESS)', async () => {
    const s = await newSession();
    const q = (await call('POST', 'quote', s.client_secret, { origin_asset: ETH })).json();
    expect((await call('POST', 'deposit', s.client_secret, { tx_hash: '0xfeed' })).statusCode).toBe(
      202,
    );
    const row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.depositTxHash).toBe('0xfeed');
    expect(row.depositTxSubmittedAt).not.toBeNull();

    const spy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, { origin_asset: USDC });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('DEPOSIT_IN_PROGRESS');
    expect(spy).not.toHaveBeenCalled();

    // Once the quote's deadline passed, a new quote is allowed (and the deposit report refused).
    await prisma.quote.update({
      where: { id: q.id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    const late = await call('POST', 'deposit', s.client_secret, { tx_hash: '0xbeef' });
    expect(late.statusCode, late.body).toBe(409);
    const again = await call('POST', 'quote', s.client_secret, { origin_asset: USDC });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('refuses a deposit report once the session is closed', async () => {
    const s = await newSession();
    await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    await prisma.session.update({ where: { id: s.id }, data: { status: 'SETTLED' } });
    const res = await call('POST', 'deposit', s.client_secret, { tx_hash: '0xabc' });
    expect(res.statusCode, res.body).toBe(409);
  });

  it('wallet payout mode: DESTINATION_CHAIN recipient pinned on the session', async () => {
    const payout = '0x2222222222222222222222222222222222222222';
    await prisma.settlementConfig.updateMany({
      where: { merchantId: merchant.id, livemode: false },
      data: { payoutMode: 'wallet', payoutAddress: payout },
    });
    const s = await newSession();
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.recipientType).toBe('DESTINATION_CHAIN');
    expect(row.recipient).toBe(payout);
    expect(row.intentsAccount).toBe(accountId);

    const spy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(res.statusCode, res.body).toBe(201);
    const real = spy.mock.calls.at(-1)![0];
    expect(real.recipient).toBe(payout);
    expect(real.recipientType).toBe('DESTINATION_CHAIN');
    // Manual send without a refund address: back to the pinned merchant intents account.
    expect(real.refundTo).toBe(accountId);
    expect(real.refundType).toBe('INTENTS');
  });

  it('uses the account the session pinned; a rotated-out account gives 409 ACCOUNT_NOT_READY', async () => {
    const s = await newSession();
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.recipientType).toBe('INTENTS');
    expect(row.recipient).toBe(accountId);
    // One account per mode: the store's account is now a different NEAR account.
    await prisma.merchantAccount.updateMany({
      where: { nearAccountId: accountId },
      data: { nearAccountId: 'rotated.tendr.testnet' },
    });
    const spy = vi.spyOn(sim, 'quote');
    const res = await call('POST', 'quote', s.client_secret, {
      origin_asset: ETH,
      refund_address: WALLET,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_READY');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses API keys on the shopper routes', async () => {
    const res = await call('GET', 'session', testKey);
    expect(res.statusCode).toBe(403);
  });

  it('allows the checkout origin by CORS on the shopper routes, without credentials', async () => {
    const s = await newSession();
    const origin = new URL(env().CHECKOUT_BASE_URL).origin;
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/checkout/client/quote',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    void s;
  });
});
