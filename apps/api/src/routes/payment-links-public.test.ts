import type { Merchant } from '@prisma/client';
import { SESSION_TTL_MS } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuildAppOptions } from '../app.js';
import { fixedFxProvider, resetFxCache } from '../checkout/fx.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { scopedDb } from '../db/scoped.js';
import { env, loadEnv } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { createLink } from '../payment-links/links.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';

const sim1click = isolatedSimStore();
const ETH = 'nep141:eth.test';
const TOKEN = 't'.repeat(48);
const BASE = '/v1/payment_links/public';

describe('public payment link routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const start = async (o: BuildAppOptions = {}) => {
    await app?.close();
    app = await buildApp(o);
    await app.ready();
  };

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    await resetFxCache();
    resetTokenCache();
    resetOneClickProviders({ simulated: new SimulatedOneClick({ store: sim1click.store() }) });
    loadEnv({ ...process.env, WEB_INTERNAL_TOKEN: TOKEN, FX_FIXED_RATES: '{"NGN":"1600"}' });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await start();
    merchant = await createMerchant({ slug: 'acme', name: 'Acme Church' });
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: 'nep141:usdc.test',
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    const ctx = {
      merchantId: merchant.id,
      livemode: false,
      db: scopedDb({ merchantId: merchant.id, livemode: false }),
    };
    await createLink(ctx, {
      title: 'T-shirt',
      slug: 'tshirt',
      amount_type: 'fixed',
      amount: '25.00',
      currency: 'USD',
      note: 'optional',
    });
    await createLink(ctx, {
      title: 'Offering',
      slug: 'offering',
      amount_type: 'open',
      currency: 'NGN',
      note: 'optional',
    });
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    vi.restoreAllMocks();
    resetTokenCache();
    resetOneClickProviders();
    loadEnv();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  const read = (path: string, headers: Record<string, string> = {}, remoteAddress?: string) =>
    app.inject({
      method: 'GET',
      url: `${BASE}/${path}`,
      headers,
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  const pay = (path: string, payload: Record<string, unknown> = {}, remoteAddress?: string) =>
    app.inject({
      method: 'POST',
      url: `${BASE}/${path}/sessions`,
      payload,
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  const internal = (ip: string, token = TOKEN) => ({
    'x-tendr-internal': token,
    'x-tendr-client-ip': ip,
  });

  it('reads a test link with mode=test, no-store; without it the link is unknown', async () => {
    const res = await read('acme/tshirt?mode=test');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ title: 'T-shirt', amount: '25.00', livemode: false });

    const live = await read('acme/tshirt');
    const unknown = await read('nobody/tshirt');
    expect(live.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(live.json().error.message).toBe(unknown.json().error.message);
    expect(live.headers['cache-control']).toBe('no-store');
  });

  it('public view without a rate', async () => {
    vi.spyOn(fixedFxProvider(), 'rate').mockRejectedValue(new Error('provider down'));
    const res = await read('acme/offering?mode=test');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().usd_rate).toBeNull();
  });

  it('creates a session: 201 with the hosted url, no-store', async () => {
    const res = await pay('acme/offering', { amount: '3200', note: 'hi' });
    // Live mode is the default and this merchant has no live link.
    expect(res.statusCode).toBe(404);
    const ok = await app.inject({
      method: 'POST',
      url: `${BASE}/acme/offering/sessions?mode=test`,
      payload: { amount: '3200', note: 'hi' },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json().url).toMatch(/\/pay\/ses_[0-9A-Z]{26}#cs=ses_/);
  });

  it('the payer page origin may call the session route (CORS, no credentials)', async () => {
    const origin = new URL(env().CHECKOUT_BASE_URL).origin;
    const res = await app.inject({
      method: 'OPTIONS',
      url: `${BASE}/acme/tshirt/sessions?mode=test`,
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  describe('link sessions and quotes', () => {
    async function linkSession() {
      const res = await app.inject({
        method: 'POST',
        url: `${BASE}/acme/tshirt/sessions?mode=test`,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(201);
      const secret = (res.json().url as string).split('#cs=')[1]!;
      const id = secret.split('_secret_')[0]!;
      return { id, secret };
    }
    const quote = (secret: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/checkout/client/quote',
        headers: { authorization: `Bearer ${secret}` },
        payload: { origin_asset: ETH },
      });

    it('first quote extends expiry to createdAt + SESSION_TTL_MS, second quote does not change it', async () => {
      const s = await linkSession();
      const before = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
      expect(before.expiresAt.getTime() - before.createdAt.getTime()).toBeLessThanOrEqual(
        5 * 60_000 + 1000,
      );
      const q1 = await quote(s.secret);
      expect(q1.statusCode, q1.body).toBe(201);
      const after = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
      expect(after.expiresAt.getTime()).toBe(before.createdAt.getTime() + SESSION_TTL_MS);
      // The first quote's deadline is not cut to the 5-minute window.
      const q1Row = await prisma.quote.findUniqueOrThrow({ where: { id: q1.json().id } });
      expect(q1Row.deadline.getTime()).toBeGreaterThan(before.expiresAt.getTime());

      // Move the expiry so a second extension would show.
      const moved = new Date(after.expiresAt.getTime() - 60_000);
      await prisma.session.update({ where: { id: s.id }, data: { expiresAt: moved } });
      const q2 = await quote(s.secret);
      expect(q2.statusCode, q2.body).toBe(201);
      const final = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
      expect(final.expiresAt.getTime()).toBe(moved.getTime());
    });

    it('a store-path link session with expires_in 60 keeps its expiry after a quote', async () => {
      const key = (await createApiKey(merchant.id, { livemode: false })).raw;
      const link = await prisma.paymentLink.findFirstOrThrow({ where: { slug: 'tshirt' } });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/checkout/sessions',
        headers: { authorization: `Bearer ${key}` },
        payload: {
          amount: '25.00',
          amount_currency: 'USD',
          external_ref: 'order-60',
          success_url: 'https://shop.example/thanks',
          cancel_url: 'https://shop.example/cart',
          payment_link_id: link.id,
          expires_in: 60,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const { id, client_secret } = res.json() as { id: string; client_secret: string };
      const before = await prisma.session.findUniqueOrThrow({ where: { id } });
      const q = await quote(client_secret);
      expect(q.statusCode, q.body).toBe(201);
      const after = await prisma.session.findUniqueOrThrow({ where: { id } });
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      // Its quote is bounded by the store's 60-second expiry, not an extended one.
      const qRow = await prisma.quote.findUniqueOrThrow({ where: { id: q.json().id } });
      expect(qRow.deadline.getTime()).toBeLessThanOrEqual(before.expiresAt.getTime());
    });

    it('the shopper view names the link and its page', async () => {
      const s = await linkSession();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/checkout/client/session',
        headers: { authorization: `Bearer ${s.secret}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().payment_link).toEqual({
        title: 'T-shirt',
        url: 'http://localhost:3000/pay/acme/tshirt?mode=test',
      });
      expect(res.json().success_url).toBe('http://localhost:3000/pay/acme/tshirt?mode=test');
    });

    it('a store-path session naming a link keeps the store as its way back', async () => {
      const key = (await createApiKey(merchant.id, { livemode: false })).raw;
      const link = await prisma.paymentLink.findFirstOrThrow({ where: { slug: 'tshirt' } });
      const created = await app.inject({
        method: 'POST',
        url: '/v1/checkout/sessions',
        headers: { authorization: `Bearer ${key}` },
        payload: {
          amount: '25.00',
          amount_currency: 'USD',
          external_ref: 'order-61',
          success_url: 'https://shop.example/thanks',
          cancel_url: 'https://shop.example/cart',
          payment_link_id: link.id,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/checkout/client/session',
        headers: { authorization: `Bearer ${created.json().client_secret}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      // The header and result screens fall back to the store's own URLs.
      expect(res.json().payment_link).toBeNull();
      expect(res.json().success_url).toBe('https://shop.example/thanks');
      expect(res.json().cancel_url).toBe('https://shop.example/cart');
    });
  });

  describe('limits', () => {
    it('public read limited per payer IP via internal header', async () => {
      // ip_global would stop an untrusted caller at 3000; the web server is exempt from it.
      await start({ rateLimitOverrides: { ip_global: 5 } });
      for (let i = 0; i < 120; i++) {
        const r = await read('acme/tshirt?mode=test', internal('203.0.113.7'));
        expect(r.statusCode, `read ${i}`).toBe(200);
      }
      const limited = await read('acme/tshirt?mode=test', internal('203.0.113.7'));
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      expect((await read('acme/tshirt?mode=test', internal('203.0.113.8'))).statusCode).toBe(200);
    });

    it('client ip header ignored without a valid token', async () => {
      await start({ rateLimitOverrides: { payment_link_read: 2 } });
      // A wrong token and no token: both keyed on req.ip, whatever the header says.
      expect(
        (await read('acme/tshirt?mode=test', internal('198.51.100.1', 'x'.repeat(48)))).statusCode,
      ).toBe(200);
      expect(
        (await read('acme/tshirt?mode=test', { 'x-tendr-client-ip': '198.51.100.2' })).statusCode,
      ).toBe(200);
      const third = await read('acme/tshirt?mode=test', internal('198.51.100.3', 'x'.repeat(48)));
      expect(third.statusCode).toBe(429);
    });

    it('invalid client ip header falls back to req.ip', async () => {
      await start({ rateLimitOverrides: { payment_link_read: 1 } });
      expect(
        (await read('acme/tshirt?mode=test', internal('nonsense'), '10.1.1.1')).statusCode,
      ).toBe(200);
      expect(
        (await read('acme/tshirt?mode=test', internal('also bad'), '10.1.1.1')).statusCode,
      ).toBe(429);
      expect((await read('acme/tshirt?mode=test', internal('bad'), '10.1.1.2')).statusCode).toBe(
        200,
      );
    });

    it('untrusted public reads still count toward ip_global', async () => {
      await start({ rateLimitOverrides: { ip_global: 2 } });
      expect((await read('acme/tshirt?mode=test')).statusCode).toBe(200);
      expect((await read('acme/tshirt?mode=test')).statusCode).toBe(200);
      expect((await read('acme/tshirt?mode=test')).statusCode).toBe(429);
    });

    it('the read global ceiling counts trusted reads too', async () => {
      await start({ rateLimitOverrides: { payment_link_read_global: 2 } });
      expect((await read('acme/tshirt?mode=test', internal('203.0.113.1'))).statusCode).toBe(200);
      expect((await read('acme/tshirt?mode=test', internal('203.0.113.2'))).statusCode).toBe(200);
      expect((await read('acme/tshirt?mode=test', internal('203.0.113.3'))).statusCode).toBe(429);
    });

    it('session create limited per IP and per IP per link', async () => {
      const post = (link: string, ip: string) =>
        app.inject({
          method: 'POST',
          url: `${BASE}/acme/${link}/sessions?mode=test`,
          payload: {},
          remoteAddress: ip,
        });
      // 3 per (IP, link) per 5 minutes.
      for (let i = 0; i < 3; i++) expect((await post('nope-a', '10.2.0.1')).statusCode).toBe(404);
      expect((await post('nope-a', '10.2.0.1')).statusCode).toBe(429);
      // Another IP has its own bucket for that link.
      expect((await post('nope-a', '10.2.0.2')).statusCode).toBe(404);
      // 10 a minute per IP across links (the 429 above counted toward it too).
      for (const link of ['nope-b', 'nope-b', 'nope-b', 'nope-c', 'nope-c', 'nope-c']) {
        expect((await post(link, '10.2.0.1')).statusCode).toBe(404);
      }
      expect((await post('nope-d', '10.2.0.1')).statusCode).toBe(429);
    });
  });
});
