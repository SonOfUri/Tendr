import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createApiKey, createMerchant, resetDb, setLiveMode } from '../test/helpers.js';
import { requestHash } from './idempotency.js';

const SECRET = 'whsec_idem_signing_secret';
const sign = (t: number, body: string) =>
  `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;

// Live writes here assume live mode is open (LIVE_MODE_ENABLED); the switch-off behaviour is
// tested in gateway/live-mode.test.ts.
beforeAll(() => setLiveMode(true));
afterAll(() => setLiveMode(undefined));

describe('idempotency keys', () => {
  let app: FastifyInstance;
  let merchantId: string;
  let testKey: string;
  let testKeyId: string;
  let otherSecretKey: string;
  let publishableKey: string;
  let liveKey: string;
  let signedKey: string;
  let counter = 0;
  let failures = 0;

  beforeAll(async () => {
    await resetDb();
    merchantId = (await createMerchant()).id;
    ({
      raw: testKey,
      record: { id: testKeyId },
    } = await createApiKey(merchantId, { livemode: false }));
    otherSecretKey = (await createApiKey(merchantId, { livemode: false })).raw;
    publishableKey = (
      await createApiKey(merchantId, { livemode: false, kind: 'publishable', scopes: [] })
    ).raw;
    liveKey = (await createApiKey(merchantId, { livemode: true })).raw;
    signedKey = (
      await createApiKey(merchantId, {
        livemode: false,
        signingRequired: true,
        signingSecret: SECRET,
      })
    ).raw;
    const auth = { principals: ['secret_key' as const] };
    app = await buildApp({
      extraRoutes: (a) => {
        a.post('/v1/test-idem', { config: { auth } }, async (req, reply) => {
          counter += 1;
          await new Promise((r) => setTimeout(r, 200));
          return reply.code(201).send({ n: counter, body: req.body ?? null });
        });
        a.post(
          '/v1/test-idem-any',
          { config: { auth: { principals: ['secret_key', 'publishable_key'] } } },
          async (_req, reply) => {
            counter += 1;
            return reply.code(201).send({ n: counter });
          },
        );
        a.post('/v1/test-idem-503', { config: { auth } }, async (_req, reply) => {
          failures += 1;
          return reply.code(503).send({ n: failures });
        });
        a.post('/v1/test-idem-throw', { config: { auth } }, async () => {
          failures += 1;
          throw new Error('boom');
        });
        a.post('/v1/test-idem-400', { config: { auth } }, async (_req, reply) => {
          counter += 1;
          return reply.code(400).send({ n: counter });
        });
        a.get('/v1/test-idem-get', { config: { auth } }, async () => {
          counter += 1;
          return { n: counter };
        });
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(() => {
    counter = 0;
    failures = 0;
  });

  let seq = 0;
  const freshKey = () => `idem-${Date.now()}-${++seq}`;

  const post = (
    idemKey: string | undefined,
    body: string,
    opts: { apiKey?: string; url?: string; signature?: string } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: opts.url ?? '/v1/test-idem',
      payload: body,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey ?? testKey}`,
        ...(idemKey !== undefined ? { 'idempotency-key': idemKey } : {}),
        ...(opts.signature ? { 'tendr-signature': opts.signature } : {}),
      },
    });

  /** The row of `key` for the default test key (or any principal when there is just one). */
  const row = (key: string, livemode = false) =>
    prisma.idempotencyKey.findFirst({ where: { merchantId, livemode, key } });

  /** A row as a crashed or still-running request would leave it, `lockedSecondsAgo` in DB time. */
  const insertInProgress = async (key: string, body: string, lockedSecondsAgo: number) => {
    await prisma.$executeRaw`
      INSERT INTO idempotency_keys
        (id, merchant_id, livemode, principal_ref, key, request_hash, status, locked_at,
         expires_at, updated_at)
      VALUES
        (${`idem_seed_${key}`}, ${merchantId}, false, ${`secret_key:${testKeyId}`}, ${key},
         ${requestHash('POST', '/v1/test-idem', Buffer.from(body))}, 'in_progress',
         (now() AT TIME ZONE 'UTC') - make_interval(secs => ${lockedSecondsAgo}),
         (now() AT TIME ZONE 'UTC') + interval '24 hours', now() AT TIME ZONE 'UTC')`;
  };

  it('replays the same response and executes once', async () => {
    const key = freshKey();
    const first = await post(key, '{"a":1}');
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const second = await post(key, '{"a":1}');
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.headers['content-type']).toMatch(/^application\/json/);
    expect(second.body).toBe(first.body);
    expect(counter).toBe(1);
    const stored = await row(key);
    expect(stored?.status).toBe('completed');
    expect(stored?.responseCode).toBe(201);
  });

  it('409 on same key, different body', async () => {
    const key = freshKey();
    expect((await post(key, '{"a":1}')).statusCode).toBe(201);
    const res = await post(key, '{"a":2}');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(counter).toBe(1);
  });

  it('409 on same key, different path', async () => {
    const key = freshKey();
    expect((await post(key, '{}')).statusCode).toBe(201);
    const res = await post(key, '{}', { url: '/v1/test-idem-400' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(counter).toBe(1);
  });

  it('concurrent duplicates: one executes, the other gets 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const key = freshKey();
    const [a, b] = await Promise.all([post(key, '{"c":1}'), post(key, '{"c":1}')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(counter).toBe(1);
  });

  it('same key with test and live keys does not replay across modes', async () => {
    const key = freshKey();
    const test = await post(key, '{"m":1}', { apiKey: testKey });
    const live = await post(key, '{"m":1}', { apiKey: liveKey });
    expect(test.statusCode).toBe(201);
    expect(live.statusCode).toBe(201);
    expect(live.headers['idempotent-replayed']).toBeUndefined();
    expect(counter).toBe(2);
    expect((await row(key, false))?.status).toBe('completed');
    expect((await row(key, true))?.status).toBe('completed');
  });

  it('same key and body from different principals of one merchant + mode never replays', async () => {
    const key = freshKey();
    const url = '/v1/test-idem-any';
    const responses = [
      await post(key, '{"p":1}', { url, apiKey: testKey }),
      await post(key, '{"p":1}', { url, apiKey: publishableKey }),
      await post(key, '{"p":1}', { url, apiKey: otherSecretKey }),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(201);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
    }
    expect(responses.map((r) => r.json().n)).toEqual([1, 2, 3]);
    expect(counter).toBe(3);
    const rows = await prisma.idempotencyKey.findMany({ where: { merchantId, key } });
    const refs = rows.map((r) => r.principalRef);
    expect(new Set(refs).size).toBe(3);
    expect(refs).toContain(`secret_key:${testKeyId}`);
    expect(refs.filter((r) => r.startsWith('publishable_key:'))).toHaveLength(1);
    // Each principal still gets its own response replayed.
    const again = await post(key, '{"p":1}', { url, apiKey: publishableKey });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().n).toBe(2);
  });

  it('5xx response is not stored', async () => {
    const key = freshKey();
    const url = '/v1/test-idem-503';
    expect((await post(key, '{}', { url })).statusCode).toBe(503);
    expect(await row(key)).toBeNull();
    const retry = await post(key, '{}', { url });
    expect(retry.statusCode).toBe(503);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(failures).toBe(2);
  });

  it('a handler that throws (500 from the error handler) is not stored', async () => {
    const key = freshKey();
    const url = '/v1/test-idem-throw';
    // The error handler logs the thrown error; keep the expected noise out of the test output.
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    onTestFinished(() => quiet.mockRestore());
    expect((await post(key, '{}', { url })).statusCode).toBe(500);
    expect(await row(key)).toBeNull();
    expect((await post(key, '{}', { url })).statusCode).toBe(500);
    expect(failures).toBe(2);
  });

  it('4xx responses are stored and replayed', async () => {
    const key = freshKey();
    const url = '/v1/test-idem-400';
    expect((await post(key, '{}', { url })).statusCode).toBe(400);
    const again = await post(key, '{}', { url });
    expect(again.statusCode).toBe(400);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(counter).toBe(1);
  });

  it('expired key executes again', async () => {
    const key = freshKey();
    expect((await post(key, '{"e":1}')).statusCode).toBe(201);
    await prisma.$executeRaw`
      UPDATE idempotency_keys SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE merchant_id = ${merchantId} AND key = ${key}`;
    const again = await post(key, '{"e":1}');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
    expect(again.json().n).toBe(2);
    expect(counter).toBe(2);
    const stored = await row(key);
    expect(stored?.status).toBe('completed');
    expect(stored!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('an expired key may be reused with a different body', async () => {
    const key = freshKey();
    expect((await post(key, '{"e":1}')).statusCode).toBe(201);
    await prisma.$executeRaw`
      UPDATE idempotency_keys SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE merchant_id = ${merchantId} AND key = ${key}`;
    expect((await post(key, '{"e":2}')).statusCode).toBe(201);
    expect(counter).toBe(2);
  });

  it('stale in_progress key (locked 61s ago, simulating a crashed request) is taken over and executes', async () => {
    const key = freshKey();
    await insertInProgress(key, '{"s":1}', 61);
    const res = await post(key, '{"s":1}');
    expect(res.statusCode).toBe(201);
    expect(counter).toBe(1);
    const stored = await row(key);
    expect(stored?.status).toBe('completed');
    expect(stored?.responseCode).toBe(201);
  });

  it('stale in_progress key with a different body is a conflict', async () => {
    const key = freshKey();
    await insertInProgress(key, '{"s":1}', 61);
    const res = await post(key, '{"s":2}');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(counter).toBe(0);
    expect((await row(key))?.status).toBe('in_progress');
  });

  it('in_progress key locked 30s ago still returns 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const key = freshKey();
    await insertInProgress(key, '{"s":1}', 30);
    const res = await post(key, '{"s":1}');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(counter).toBe(0);
  });

  it('a request whose lock was taken over does not overwrite the new owner', async () => {
    const key = freshKey();
    // First request is running; simulate its lock going stale mid-flight, and a takeover.
    const first = post(key, '{"t":1}');
    await new Promise((r) => setTimeout(r, 50));
    await prisma.$executeRaw`
      UPDATE idempotency_keys SET locked_at = (now() AT TIME ZONE 'UTC') - interval '61 seconds'
      WHERE merchant_id = ${merchantId} AND key = ${key}`;
    const second = post(key, '{"t":1}');
    const a = await first;
    expect(a.statusCode).toBe(201);
    // The stale owner finished first, but the row now belongs to the taker: still in progress.
    expect((await row(key))?.status).toBe('in_progress');
    const b = await second;
    expect(b.statusCode).toBe(201);
    expect(counter).toBe(2);
    const replay = await post(key, '{"t":1}');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // The stored response is the taker's (the second execution), not the stale owner's.
    expect(replay.json().n).toBe(b.json().n);
  });

  it('rejects an invalid Idempotency-Key header with 400 VALIDATION_ERROR', async () => {
    for (const bad of ['', 'x'.repeat(256)]) {
      const res = await post(bad, '{}');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await post('x'.repeat(255), '{}')).statusCode).toBe(201);
    expect(counter).toBe(1);
  });

  it('requests without the header are not deduplicated', async () => {
    const before = await prisma.idempotencyKey.count();
    await post(undefined, '{}');
    await post(undefined, '{}');
    expect(counter).toBe(2);
    expect(await prisma.idempotencyKey.count()).toBe(before);
  });

  it('ignores the header on non-POST requests', async () => {
    const key = freshKey();
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/test-idem-get',
        headers: { authorization: `Bearer ${testKey}`, 'idempotency-key': key },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(counter).toBe(2);
    expect(await row(key)).toBeNull();
  });

  it('an unsigned request to a signing-required key cannot claim or replay a key', async () => {
    const key = freshKey();
    const body = '{"sig":1}';
    const bad = await post(key, body, { apiKey: signedKey });
    expect(bad.statusCode).toBe(401);
    expect(await row(key)).toBeNull();
    const t = Math.floor(Date.now() / 1000);
    expect(
      (await post(key, body, { apiKey: signedKey, signature: sign(t, body) })).statusCode,
    ).toBe(201);
    const forged = await post(key, body, { apiKey: signedKey, signature: sign(t, '{"x":0}') });
    expect(forged.statusCode).toBe(401);
    expect(forged.headers['idempotent-replayed']).toBeUndefined();
    expect(counter).toBe(1);
  });
});
