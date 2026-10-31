import type { Merchant } from '@prisma/client';
import { CONNECTION_KEY_SCOPES, DEFAULT_GAS_POLICY, type MerchantUserRole } from '@tendr/contracts';
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

describe('gas policy routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant();
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const secretKey = async (livemode = false) => (await createApiKey(merchant.id, { livemode })).raw;

  async function connectionKey(livemode = false) {
    const conn = await createRow('Connection', merchant.id, livemode, {});
    const { raw, record } = await createApiKey(merchant.id, {
      livemode,
      scopes: [...CONNECTION_KEY_SCOPES],
    });
    await prisma.apiKey.update({ where: { id: record.id }, data: { connectionId: conn.id } });
    return raw;
  }

  async function member(role: MerchantUserRole, stepUp = true) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: user.id, role });
    return loginAs(user.id, { stepUp });
  }

  const byKey = (method: 'GET' | 'PUT', url: string, raw: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${raw}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  it('a secret key reads the defaults, then replaces the policy', async () => {
    const raw = await secretKey();
    const before = await byKey('GET', '/v1/gas-policy', raw);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({
      livemode: false,
      ...DEFAULT_GAS_POLICY,
      enabled: false,
      updated_at: null,
    });

    const put = await byKey('PUT', '/v1/gas-policy', raw, {
      enabled: true,
      per_payment_cap_usd: '0.5',
      monthly_budget_usd: '20',
      min_order_usd: '10',
      chains: ['base', 'eth'],
      tokens: ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'],
      first_time_only: true,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({
      livemode: false,
      enabled: true,
      per_payment_cap_usd: '0.5',
      monthly_budget_usd: '20',
      min_order_usd: '10',
      chains: ['base', 'eth'],
      first_time_only: true,
    });
    expect((await byKey('GET', '/v1/gas-policy', raw)).json()).toEqual(put.json());
  });

  it('PUT refuses an invalid policy with 400', async () => {
    const raw = await secretKey();
    for (const body of [
      { per_payment_cap_usd: '-1' },
      { chains: ['doge'] },
      { per_payment_cap_usd: '51' },
      { unknown_field: true },
    ]) {
      const res = await byKey('PUT', '/v1/gas-policy', raw, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('a connection key reads the policy and usage but cannot change the policy', async () => {
    const raw = await connectionKey();
    expect((await byKey('GET', '/v1/gas-policy', raw)).statusCode).toBe(200);
    expect((await byKey('GET', '/v1/gas-policy/usage', raw)).statusCode).toBe(200);
    const put = await byKey('PUT', '/v1/gas-policy', raw, { enabled: true });
    expect(put.statusCode, put.body).toBe(403);
    expect(await prisma.gasPolicy.count()).toBe(0);
  });

  it('PUT needs the sessions:write scope of a secret key; reads do not', async () => {
    const { raw } = await createApiKey(merchant.id, {
      livemode: false,
      scopes: ['sessions:read', 'payments:read'],
    });
    expect((await byKey('GET', '/v1/gas-policy', raw)).statusCode).toBe(200);
    const put = await byKey('PUT', '/v1/gas-policy', raw, { enabled: true });
    expect(put.statusCode, put.body).toBe(403);
    expect(await prisma.gasPolicy.count()).toBe(0);
  });

  it('a connection key lists the gas sponsorships', async () => {
    const raw = await connectionKey();
    const res = await byKey('GET', '/v1/gas-sponsorships', raw);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ gas_sponsorships: [] });
  });

  it('a publishable key is refused', async () => {
    const { raw } = await createApiKey(merchant.id, { livemode: false, kind: 'publishable' });
    for (const [method, url] of [
      ['GET', '/v1/gas-policy'],
      ['PUT', '/v1/gas-policy'],
      ['GET', '/v1/gas-policy/usage'],
      ['GET', '/v1/gas-sponsorships'],
    ] as const) {
      const res = await byKey(method, url, raw, method === 'PUT' ? { enabled: true } : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('a test key never sees or changes the live policy', async () => {
    const live = await secretKey(true);
    const test = await secretKey(false);
    await byKey('PUT', '/v1/gas-policy', live, { enabled: true, monthly_budget_usd: '99' });
    const seen = (await byKey('GET', '/v1/gas-policy', test)).json();
    expect(seen).toMatchObject({ livemode: false, enabled: false, monthly_budget_usd: '50' });
    await byKey('PUT', '/v1/gas-policy', test, { monthly_budget_usd: '5' });
    expect((await byKey('GET', '/v1/gas-policy', live)).json()).toMatchObject({
      livemode: true,
      enabled: true,
      monthly_budget_usd: '99',
    });
  });

  it('usage for an empty month is all zeros; month must be YYYY-MM', async () => {
    const raw = await secretKey();
    const res = await byKey('GET', '/v1/gas-policy/usage?month=2026-09', raw);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      month: '2026-09',
      reserved_usd: '0',
      spent_usd: '0',
      remaining_usd: '50',
      count: 0,
    });
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect((await byKey('GET', '/v1/gas-policy/usage', raw)).json()).toMatchObject({
      month: current,
    });
    expect((await byKey('GET', '/v1/gas-policy/usage?month=2026-9', raw)).statusCode).toBe(400);
  });

  it('usage is per mode', async () => {
    await createRow('GasBudgetMonth', merchant.id, true, {
      month: '2026-10',
      spentUsd: '4',
      count: 2,
    });
    const test = await byKey('GET', '/v1/gas-policy/usage?month=2026-10', await secretKey(false));
    expect(test.json()).toMatchObject({ spent_usd: '0', count: 0 });
    const live = await byKey('GET', '/v1/gas-policy/usage?month=2026-10', await secretKey(true));
    expect(live.json()).toMatchObject({ spent_usd: '4', count: 2, remaining_usd: '46' });
  });

  it('dashboard: any member reads; settings:manage with step-up changes', async () => {
    const viewer = await member('viewer');
    const admin = await member('admin');
    const lapsed = await member('admin', false);
    const headers = (who: Awaited<ReturnType<typeof member>>) =>
      dashHeaders(who, { merchantId: merchant.id, livemode: false });

    const get = await app.inject({
      method: 'GET',
      url: '/v1/gas-policy',
      headers: headers(viewer),
    });
    expect(get.statusCode, get.body).toBe(200);
    const usage = await app.inject({
      method: 'GET',
      url: '/v1/gas-policy/usage',
      headers: headers(viewer),
    });
    expect(usage.statusCode, usage.body).toBe(200);

    const put = (who: Awaited<ReturnType<typeof member>>) =>
      app.inject({
        method: 'PUT',
        url: '/v1/gas-policy',
        headers: headers(who),
        payload: { enabled: true },
      });
    expect((await put(viewer)).statusCode).toBe(403);
    expect((await put(lapsed)).statusCode).toBe(401);
    const ok = await put(admin);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ enabled: true });
  });
});

describe('gas sponsorships list', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let raw: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant();
    raw = (await createApiKey(merchant.id, { livemode: false })).raw;
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const list = (query = '', key = raw) =>
    app.inject({
      method: 'GET',
      url: `/v1/gas-sponsorships${query}`,
      headers: { authorization: `Bearer ${key}` },
    });

  it('lists newest first with the record fields, per mode', async () => {
    const a = await createRow('GasSponsorship', merchant.id, false, {
      createdAt: new Date('2026-10-01T00:00:00Z'),
      feeMode: 'token',
      feeAsset: 'nep141:usdc.test',
      feeAmount: '80000',
      estimateUsd: '0.08',
      reservationState: 'reserved',
    });
    const b = await createRow('GasSponsorship', merchant.id, false, {
      createdAt: new Date('2026-10-02T00:00:00Z'),
      status: 'confirmed',
    });
    await createRow('GasSponsorship', merchant.id, true, {});

    const res = await list();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.gas_sponsorships.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect(body.gas_sponsorships[1]).toMatchObject({
      id: a.id,
      livemode: false,
      session_id: a.sessionId,
      chain: 'base',
      method: 'paymaster_verifying',
      provider: 'pimlico',
      sponsor: 'merchant',
      status: 'pending',
      fee_mode: 'token',
      fee_asset: 'nep141:usdc.test',
      fee_amount: '80000',
      estimate_usd: '0.08',
      cost_usd: null,
      reservation_state: 'reserved',
      created_at: '2026-10-01T00:00:00.000Z',
    });
  });

  it('filters by session, payment, status and month, and pages with a cursor', async () => {
    const s1 = await createRow('Session', merchant.id, false, {});
    const pay = await createRow('Payment', merchant.id, false, {});
    const one = await createRow('GasSponsorship', merchant.id, false, {
      sessionId: s1.id,
      createdAt: new Date('2026-09-15T00:00:00Z'),
    });
    const two = await createRow('GasSponsorship', merchant.id, false, {
      sessionId: pay.sessionId as string,
      status: 'confirmed',
      createdAt: new Date('2026-10-15T00:00:00Z'),
    });
    const ids = async (q: string) => {
      const r = await list(q);
      expect(r.statusCode, r.body).toBe(200);
      return r.json().gas_sponsorships.map((s: { id: string }) => s.id);
    };
    expect(await ids(`?session=${s1.id}`)).toEqual([one.id]);
    expect(await ids(`?payment=${pay.id}`)).toEqual([two.id]);
    expect(await ids('?status=confirmed')).toEqual([two.id]);
    expect(await ids('?month=2026-09')).toEqual([one.id]);
    expect(await ids('?month=2026-11')).toEqual([]);

    const first = (await list('?limit=1')).json();
    expect(first.gas_sponsorships.map((s: { id: string }) => s.id)).toEqual([two.id]);
    expect(first.has_more).toBe(true);
    const next = (await list(`?limit=1&starting_after=${first.next_cursor}`)).json();
    expect(next.gas_sponsorships.map((s: { id: string }) => s.id)).toEqual([one.id]);
    expect(next.has_more).toBe(false);

    expect((await list('?status=bogus')).statusCode).toBe(400);
  });

  it('a payment of the other mode filters to nothing', async () => {
    const pay = await createRow('Payment', merchant.id, true, {});
    await createRow('GasSponsorship', merchant.id, false, {});
    expect((await list(`?payment=${pay.id}`)).json().gas_sponsorships).toEqual([]);
  });
});
