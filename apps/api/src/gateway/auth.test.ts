import { randomBytes } from 'node:crypto';
import type { Merchant } from '@prisma/client';
import { ALL_SCOPES } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { sha256 } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createApiKey, createMerchant, minimalSession, resetDb } from '../test/helpers.js';
import { flushLastUsed, routeAuth } from './auth.js';
import { principalRef, requirePrincipal } from './principal.js';

/** Throwaway routes exercising principal kinds and scopes. */
function testRoutes(app: FastifyInstance) {
  app.get(
    '/v1/test/secret-only',
    { config: { auth: { principals: ['secret_key'] } } },
    async (req) => ({ ref: principalRef(requirePrincipal(req)) }),
  );
  app.get(
    '/v1/test/sessions-write',
    { config: { auth: { principals: ['secret_key'], scope: 'sessions:write' } } },
    async () => ({ ok: true }),
  );
  app.post(
    '/v1/test/echo',
    { config: { auth: { principals: ['secret_key'] } } },
    async (req) => ({ body: req.body }),
  );
  app.get(
    '/v1/test/pk-sessions-write',
    { config: { auth: { principals: ['publishable_key'], scope: 'sessions:write' } } },
    async () => ({ ok: true }),
  );
  app.get(
    '/v1/test/session-client',
    { config: { auth: { principals: ['session_client'] } } },
    async (req) => {
      const p = requirePrincipal(req);
      // The scoped client sees only the principal's merchant + mode.
      const visible = await req.db!.session.findMany({ select: { id: true } });
      return { kind: p.kind, ref: principalRef(p), merchantId: p.merchantId, visible };
    },
  );
}

const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

/** A session row plus its raw client secret. */
async function createSessionWithSecret(merchantId: string, livemode: boolean) {
  const id = newId('ses');
  const raw = `${id}_secret_${randomBytes(16).toString('hex')}`;
  const row = await prisma.session.create({
    data: minimalSession({ id, merchantId, livemode, clientSecretHash: sha256(raw) }),
  });
  return { raw, row };
}

describe('gateway auth', () => {
  let app: FastifyInstance;
  let m: Merchant;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    m = await createMerchant();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp({ extraRoutes: testRoutes });
    await app.ready();
  });

  afterEach(async () => {
    await flushLastUsed();
    await app.close();
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const get = (url: string, raw?: string) =>
    app.inject({ url, headers: raw === undefined ? {} : bearer(raw) });

  it('ping returns principal for secret test key', async () => {
    const { raw } = await createApiKey(m.id, { livemode: false });
    const res = await get('/v1/ping', raw);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      merchantId: m.id,
      livemode: false,
      principal: 'secret_key',
      scopes: ALL_SCOPES,
    });
  });

  it('ping accepts a live secret key and a publishable key', async () => {
    const live = await createApiKey(m.id, { livemode: true });
    expect((await get('/v1/ping', live.raw)).json()).toMatchObject({ livemode: true });

    const pk = await createApiKey(m.id, { livemode: false, kind: 'publishable' });
    const res = await get('/v1/ping', pk.raw);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ merchantId: m.id, livemode: false, principal: 'publishable_key' });
  });

  it('401 on missing, malformed, unknown, revoked key', async () => {
    const { raw, record } = await createApiKey(m.id, { livemode: false });
    await prisma.apiKey.update({ where: { id: record.id }, data: { revokedAt: new Date() } });

    for (const res of [
      await get('/v1/ping'),
      await app.inject({ url: '/v1/ping', headers: { authorization: raw } }),
      await get('/v1/ping', `tdr_test_${randomBytes(24).toString('hex')}`),
      await get('/v1/ping', 'not-a-tendr-credential'),
      await get('/v1/ping', raw),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatchObject({ code: 'UNAUTHORIZED', requestId: expect.any(String) });
    }
  });

  it('accepts the auth scheme case-insensitively', async () => {
    const { raw } = await createApiKey(m.id, { livemode: false });
    for (const scheme of ['bearer', 'BEARER']) {
      const res = await app.inject({ url: '/v1/ping', headers: { authorization: `${scheme} ${raw}` } });
      expect(res.statusCode).toBe(200);
    }
  });

  it('refuses unauthenticated callers before parsing the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');

    const { raw } = await createApiKey(m.id, { livemode: false });
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { ...bearer(raw), 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(ok.json()).toEqual({ body: { a: 1 } });
  });

  it('401 when prefix mode disagrees with stored mode', async () => {
    const { record } = await createApiKey(m.id, { livemode: false });
    // A tdr_live_ credential whose stored row says livemode=false.
    const raw = `tdr_live_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.update({ where: { id: record.id }, data: { keyHash: sha256(raw) } });
    expect((await get('/v1/ping', raw)).statusCode).toBe(401);
  });

  it('401 when prefix kind disagrees with stored kind', async () => {
    const { record } = await createApiKey(m.id, { livemode: false, kind: 'publishable' });
    const raw = `tdr_test_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.update({ where: { id: record.id }, data: { keyHash: sha256(raw) } });
    expect((await get('/v1/ping', raw)).statusCode).toBe(401);
  });

  it('403 publishable key on secret-only route', async () => {
    const { raw } = await createApiKey(m.id, { livemode: false, kind: 'publishable' });
    const res = await get('/v1/test/secret-only', raw);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('403 missing scope', async () => {
    const narrow = await createApiKey(m.id, { livemode: false, scopes: ['payments:read'] });
    const res = await get('/v1/test/sessions-write', narrow.raw);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');

    const full = await createApiKey(m.id, { livemode: false });
    expect((await get('/v1/test/sessions-write', full.raw)).statusCode).toBe(200);
  });

  it('403 publishable key missing scope', async () => {
    const narrow = await createApiKey(m.id, {
      livemode: false,
      kind: 'publishable',
      scopes: ['payments:read'],
    });
    const res = await get('/v1/test/pk-sessions-write', narrow.raw);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');

    const full = await createApiKey(m.id, { livemode: false, kind: 'publishable' });
    expect((await get('/v1/test/pk-sessions-write', full.raw)).statusCode).toBe(200);
  });

  it('session client secret reads only its own session principal', async () => {
    const own = await createSessionWithSecret(m.id, false);
    await createSessionWithSecret(m.id, true); // same merchant, other mode
    const other = await createMerchant();
    await createSessionWithSecret(other.id, false);

    const res = await get('/v1/test/session-client', own.raw);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'session_client',
      ref: own.row.id,
      merchantId: m.id,
      visible: [{ id: own.row.id }],
    });

    // A session client cannot use key-only routes.
    expect((await get('/v1/ping', own.raw)).statusCode).toBe(403);
  });

  it('401 on wrong, malformed or unknown session client secret', async () => {
    const { row } = await createSessionWithSecret(m.id, false);
    const wrong = `${row.id}_secret_${randomBytes(16).toString('hex')}`;
    const unknown = `${newId('ses')}_secret_${randomBytes(16).toString('hex')}`;
    for (const raw of [wrong, unknown, `${row.id}_secret_xyz`]) {
      expect((await get('/v1/test/session-client', raw)).statusCode).toBe(401);
    }
  });

  it('expired sessions still authenticate their client secret', async () => {
    const own = await createSessionWithSecret(m.id, false);
    await prisma.session.update({
      where: { id: own.row.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect((await get('/v1/test/session-client', own.raw)).statusCode).toBe(200);
  });

  it('records last_used_at at most once per minute', async () => {
    const { raw, record } = await createApiKey(m.id, { livemode: false });
    await get('/v1/ping', raw);
    await vi.waitFor(async () => {
      const k = await prisma.apiKey.findUniqueOrThrow({ where: { id: record.id } });
      expect(k.lastUsedAt).not.toBeNull();
    });
    const first = (await prisma.apiKey.findUniqueOrThrow({ where: { id: record.id } })).lastUsedAt;

    await get('/v1/ping', raw);
    await new Promise((r) => setTimeout(r, 100));
    const second = (await prisma.apiKey.findUniqueOrThrow({ where: { id: record.id } })).lastUsedAt;
    expect(second).toEqual(first);

    const stale = new Date(Date.now() - 120_000);
    await prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: stale } });
    await get('/v1/ping', raw);
    await vi.waitFor(async () => {
      const k = await prisma.apiKey.findUniqueOrThrow({ where: { id: record.id } });
      expect(k.lastUsedAt!.getTime()).toBeGreaterThan(stale.getTime());
    });
  });

  it('logs authenticated requests without the credential', async () => {
    const { raw } = await createApiKey(m.id, { livemode: false });
    const res = await get('/v1/ping', raw);
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.some((l: string) => l.includes(raw))).toBe(false);
    const entry = lines.map((l: string) => JSON.parse(l)).find((l) => l.merchantId === m.id);
    expect(entry).toMatchObject({
      requestId: res.headers['x-request-id'],
      merchantId: m.id,
      livemode: false,
      principal: 'secret_key',
    });
  });

  it('logs forbidden attempts without the credential', async () => {
    const { raw } = await createApiKey(m.id, { livemode: false, kind: 'publishable' });
    const res = await get('/v1/test/secret-only', raw);
    expect(res.statusCode).toBe(403);
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.some((l: string) => l.includes(raw))).toBe(false);
    const entry = lines.map((l: string) => JSON.parse(l)).find((l) => l.merchantId === m.id);
    expect(entry).toMatchObject({
      requestId: res.headers['x-request-id'],
      livemode: false,
      principal: 'publishable_key',
      outcome: 'forbidden',
    });
  });

  it('health stays public; unknown routes are 404', async () => {
    expect((await get('/v1/health')).statusCode).toBe(200);
    expect((await get('/v1/nope')).statusCode).toBe(404);
  });
});

describe('route auth config', () => {
  it('route without auth config fails at startup', async () => {
    const a = await buildApp({ extraRoutes: (f) => f.get('/v1/naked', async () => ({})) });
    await expect(a.ready()).rejects.toThrow(/auth config/);
    await a.close();
  });

  it('the bare /v1 url counts as a /v1 route', async () => {
    const a = await buildApp({
      extraRoutes: (f) =>
        void f.register(async (s) => void s.get('', async () => ({})), { prefix: '/v1' }),
    });
    await expect(a.ready()).rejects.toThrow(/auth config: GET \/v1\b/);
    await a.close();
  });

  it('per-request check fails closed for /v1 routes without auth config', () => {
    expect(() => routeAuth('/v1', undefined)).toThrow(/route missing auth config/);
    expect(() => routeAuth('/v1/x', undefined)).toThrow(/route missing auth config/);
    expect(routeAuth('/other', undefined)).toBeNull();
    expect(routeAuth(undefined, undefined)).toBeNull(); // unmatched (404) requests
    expect(routeAuth('/v1/x', 'public')).toBe('public');
  });
});
