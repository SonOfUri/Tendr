import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { dashHeaders, loginAs } from '../test/dashboard.js';
import {
  createApiKey,
  createMerchant,
  createRow,
  createUser,
  resetDb,
  setLiveMode,
} from '../test/helpers.js';

// Live writes here assume live mode is open (LIVE_MODE_ENABLED); the switch-off behaviour is
// tested in gateway/live-mode.test.ts.
beforeAll(() => setLiveMode(true));
afterAll(() => setLiveMode(undefined));

describe('payment link routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ slug: 'acme' });
    for (const livemode of [false, true]) {
      await createRow('MerchantAccount', merchant.id, livemode, { status: 'active' });
      await createRow('SettlementConfig', merchant.id, livemode, {
        destAssetId: 'nep141:usdc.test',
        destChain: 'near',
        payoutMode: 'intents',
        payoutAddress: null,
        isDefault: true,
      });
    }
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const input = { title: 'Tithe', amount_type: 'open', currency: 'USD' };
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    key: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}`, ...extra },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function member(role: 'viewer' | 'finance') {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: user.id, role });
    return loginAs(user.id);
  }

  it('create, get, list, patch and archive round trip', async () => {
    const created = await call('POST', '/v1/payment_links', testKey, input);
    expect(created.statusCode, created.body).toBe(201);
    const link = created.json();
    expect(link).toMatchObject({ object: 'payment_link', slug: 'tithe', livemode: false });

    const got = await call('GET', `/v1/payment_links/${link.id}`, testKey);
    expect(got.json().id).toBe(link.id);

    const list = await call('GET', '/v1/payment_links?limit=10', testKey);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.map((l: { id: string }) => l.id)).toEqual([link.id]);

    const patched = await call('PATCH', `/v1/payment_links/${link.id}`, testKey, {
      title: 'Offering',
      max_uses: 5,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ title: 'Offering', max_uses: 5, slug: 'tithe' });
    const cleared = await call('PATCH', `/v1/payment_links/${link.id}`, testKey, {
      max_uses: null,
    });
    expect(cleared.json().max_uses).toBeNull();

    const del = await call('DELETE', `/v1/payment_links/${link.id}`, testKey);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toMatchObject({ id: link.id, archived: true, availability: 'archived' });
    expect((await call('GET', '/v1/payment_links', testKey)).json().data).toEqual([]);
    const all = await call('GET', '/v1/payment_links?include_archived=true', testKey);
    expect(all.json().data).toHaveLength(1);
  });

  it('read-only key cannot write', async () => {
    const ro = (
      await createApiKey(merchant.id, { livemode: false, scopes: ['payment_links:read'] })
    ).raw;
    expect((await call('GET', '/v1/payment_links', ro)).statusCode).toBe(200);
    const options = await call('GET', '/v1/payment_links/settlement-options', ro);
    expect(options.statusCode).toBe(200);
    expect(options.json()).toMatchObject({ livemode: false });
    expect(options.json().tokens.some((t: { chain: string }) => t.chain === 'base')).toBe(true);
    expect((await call('POST', '/v1/payment_links', ro, input)).statusCode).toBe(403);
    const noScope = (
      await createApiKey(merchant.id, { livemode: false, scopes: ['sessions:read'] })
    ).raw;
    expect((await call('GET', '/v1/payment_links', noScope)).statusCode).toBe(403);
    expect((await call('GET', '/v1/payment_links/settlement-options', noScope)).statusCode).toBe(
      403,
    );
  });

  it('viewer cannot create, finance can', async () => {
    const h = (who: Awaited<ReturnType<typeof member>>) =>
      dashHeaders(who, { merchantId: merchant.id, livemode: false });
    const viewer = await member('viewer');
    const finance = await member('finance');
    const post = (who: Awaited<ReturnType<typeof member>>) =>
      app.inject({ method: 'POST', url: '/v1/payment_links', headers: h(who), payload: input });
    expect((await post(viewer)).statusCode).toBe(403);
    const ok = await post(finance);
    expect(ok.statusCode, ok.body).toBe(201);
    const read = await app.inject({ method: 'GET', url: '/v1/payment_links', headers: h(viewer) });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().data).toHaveLength(1);
  });

  it('Idempotency-Key replays the same link', async () => {
    const a = await call('POST', '/v1/payment_links', testKey, input, { 'idempotency-key': 'k1' });
    const b = await call('POST', '/v1/payment_links', testKey, input, { 'idempotency-key': 'k1' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    expect(await prisma.paymentLink.count()).toBe(1);
  });

  it('test key cannot see live links', async () => {
    const liveKey = (await createApiKey(merchant.id, { livemode: true })).raw;
    const live = await call('POST', '/v1/payment_links', liveKey, input);
    expect(live.statusCode, live.body).toBe(201);
    expect((await call('GET', '/v1/payment_links', testKey)).json().data).toEqual([]);
    expect((await call('GET', `/v1/payment_links/${live.json().id}`, testKey)).statusCode).toBe(
      404,
    );
  });

  it('unknown field rejected (400)', async () => {
    const r = await call('POST', '/v1/payment_links', testKey, { ...input, bogus: 1 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH with slug is 400; past expires_at is 400; future sets and null clears', async () => {
    const link = (await call('POST', '/v1/payment_links', testKey, input)).json();
    const s = await call('PATCH', `/v1/payment_links/${link.id}`, testKey, { slug: 'other' });
    expect(s.statusCode, s.body).toBe(400);
    const past = await call('PATCH', `/v1/payment_links/${link.id}`, testKey, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.statusCode, past.body).toBe(400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const set = await call('PATCH', `/v1/payment_links/${link.id}`, testKey, {
      expires_at: future,
    });
    expect(set.json().expires_at).toBe(future);
    const none = await call('PATCH', `/v1/payment_links/${link.id}`, testKey, {
      expires_at: null,
    });
    expect(none.json().expires_at).toBeNull();
  });
});
