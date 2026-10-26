import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { fixedFxProvider, resetFxCache } from '../checkout/fx.js';
import { simulatedOneClick } from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { env, loadEnv } from '../env.js';
import { sha256 } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';

const SECRET_RE = /^(ses_[0-9A-HJKMNP-TV-Z]{26})_secret_[0-9a-f]{32}$/;

describe('checkout session routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let accountId: string;

  beforeEach(async () => {
    await resetDb();
    resetTokenCache();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ defaultFeePayer: 'merchant', defaultGasPayer: 'buyer' });
    const account = await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    accountId = account.nearAccountId as string;
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: 'nep141:usdc.test',
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
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const body = (over: Record<string, unknown> = {}) => ({
    amount: '25.10',
    amount_currency: 'USD',
    external_ref: 'order-1001',
    success_url: 'https://shop.example/thanks',
    cancel_url: 'https://shop.example/cart',
    ...over,
  });

  function create(payload: unknown, key = testKey, idem?: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: {
        authorization: `Bearer ${key}`,
        ...(idem ? { 'idempotency-key': idem } : {}),
      },
      payload: payload as Record<string, unknown>,
    });
  }

  function get(id: string, key = testKey) {
    return app.inject({
      method: 'GET',
      url: `/v1/checkout/sessions/${id}`,
      headers: { authorization: `Bearer ${key}` },
    });
  }

  function expire(id: string, key = testKey) {
    return app.inject({
      method: 'POST',
      url: `/v1/checkout/sessions/${id}/expire`,
      headers: { authorization: `Bearer ${key}` },
    });
  }

  it('creates a session with resolved payers, a hashed client secret and the hosted url', async () => {
    const before = Date.now();
    const res = await create(
      body({
        customer_email: 'Shopper@Example.COM',
        metadata: { cart: 'c-9' },
        fee_payer: 'shopper',
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json();
    expect(Object.keys(out).sort()).toEqual(['client_secret', 'expires_at', 'id', 'status', 'url']);
    expect(out.status).toBe('PENDING_DEPOSIT');
    const m = SECRET_RE.exec(out.client_secret);
    expect(m?.[1]).toBe(out.id);
    expect(out.url).toBe(`${env().CHECKOUT_BASE_URL}/pay/${out.id}#cs=${out.client_secret}`);
    expect(out.url.endsWith(`#cs=${out.client_secret}`)).toBe(true);
    const exp = new Date(out.expires_at).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: out.id } });
    expect(row.clientSecretHash).toBe(sha256(out.client_secret));
    expect(row.merchantId).toBe(merchant.id);
    expect(row.livemode).toBe(false);
    expect(row.feePayer).toBe('payer'); // session override, stored value
    expect(row.gasSponsor).toBe('buyer'); // merchant default
    expect(row.feeBps).toBe(50); // no fee plan
    expect(row.amount.toFixed()).toBe('25.1');
    expect(row.amountCurrency).toBe('USD');
    expect(row.amountMode).toBe('EXACT_OUT');
    expect(row.destAsset).toBe('nep141:usdc.test');
    expect(row.destChain).toBe('near');
    expect(row.recipient).toBe(accountId);
    expect(row.customerEmail).toBe('shopper@example.com');
    expect(row.metadata).toEqual({ cart: 'c-9' });
    expect(row.successUrl).toBe('https://shop.example/thanks');
    expect(row.cancelUrl).toBe('https://shop.example/cart');
    expect(row.externalRef).toBe('order-1001');
  });

  it('resolves payers from the payment link, then the merchant; reads the fee plan', async () => {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { defaultFeePayer: 'payer', defaultGasPayer: 'buyer' },
    });
    await createRow('FeePlan', merchant.id, false, { feeBps: 0 });
    const link = await createRow('PaymentLink', merchant.id, false, {
      gasSponsor: 'merchant',
      gasMaxUsd: '1.25',
    });
    const res = await create(body({ payment_link_id: link.id }));
    expect(res.statusCode, res.body).toBe(201);
    const row = await prisma.session.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(row.feePayer).toBe('payer'); // merchant default
    expect(row.gasSponsor).toBe('merchant'); // link setting
    expect(row.gasMaxUsd?.toFixed()).toBe('1.25');
    expect(row.paymentLinkId).toBe(link.id);
    expect(row.feeBps).toBe(0);

    // The session override beats the link.
    const res2 = await create(
      body({ payment_link_id: link.id, external_ref: 'order-2', gas_payer: 'shopper' }),
    );
    expect(res2.statusCode, res2.body).toBe(201);
    const row2 = await prisma.session.findUniqueOrThrow({ where: { id: res2.json().id } });
    expect(row2.gasSponsor).toBe('buyer');
  });

  it('rejects a payment link of another mode', async () => {
    const liveLink = await createRow('PaymentLink', merchant.id, true, {});
    const res = await create(body({ payment_link_id: liveLink.id }));
    expect(res.statusCode, res.body).toBe(404);
  });

  it('honours expires_in within 60–1800 s', async () => {
    const res = await create(body({ expires_in: 60 }));
    expect(res.statusCode, res.body).toBe(201);
    const exp = new Date(res.json().expires_at).getTime();
    expect(exp).toBeLessThanOrEqual(Date.now() + 61_000);
    for (const bad of [59, 1801, 1.5]) {
      const r = await create(body({ expires_in: bad, external_ref: `x-${bad}` }));
      expect(r.statusCode, String(bad)).toBe(400);
    }
  });

  describe('amount and currency', () => {
    it.each(['XYZ', 'ngn', 'EURO'])('rejects %j with UNSUPPORTED_CURRENCY', async (code) => {
      const res = await create(body({ amount_currency: code }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('UNSUPPORTED_CURRENCY');
    });

    it('rejects an asset that is not the settlement asset', async () => {
      const res = await create(body({ amount_currency: 'nep141:eth.test', amount: '1' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('UNSUPPORTED_CURRENCY');
    });

    it.each(['25.101', '0', '0.00', '-5', '1e3', '', ' 5', '5.', 'abc'])(
      'rejects USD amount %j',
      async (amount) => {
        const res = await create(body({ amount }));
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      },
    );

    it('rejects a numeric (non-string) amount', async () => {
      const res = await create(body({ amount: 25 }));
      expect(res.statusCode).toBe(400);
    });

    it('reads asset decimals from a cached token list', async () => {
      const spy = vi.spyOn(simulatedOneClick(), 'tokens');
      for (const ref of ['a-1', 'a-2']) {
        const r = await create(
          body({ amount_currency: 'nep141:usdc.test', amount: '1.5', external_ref: ref }),
        );
        expect(r.statusCode, r.body).toBe(201);
      }
      expect(spy).toHaveBeenCalledTimes(1);
      // USD orders never ask the provider.
      expect((await create(body({ external_ref: 'a-3' }))).statusCode).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a provider outage is 503 PROVIDER_UNAVAILABLE, and is not cached', async () => {
      const spy = vi
        .spyOn(simulatedOneClick(), 'tokens')
        .mockRejectedValueOnce(new Error('1Click down'));
      const r = await create(body({ amount_currency: 'nep141:usdc.test', amount: '1.5' }));
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('PROVIDER_UNAVAILABLE');
      const again = await create(body({ amount_currency: 'nep141:usdc.test', amount: '1.5' }));
      expect(again.statusCode, again.body).toBe(201);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a settlement asset the provider does not list is 400 UNSUPPORTED_ASSET', async () => {
      await prisma.settlementConfig.updateMany({
        where: { merchantId: merchant.id },
        data: { destAssetId: 'nep141:unknown.test' },
      });
      const r = await create(body({ amount_currency: 'nep141:unknown.test', amount: '1' }));
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('UNSUPPORTED_ASSET');
      expect(r.json().error.message).toContain('nep141:unknown.test');
    });

    it('accepts the settlement asset with up to its decimals', async () => {
      const ok = await create(body({ amount_currency: 'nep141:usdc.test', amount: '25.123456' }));
      expect(ok.statusCode, ok.body).toBe(201);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: ok.json().id } });
      expect(row.amountCurrency).toBe('nep141:usdc.test');
      expect(row.amount.toFixed()).toBe('25.123456');
      const bad = await create(
        body({ amount_currency: 'nep141:usdc.test', amount: '25.1234567', external_ref: 'o2' }),
      );
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('non-USD amounts (FX)', () => {
    const NOW_RATE = { rate: '1602.04', source: 'fixed (test rates)' };

    beforeEach(async () => {
      await resetFxCache();
    });
    afterEach(() => {
      loadEnv();
    });

    it('converts NGN 78500.00 at 1 USD = 1602.04 NGN to USD 49.01 and stores the conversion', async () => {
      const before = Date.now();
      const res = await create(body({ amount: '78500.00', amount_currency: 'NGN' }));
      expect(res.statusCode, res.body).toBe(201);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row.amount.toFixed()).toBe('49.01');
      expect(row.amountCurrency).toBe('USD');
      expect(row.originalAmount?.toFixed()).toBe('78500');
      expect(row.originalCurrency).toBe('NGN');
      expect(row.fxRate?.toFixed()).toBe('1602.04');
      expect(row.fxSource).toBe('fixed (test rates)');
      expect(row.fxAsOf!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('stored fields round-trip on GET', async () => {
      const id = (await create(body({ amount: '78500.00', amount_currency: 'NGN' }))).json().id;
      const row = await prisma.session.findUniqueOrThrow({ where: { id } });
      const view = (await get(id)).json();
      expect(view.amount).toBe('49.01');
      expect(view.amount_currency).toBe('USD');
      expect(view.original_amount).toBe('78500.00');
      expect(view.original_currency).toBe('NGN');
      expect(view.fx).toEqual({
        rate: '1602.04',
        source: 'fixed (test rates)',
        as_of: row.fxAsOf!.toISOString(),
      });
      // 0-dp and 3-dp currencies print with their own minor units.
      const jpy = (
        await create(body({ amount: '1000', amount_currency: 'JPY', external_ref: 'j-1' }))
      ).json().id;
      const jv = (await get(jpy)).json();
      expect(jv.original_amount).toBe('1000');
      expect(jv.amount).toBe('6.61');
      const kwd = (
        await create(body({ amount: '1.2', amount_currency: 'KWD', external_ref: 'k-1' }))
      ).json().id;
      expect((await get(kwd)).json().original_amount).toBe('1.200');
    });

    it('USD session unchanged and fx null', async () => {
      const id = (await create(body())).json().id;
      const row = await prisma.session.findUniqueOrThrow({ where: { id } });
      expect(row.originalAmount).toBeNull();
      expect(row.originalCurrency).toBeNull();
      expect(row.fxRate).toBeNull();
      expect(row.fxSource).toBeNull();
      expect(row.fxAsOf).toBeNull();
      const view = (await get(id)).json();
      expect(view.amount).toBe('25.1');
      expect(view.amount_currency).toBe('USD');
      expect(view.original_amount).toBeNull();
      expect(view.original_currency).toBeNull();
      expect(view.fx).toBeNull();
      // The settlement-asset path is unchanged too, and never asks for a rate.
      const spy = vi.spyOn(fixedFxProvider(), 'rate');
      const asset = await create(
        body({ amount_currency: 'nep141:usdc.test', amount: '1.5', external_ref: 'a-1' }),
      );
      expect(asset.statusCode, asset.body).toBe(201);
      expect((await get(asset.json().id)).json().fx).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('KWD 1.234 (3 dp) accepted; KWD 1.2345 rejected before any rate is fetched', async () => {
      const ok = await create(body({ amount: '1.234', amount_currency: 'KWD' }));
      expect(ok.statusCode, ok.body).toBe(201);
      const spy = vi.spyOn(fixedFxProvider(), 'rate');
      const bad = await create(
        body({ amount: '1.2345', amount_currency: 'KWD', external_ref: 'k-2' }),
      );
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('VALIDATION_ERROR');
      const jpy = await create(
        body({ amount: '1000.5', amount_currency: 'JPY', external_ref: 'j-2' }),
      );
      expect(jpy.statusCode).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });

    it('rate 11 min old → 503 FX_RATE_UNAVAILABLE, and no session', async () => {
      vi.spyOn(fixedFxProvider(), 'rate').mockResolvedValue({
        ...NOW_RATE,
        asOf: new Date(Date.now() - 11 * 60_000),
      });
      const res = await create(body({ amount: '78500.00', amount_currency: 'NGN' }));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('FX_RATE_UNAVAILABLE');
      expect(await prisma.session.count()).toBe(0);
    });

    it('provider error → 503 FX_RATE_UNAVAILABLE', async () => {
      vi.spyOn(fixedFxProvider(), 'rate').mockRejectedValue(new Error('provider down'));
      const res = await create(body({ amount: '78500.00', amount_currency: 'NGN' }));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('FX_RATE_UNAVAILABLE');
      expect(res.body).not.toContain('provider down');
    });

    it('cache hit within 60 s does not call the provider', async () => {
      const spy = vi.spyOn(fixedFxProvider(), 'rate');
      for (const ref of ['c-1', 'c-2', 'c-3']) {
        const r = await create(body({ amount: '100', amount_currency: 'NGN', external_ref: ref }));
        expect(r.statusCode, r.body).toBe(201);
      }
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('test mode always uses the fixed provider, whatever FX_PROVIDER says', async () => {
      loadEnv({ ...process.env, FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'k' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const res = await create(body({ amount: '78500.00', amount_currency: 'NGN' }));
      expect(res.statusCode, res.body).toBe(201);
      expect((await get(res.json().id)).json().fx.source).toBe('fixed (test rates)');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('test-mode NGN with no FX_FIXED_RATES converts at the built-in test rate', async () => {
      loadEnv({ ...process.env, FX_FIXED_RATES: '' });
      const res = await create(body({ amount: '78500.00', amount_currency: 'NGN' }));
      expect(res.statusCode, res.body).toBe(201);
      const view = (await get(res.json().id)).json();
      // 78500 / 1600 = 49.0625, rounded up.
      expect(view.fx).toMatchObject({ rate: '1600', source: 'fixed (test rates)' });
      expect(view.amount).toBe('49.07');
    });

    it('a live key with FX_FIXED_RATES set and no FX_API_KEY is 503, never fixed rates', async () => {
      loadEnv({ ...process.env, FX_PROVIDER: 'fixed', FX_API_KEY: undefined });
      await createRow('MerchantAccount', merchant.id, true, { status: 'active' });
      await createRow('SettlementConfig', merchant.id, true, {
        destAssetId: 'nep141:usdc.test',
        destChain: 'near',
        payoutMode: 'intents',
        payoutAddress: null,
        isDefault: true,
      });
      const liveKey = (await createApiKey(merchant.id, { livemode: true })).raw;
      const res = await create(body({ amount: '78500.00', amount_currency: 'NGN' }), liveKey);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error.code).toBe('FX_RATE_UNAVAILABLE');
    });

    it('the converted USD amount must pass the amount checks', async () => {
      // 20 integer digits of KWD at 1 USD = 0.307 KWD is a 21-digit USD amount: too large.
      const res = await create(
        body({ amount: '99999999999999999999.999', amount_currency: 'KWD' }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.json().error.message).toMatch(/too large/);
      // The smallest JPY amount still converts to a positive USD amount (one cent, rounded up).
      const tiny = await create(body({ amount: '1', amount_currency: 'JPY', external_ref: 't' }));
      expect(tiny.statusCode, tiny.body).toBe(201);
      expect((await get(tiny.json().id)).json().amount).toBe('0.01');
    });

    it('an Idempotency-Key replay returns the stored conversion without a new rate', async () => {
      const spy = vi.spyOn(fixedFxProvider(), 'rate');
      const payload = body({ amount: '78500.00', amount_currency: 'NGN' });
      const first = await create(payload, testKey, 'fx-idem');
      expect(first.statusCode, first.body).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
      // Drop the rate cache and move the rate: a replay must not fetch or re-convert.
      await resetFxCache();
      spy.mockResolvedValue({ rate: '9999', source: 'fixed', asOf: new Date() });
      const replay = await create(payload, testKey, 'fx-idem');
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      expect(spy).toHaveBeenCalledTimes(1);
      const view = (await get(first.json().id)).json();
      expect(view.amount).toBe('49.01');
      expect(view.fx.rate).toBe('1602.04');
      expect(await prisma.session.count()).toBe(1);
    });
  });

  describe('external_ref', () => {
    it('replays with the same Idempotency-Key and conflicts with a different one', async () => {
      const first = await create(body(), testKey, 'idem-1');
      expect(first.statusCode, first.body).toBe(201);
      const replay = await create(body(), testKey, 'idem-1');
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      const other = await create(body(), testKey, 'idem-2');
      expect(other.statusCode).toBe(409);
      expect(other.json().error.code).toBe('CONFLICT');
      expect(other.json().error.details).toEqual({ external_ref: 'order-1001' });
      const noKey = await create(body());
      expect(noKey.statusCode).toBe(409);
      expect(await prisma.session.count()).toBe(1);
    });

    it('allows a new session after the first expires; a settled one still conflicts', async () => {
      const first = await create(body());
      expect(first.statusCode).toBe(201);
      expect((await expire(first.json().id)).statusCode).toBe(200);
      const second = await create(body());
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().id).not.toBe(first.json().id);

      await prisma.session.update({
        where: { id: second.json().id },
        data: { status: 'SETTLED' },
      });
      const third = await create(body());
      expect(third.statusCode).toBe(409);
      expect(third.json().error.code).toBe('CONFLICT');
    });

    it('two concurrent creates with the same ref: exactly one 201 and one 409', async () => {
      const results = await Promise.all([
        create(body(), testKey, 'race-a'),
        create(body(), testKey, 'race-b'),
      ]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes, results.map((r) => r.body).join('\n')).toEqual([201, 409]);
      const loser = results.find((r) => r.statusCode === 409)!;
      expect(loser.json().error.code).toBe('CONFLICT');
      expect(loser.json().error.details).toEqual({ external_ref: 'order-1001' });
      expect(await prisma.session.count({ where: { externalRef: 'order-1001' } })).toBe(1);
    });

    it('expires an unswept PENDING_DEPOSIT session past its expiry, then creates', async () => {
      const first = (await create(body())).json().id;
      await prisma.session.update({
        where: { id: first },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const second = await create(body());
      expect(second.statusCode, second.body).toBe(201);
      const old = await prisma.session.findUniqueOrThrow({ where: { id: first } });
      expect(old.status).toBe('EXPIRED');
      expect(old.expiredReason).toBe('timeout');
      const ev = await prisma.event.findFirst({
        where: { aggregateId: first, type: 'checkout.session.expired' },
      });
      expect(ev?.payload).toMatchObject({
        session_id: first,
        external_ref: 'order-1001',
        reason: 'timeout',
      });
      // A live (unexpired) one still conflicts.
      expect((await create(body())).statusCode).toBe(409);
    });

    describe('I-1: a deposit in flight holds the ref', () => {
      async function expiredWith(o: { polledAfter?: boolean; reported?: boolean }) {
        const first = (await create(body())).json().id as string;
        const expiresAt = new Date(Date.now() - 1000);
        await prisma.session.update({ where: { id: first }, data: { expiresAt } });
        const quote = await createRow('Quote', merchant.id, false, {
          sessionId: first,
          deadline: new Date(Date.now() + 60_000),
          watchPolledAt: o.polledAfter ? new Date() : new Date(expiresAt.getTime() - 60_000),
          depositTxSubmittedAt: o.reported ? new Date(expiresAt.getTime() - 30_000) : null,
        });
        return { first, quote };
      }

      it('refuses (409 deposit_in_progress) while a reported deposit is inside its deadline', async () => {
        const { first } = await expiredWith({ polledAfter: true, reported: true });
        const res = await create(body());
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toMatchObject({
          code: 'CONFLICT',
          details: { reason: 'deposit_in_progress', session_id: first },
        });
        const old = await prisma.session.findUniqueOrThrow({ where: { id: first } });
        expect(old.status).toBe('PENDING_DEPOSIT');
      });

      it('refuses while a payment is in flight', async () => {
        const { first, quote } = await expiredWith({ polledAfter: true });
        await createRow('Payment', merchant.id, false, {
          sessionId: first,
          quoteId: quote.id,
          status: 'PROCESSING',
        });
        const res = await create(body());
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error.details).toMatchObject({ reason: 'deposit_in_progress' });
      });

      it('refuses while a watched address was not polled after the expiry', async () => {
        await expiredWith({ polledAfter: false });
        const res = await create(body());
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error.details).toMatchObject({ reason: 'deposit_in_progress' });
      });

      it('expires and creates once nothing is in flight', async () => {
        const { first } = await expiredWith({ polledAfter: true });
        const res = await create(body());
        expect(res.statusCode, res.body).toBe(201);
        const old = await prisma.session.findUniqueOrThrow({ where: { id: first } });
        expect(old.status).toBe('EXPIRED');
      });
    });

    it('is scoped per mode', async () => {
      await createRow('MerchantAccount', merchant.id, true, { status: 'active' });
      await createRow('SettlementConfig', merchant.id, true, {
        payoutMode: 'intents',
        payoutAddress: null,
      });
      const liveKey = (await createApiKey(merchant.id, { livemode: true })).raw;
      expect((await create(body())).statusCode).toBe(201);
      const live = await create(body(), liveKey);
      expect(live.statusCode, live.body).toBe(201);
    });
  });

  describe('readiness', () => {
    it('refuses with ACCOUNT_NOT_READY without an active merchant account', async () => {
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id },
        data: { status: 'provisioning' },
      });
      const res = await create(body());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ACCOUNT_NOT_READY');
      await prisma.merchantAccount.deleteMany({ where: { merchantId: merchant.id } });
      const res2 = await create(body());
      expect(res2.statusCode).toBe(409);
      expect(res2.json().error.code).toBe('ACCOUNT_NOT_READY');
    });

    it('refuses with ACCOUNT_NOT_READY without a settlement config', async () => {
      await prisma.settlementConfig.deleteMany({ where: { merchantId: merchant.id } });
      const res = await create(body());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ACCOUNT_NOT_READY');
    });

    it('uses the saved payout address as recipient in wallet mode', async () => {
      await prisma.settlementConfig.updateMany({
        where: { merchantId: merchant.id },
        data: { payoutMode: 'wallet', payoutAddress: 'shop-payouts.testnet' },
      });
      const res = await create(body());
      expect(res.statusCode, res.body).toBe(201);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row.recipient).toBe('shop-payouts.testnet');
    });
  });

  describe('auth', () => {
    it('a publishable key cannot create a session', async () => {
      const pk = (await createApiKey(merchant.id, { livemode: false, kind: 'publishable' })).raw;
      const res = await create(body(), pk);
      expect(res.statusCode).toBe(403);
      expect(await prisma.session.count()).toBe(0);
    });

    it('needs sessions:write to create and expire, sessions:read to read', async () => {
      const readOnly = (
        await createApiKey(merchant.id, { livemode: false, scopes: ['sessions:read'] })
      ).raw;
      expect((await create(body(), readOnly)).statusCode).toBe(403);
      const created = await create(body());
      const id = created.json().id;
      expect((await get(id, readOnly)).statusCode).toBe(200);
      expect((await expire(id, readOnly)).statusCode).toBe(403);
      const writeOnly = (
        await createApiKey(merchant.id, { livemode: false, scopes: ['sessions:write'] })
      ).raw;
      expect((await get(id, writeOnly)).statusCode).toBe(403);
    });

    it('a session client secret cannot call the store API', async () => {
      const created = await create(body());
      const { id, client_secret } = created.json();
      expect((await get(id, client_secret)).statusCode).toBe(403);
      expect((await expire(id, client_secret)).statusCode).toBe(403);
    });

    it('isolates test and live mode', async () => {
      const created = await create(body());
      const id = created.json().id;
      const liveKey = (await createApiKey(merchant.id, { livemode: true })).raw;
      expect((await get(id, liveKey)).statusCode).toBe(404);
      expect((await expire(id, liveKey)).statusCode).toBe(404);
      // A live key without a live account is not ready, whatever the test setup.
      const live = await create(body(), liveKey);
      expect(live.statusCode).toBe(409);
      expect(live.json().error.code).toBe('ACCOUNT_NOT_READY');
      // Another merchant cannot see it either.
      const other = await createMerchant();
      const otherKey = (await createApiKey(other.id, { livemode: false })).raw;
      expect((await get(id, otherKey)).statusCode).toBe(404);
    });
  });

  describe('GET', () => {
    it('returns the full view with payments, refunds and totals', async () => {
      const created = await create(body({ metadata: { a: '1' } }));
      const id = created.json().id;
      const quote = await createRow('Quote', merchant.id, false, { sessionId: id });
      const pay = await prisma.payment.create({
        data: {
          id: 'pay_01JABCDEFGHJKMNPQRSTVWXYZ0',
          merchantId: merchant.id,
          livemode: false,
          sessionId: id,
          quoteId: quote.id,
          amountReceived: '1000000',
          amountOut: '25100000',
          status: 'SETTLED',
        },
      });
      await createRow('Refund', merchant.id, false, {
        paymentId: pay.id,
        amount: '400',
        status: 'confirmed',
      });
      const res = await get(id);
      expect(res.statusCode, res.body).toBe(200);
      const v = res.json();
      expect(v).toMatchObject({
        id,
        status: 'PENDING_DEPOSIT',
        livemode: false,
        amount: '25.1',
        amount_currency: 'USD',
        external_ref: 'order-1001',
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
        metadata: { a: '1' },
        fee_payer: 'merchant',
        gas_payer: 'shopper',
        fee_bps: 50,
        settlement_asset: 'nep141:usdc.test',
        expired_reason: null,
        url: `${env().CHECKOUT_BASE_URL}/pay/${id}`,
      });
      expect(v.client_secret).toBeUndefined();
      expect(JSON.stringify(v)).not.toContain('secret_');
      expect(v.payments).toHaveLength(1);
      expect(v.payments[0]).toMatchObject({
        id: pay.id,
        status: 'SETTLED',
        amount_out: '25100000',
      });
      expect(v.payments[0].refunds).toHaveLength(1);
      expect(v.payments[0].refunds[0]).toMatchObject({ amount: '400', status: 'confirmed' });
      expect(v.totals).toEqual({
        settled_amount_out: '25100000',
        payment_count: 1,
        refund_count: 1,
      });
    });

    it('404s an unknown id', async () => {
      expect((await get('ses_01JABCDEFGHJKMNPQRSTVWXYZ0')).statusCode).toBe(404);
    });
  });

  describe('expire', () => {
    it('cancels a PENDING_DEPOSIT session and emits checkout.session.expired', async () => {
      const id = (await create(body())).json().id;
      const res = await expire(id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ id, status: 'EXPIRED', expired_reason: 'canceled' });
      const row = await prisma.session.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('EXPIRED');
      expect(row.expiredReason).toBe('canceled');
      const events = await prisma.event.findMany({
        where: { aggregateId: id },
        orderBy: { createdAt: 'asc' },
      });
      const expired = events.find((e) => e.type === 'checkout.session.expired');
      expect(expired?.payload).toMatchObject({
        session_id: id,
        external_ref: 'order-1001',
        reason: 'canceled',
      });
      expect(events.some((e) => e.type === 'session.status_changed')).toBe(true);
    });

    it('I-1: refuses (409 deposit_in_progress) while a reported deposit is inside its deadline', async () => {
      const id = (await create(body())).json().id as string;
      await createRow('Quote', merchant.id, false, {
        sessionId: id,
        deadline: new Date(Date.now() + 60_000),
        depositTxSubmittedAt: new Date(),
      });
      const res = await expire(id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'DEPOSIT_IN_PROGRESS',
        details: { reason: 'deposit_in_progress', session_id: id },
      });
      const row = await prisma.session.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('PENDING_DEPOSIT');
    });

    it('I-1: refuses while a payment is in flight', async () => {
      const id = (await create(body())).json().id as string;
      const quote = await createRow('Quote', merchant.id, false, { sessionId: id });
      await createRow('Payment', merchant.id, false, {
        sessionId: id,
        quoteId: quote.id,
        status: 'DETECTED',
      });
      const res = await expire(id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.details).toMatchObject({ reason: 'deposit_in_progress' });
    });

    it('refuses from any other status', async () => {
      const id = (await create(body())).json().id;
      expect((await expire(id)).statusCode).toBe(200);
      const again = await expire(id);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('INVALID_STATE_TRANSITION');

      const id2 = (await create(body({ external_ref: 'o-2' }))).json().id;
      await prisma.session.update({ where: { id: id2 }, data: { status: 'PROCESSING' } });
      const r = await expire(id2);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  it('rejects unknown fields and bad urls', async () => {
    expect((await create(body({ dest_asset: 'x' }))).statusCode).toBe(400);
    expect((await create(body({ success_url: 'javascript:alert(1)' }))).statusCode).toBe(400);
    expect((await create(body({ cancel_url: 'not a url' }))).statusCode).toBe(400);
    expect((await create(body({ customer_email: 'nope' }))).statusCode).toBe(400);
    const { external_ref: _omit, ...noRef } = body();
    expect((await create(noRef)).statusCode).toBe(400);
  });
});
