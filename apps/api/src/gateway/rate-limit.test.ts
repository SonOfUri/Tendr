import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuildAppOptions } from '../app.js';
import { createApiKey, createMerchant, resetDb } from '../test/helpers.js';

const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

function routes(app: FastifyInstance) {
  app.get('/v1/test/public', { config: { auth: 'public' } }, async () => ({ ok: true }));
  app.post(
    '/v1/test/echo',
    { config: { auth: { principals: ['secret_key'] } } },
    async (req) => ({ body: req.body }),
  );
}

describe('gateway rate limits', () => {
  let app: FastifyInstance;
  let merchantId: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    merchantId = (await createMerchant()).id;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  const start = async (o: BuildAppOptions = {}) => {
    app = await buildApp({ extraRoutes: routes, ...o });
    await app.ready();
    return app;
  };

  it('429 after the per-key limit, separate counters per key', async () => {
    await start({ rateLimitOverrides: { secret_key: 3 } });
    const a = await createApiKey(merchantId, { livemode: false });
    const b = await createApiKey(merchantId, { livemode: false });
    const get = (raw: string) => app.inject({ url: '/v1/ping', headers: bearer(raw) });

    for (let i = 0; i < 3; i++) expect((await get(a.raw)).statusCode).toBe(200);
    const res = await get(a.raw);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(res.headers['ratelimit-limit']).toBe('3');
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // a different key has its own counter
    expect((await get(b.raw)).statusCode).toBe(200);
  });

  it('sends RateLimit headers on allowed requests', async () => {
    await start({ rateLimitOverrides: { secret_key: 5 } });
    const k = await createApiKey(merchantId, { livemode: false });
    const res = await app.inject({ url: '/v1/ping', headers: bearer(k.raw) });
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
  });

  it('publishable key: one IP hitting the limit does not block another IP', async () => {
    await start({ rateLimitOverrides: { publishable_key: 2 } });
    const k = await createApiKey(merchantId, { livemode: false, kind: 'publishable' });
    const get = (ip: string) =>
      app.inject({ url: '/v1/ping', headers: { ...bearer(k.raw), 'x-forwarded-for': ip } });

    expect((await get('1.1.1.1')).statusCode).toBe(200);
    expect((await get('1.1.1.1')).statusCode).toBe(200);
    expect((await get('1.1.1.1')).statusCode).toBe(429);
    expect((await get('2.2.2.2')).statusCode).toBe(200);
  });

  it('public routes are limited per IP', async () => {
    await start({ rateLimitOverrides: { public: 2 } });
    const get = (ip: string) =>
      app.inject({ url: '/v1/test/public', headers: { 'x-forwarded-for': ip } });
    expect((await get('1.1.1.1')).statusCode).toBe(200);
    expect((await get('1.1.1.1')).statusCode).toBe(200);
    expect((await get('1.1.1.1')).statusCode).toBe(429);
    expect((await get('2.2.2.2')).statusCode).toBe(200);
  });

  it('bad-credential requests from one IP hit the global IP limit', async () => {
    await start({ rateLimitOverrides: { ip_global: 3 } });
    const get = (ip: string) =>
      app.inject({
        url: '/v1/ping',
        headers: { ...bearer('tdr_test_nope'), 'x-forwarded-for': ip },
      });
    for (let i = 0; i < 3; i++) expect((await get('9.9.9.9')).statusCode).toBe(401);
    const res = await get('9.9.9.9');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect((await get('8.8.8.8')).statusCode).toBe(401);
  });

  it('rejects a throttled caller before the body is parsed', async () => {
    await start({ rateLimitOverrides: { secret_key: 1 } });
    const k = await createApiKey(merchantId, { livemode: false });
    const post = (payload: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/test/echo',
        headers: { ...bearer(k.raw), 'content-type': 'application/json' },
        payload,
      });
    expect((await post('{"a":1}')).statusCode).toBe(200);
    // exhausted: invalid JSON gets 429, not 400
    expect((await post('{not json')).statusCode).toBe(429);
  });

  it('does not store raw credentials in Redis keys', async () => {
    const { getRedis } = await import('../lib/redis.js');
    await start({ rateLimitNamespace: 'tendr:rl:test:keys:' });
    const k = await createApiKey(merchantId, { livemode: false });
    await app.inject({ url: '/v1/ping', headers: bearer(k.raw) });
    const keys = await getRedis().keys('tendr:rl:test:keys:*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((x) => x.includes(k.raw))).toBe(false);
    expect(keys.some((x) => x.includes(k.record.id))).toBe(true);
    await getRedis().del(...keys);
  });

  it('fails open when Redis is down', async () => {
    await start({ redisUrl: 'redis://localhost:1' });
    const k = await createApiKey(merchantId, { livemode: false });
    const res = await app.inject({ url: '/v1/ping', headers: bearer(k.raw) });
    expect(res.statusCode).toBe(200);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('failing open'))).toBe(true);
  });
});
