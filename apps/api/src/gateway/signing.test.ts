import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createApiKey, createMerchant, resetDb } from '../test/helpers.js';
import { verifyRequestSignature } from './signing.js';

const SECRET = 'whsec_test_signing_secret';
const hmac = (secret: string, t: number, body: string) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const sign = (secret: string, t: number, body: string) => `t=${t},v1=${hmac(secret, t, body)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('verifyRequestSignature', () => {
  const now = 1_800_000_000;
  const body = '{"a":1}';
  const buf = Buffer.from(body);

  it('accepts valid, tolerating whitespace and extra v1 values', () => {
    expect(verifyRequestSignature(sign(SECRET, now, body), buf, SECRET, now)).toBe('ok');
    const spaced = ` t=${now} , v1=${'0'.repeat(64)} , v1=${hmac(SECRET, now, body)} `;
    expect(verifyRequestSignature(spaced, buf, SECRET, now)).toBe('ok');
  });

  it('enforces the 300s tolerance in both directions', () => {
    expect(verifyRequestSignature(sign(SECRET, now - 300, body), buf, SECRET, now)).toBe('ok');
    expect(verifyRequestSignature(sign(SECRET, now - 301, body), buf, SECRET, now)).toBe('stale');
    expect(verifyRequestSignature(sign(SECRET, now + 301, body), buf, SECRET, now)).toBe('stale');
  });

  it('classifies missing and invalid', () => {
    expect(verifyRequestSignature(undefined, buf, SECRET, now)).toBe('missing');
    expect(verifyRequestSignature('  ', buf, SECRET, now)).toBe('missing');
    expect(verifyRequestSignature(sign('other', now, body), buf, SECRET, now)).toBe('invalid');
    expect(verifyRequestSignature(sign(SECRET, now, '{"a":2}'), buf, SECRET, now)).toBe('invalid');
    expect(verifyRequestSignature('garbage', buf, SECRET, now)).toBe('invalid');
    expect(verifyRequestSignature(`t=${now}`, buf, SECRET, now)).toBe('invalid');
    expect(verifyRequestSignature(`t=x,v1=${hmac(SECRET, now, body)}`, buf, SECRET, now)).toBe(
      'invalid',
    );
    expect(
      verifyRequestSignature(`t=${now},t=${now},v1=${hmac(SECRET, now, body)}`, buf, SECRET, now),
    ).toBe('invalid');
  });
});

describe('request signing (gateway)', () => {
  let app: FastifyInstance;
  let required: string;
  let optional: string;
  let unsigned: string;
  let publishable: string;

  beforeAll(async () => {
    await resetDb();
    const m = await createMerchant();
    required = (
      await createApiKey(m.id, { livemode: false, signingRequired: true, signingSecret: SECRET })
    ).raw;
    optional = (await createApiKey(m.id, { livemode: false, signingSecret: SECRET })).raw;
    unsigned = (await createApiKey(m.id, { livemode: false })).raw;
    publishable = (await createApiKey(m.id, { livemode: false, kind: 'publishable' })).raw;
    app = await buildApp({
      extraRoutes: (a) => {
        a.post(
          '/v1/test-echo',
          { config: { auth: { principals: ['secret_key', 'publishable_key'] } } },
          async (req) => ({ body: req.body ?? null }),
        );
        a.get(
          '/v1/test-get',
          { config: { auth: { principals: ['secret_key'] } } },
          async () => ({ ok: true }),
        );
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const post = (key: string, body: string, signature?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/test-echo',
      payload: body,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...(signature ? { 'tendr-signature': signature } : {}),
      },
    });

  it('accepts a valid signature', async () => {
    const body = '{"x":1}';
    const res = await post(required, body, sign(SECRET, nowSec(), body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { x: 1 } });
  });

  it('rejects wrong secret, stale, future and missing-when-required with SIGNATURE_INVALID', async () => {
    const body = '{"x":1}';
    const t = nowSec();
    for (const sig of [
      sign('wrong', t, body),
      sign(SECRET, t - 301, body),
      sign(SECRET, t + 301, body),
      undefined,
    ]) {
      const res = await post(required, body, sig);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SIGNATURE_INVALID');
    }
  });

  it('verifies over raw bytes, not re-serialised JSON', async () => {
    const body = '{ "b":1,   "a":2 }';
    const res = await post(required, body, sign(SECRET, nowSec(), body));
    expect(res.statusCode).toBe(200);
    // A signature over the canonical re-serialisation must not verify.
    const bad = await post(required, body, sign(SECRET, nowSec(), JSON.stringify(JSON.parse(body))));
    expect(bad.statusCode).toBe(401);
  });

  it('signs the empty string for requests without a body', async () => {
    const get = (signature?: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/test-get',
        headers: {
          authorization: `Bearer ${required}`,
          ...(signature ? { 'tendr-signature': signature } : {}),
        },
      });
    expect((await get(sign(SECRET, nowSec(), ''))).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(401);
  });

  it('passes unsigned requests when signing is not required, but verifies a present header', async () => {
    const body = '{"x":1}';
    expect((await post(optional, body)).statusCode).toBe(200);
    expect((await post(unsigned, body)).statusCode).toBe(200);
    expect((await post(optional, body, sign(SECRET, nowSec(), body))).statusCode).toBe(200);
    const bad = await post(optional, body, sign('wrong', nowSec(), body));
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('SIGNATURE_INVALID');
  });

  it('does not apply to publishable keys', async () => {
    const res = await post(publishable, '{"x":1}', 'garbage');
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 VALIDATION_ERROR for invalid JSON and 415 for unsupported content type', async () => {
    const bad = await post(unsigned, '{not json');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    const media = await app.inject({
      method: 'POST',
      url: '/v1/test-echo',
      payload: 'hello',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${unsigned}` },
    });
    expect(media.statusCode).toBe(415);
    expect(media.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('treats an empty JSON body as no body', async () => {
    const res = await post(unsigned, '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
  });
});
