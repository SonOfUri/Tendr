import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { sha256 } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import {
  createApiKey,
  createMerchant,
  createRow,
  createUser,
  resetDb,
  setLiveMode,
} from '../test/helpers.js';

describe('dashboard API keys', () => {
  let app: FastifyInstance;
  let merchantId: string;
  let userId: string;
  let login: Login;
  let logs: ReturnType<typeof vi.spyOn>;
  const originalLiveMode = process.env.LIVE_MODE_ENABLED;
  const input = { name: 'Store server', scopes: ['sessions:read', 'payments:read'] };
  const headers = (livemode = false) => dashHeaders(login, { merchantId, livemode });
  const create = (livemode = false, payload: object = input) =>
    app.inject({
      method: 'POST',
      url: '/v1/api_keys',
      headers: headers(livemode),
      payload,
    });

  beforeEach(async () => {
    await resetDb();
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    merchantId = (await createMerchant()).id;
    userId = (await createUser({ emailVerifiedAt: new Date() })).id;
    await createRow('MerchantUser', merchantId, false, { userId, role: 'owner' });
    login = await loginAs(userId);
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    logs.mockRestore();
    setLiveMode(originalLiveMode === undefined ? undefined : originalLiveMode === 'true');
  });
  afterAll(() => prisma.$disconnect());

  it('issues a usable scoped secret once, storing only its hash and safe audit metadata', async () => {
    const response = await create(false, {
      ...input,
      name: ' Store server ',
      scopes: ['payments:read', 'payments:read'],
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const { api_key: key, secret } = response.json();
    expect(secret).toMatch(/^tdr_test_[a-f0-9]{48}$/);
    expect(key).toMatchObject({
      name: 'Store server',
      kind: 'secret',
      livemode: false,
      scopes: ['payments:read'],
      revoked_at: null,
    });
    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(stored.keyHash).toBe(sha256(secret));
    expect(stored.connectionId).toBeNull();
    const listing = await app.inject({ method: 'GET', url: '/v1/api_keys', headers: headers() });
    expect(listing.json()).toEqual({ api_keys: [key] });
    expect(listing.body).not.toContain(secret);
    expect(listing.body).not.toContain(stored.keyHash);
    const audit = await prisma.event.findMany({ where: { aggregateId: key.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: 'api_key.created', payload: { user_id: userId } });
    expect(JSON.stringify([stored, audit, logs.mock.calls])).not.toContain(secret);
    expect(await prisma.eventOutbox.count({ where: { eventId: audit[0]!.id } })).toBe(1);
    const bearer = { authorization: `Bearer ${secret}` };
    const ping = await app.inject({ method: 'GET', url: '/v1/ping', headers: bearer });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toMatchObject({ merchantId, livemode: false });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/checkout/sessions/ses_missing',
          headers: bearer,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('isolates stores and modes, and immediately revokes authentication without duplicate events', async () => {
    setLiveMode(true);
    const test = (await create()).json();
    const live = (await create(true)).json();
    expect(live.secret).toMatch(/^tdr_live_/);
    const other = await createMerchant();
    const foreign = await createApiKey(other.id, { livemode: false });
    const list = await app.inject({ method: 'GET', url: '/v1/api_keys', headers: headers() });
    expect(list.json().api_keys.map((k: { id: string }) => k.id)).toEqual([test.api_key.id]);
    for (const id of [live.api_key.id, foreign.record.id]) {
      expect(
        (await app.inject({ method: 'DELETE', url: `/v1/api_keys/${id}`, headers: headers() }))
          .statusCode,
      ).toBe(404);
    }
    for (let i = 0; i < 2; i++) {
      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/api_keys/${test.api_key.id}`,
        headers: headers(),
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().api_key.revoked_at).toBeTruthy();
      expect(removed.body).not.toContain(test.secret);
    }
    expect(
      await prisma.event.count({
        where: { aggregateId: test.api_key.id, type: 'api_key.revoked' },
      }),
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/ping',
          headers: { authorization: `Bearer ${test.secret}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/ping',
          headers: { authorization: `Bearer ${live.secret}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await prisma.apiKey.findUniqueOrThrow({ where: { id: foreign.record.id } })).revokedAt,
    ).toBeNull();
  });

  it('requires an owner/admin session, valid CSRF and fresh passkey for mutations', async () => {
    const key = (await create()).json();
    const stale = await loginAs(userId, { stepUp: false });
    const staleHeaders = dashHeaders(stale, { merchantId });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/api_keys', headers: staleHeaders })).statusCode,
    ).toBe(200);
    for (const request of [
      { method: 'POST' as const, url: '/v1/api_keys', payload: input },
      { method: 'DELETE' as const, url: `/v1/api_keys/${key.api_key.id}` },
    ]) {
      const response = await app.inject({ ...request, headers: staleHeaders });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('STEP_UP_REQUIRED');
      expect(
        (await app.inject({ ...request, headers: dashHeaders(login, { merchantId, csrf: null }) }))
          .statusCode,
      ).toBe(403);
    }
    for (const role of ['viewer', 'finance'] as const) {
      await prisma.merchantUser.updateMany({ where: { merchantId, userId }, data: { role } });
      expect((await create()).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/api_keys', headers: headers() })).statusCode,
      ).toBe(403);
    }
    await prisma.merchantUser.updateMany({
      where: { merchantId, userId },
      data: { role: 'admin' },
    });
    expect((await create()).statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/api_keys',
          headers: { authorization: `Bearer ${key.secret}` },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/api_keys' })).statusCode).toBe(401);
  });

  it('keeps connected-site credentials under Connect management', async () => {
    const connection = await prisma.connection.create({
      data: {
        id: 'con_test',
        merchantId,
        siteUrl: 'https://shop.example',
        siteOrigin: 'https://shop.example',
        platform: 'woocommerce',
        connectedByUserId: userId,
      },
    });
    const key = await createApiKey(merchantId, { livemode: false });
    await prisma.apiKey.update({
      where: { id: key.record.id },
      data: { connectionId: connection.id },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/api_keys', headers: headers() })).json(),
    ).toEqual({ api_keys: [] });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/api_keys/${key.record.id}`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await prisma.apiKey.findUniqueOrThrow({ where: { id: key.record.id } })).revokedAt,
    ).toBeNull();
  });

  it('rejects invalid inputs, live writes while disabled and response caching of raw keys', async () => {
    for (const payload of [
      { ...input, name: ' ' },
      { ...input, scopes: [] },
      { ...input, scopes: ['admin'] },
      { ...input, merchantId: 'mer_other' },
      { ...input, livemode: true },
      { ...input, kind: 'publishable' },
    ])
      expect((await create(false, payload)).statusCode).toBe(400);
    setLiveMode(false);
    expect((await create(true)).json().error.code).toBe('LIVE_MODE_UNAVAILABLE');
    const cached = await app.inject({
      method: 'POST',
      url: '/v1/api_keys',
      headers: { ...headers(), 'Idempotency-Key': 'must-not-cache' },
      payload: input,
    });
    expect(cached.statusCode).toBe(400);
    expect(await prisma.idempotencyKey.count()).toBe(0);
    expect(await prisma.apiKey.count()).toBe(0);
  });
});
