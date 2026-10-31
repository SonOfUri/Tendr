// CORS for the pay host: with CHECKOUT_BASE_URL=https://pay.usetendr.tech and
// CORS_ORIGINS=https://app.usetendr.tech, every API route the pay-host pages call from the
// browser must answer the preflight and the response for the pay origin.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadEnv } from '../env.js';
import { prisma } from '../lib/prisma.js';

const PAY = 'https://pay.usetendr.tech';
const APP = 'https://app.usetendr.tech';
const KEYS = [
  'CHECKOUT_BASE_URL',
  'CORS_ORIGINS',
  'ASSET_PUBLIC_PROXY',
  'TENDR_ASSET_ORIGIN',
] as const;

// The routes the pay-host pages call: the shopper checkout client, the refund-address form, the
// public payment link read and session create, the theme preview read and the wallet paymaster.
const ROUTES: { name: string; method: 'GET' | 'POST'; url: string }[] = [
  { name: 'checkout client', method: 'GET', url: '/v1/checkout/client/session' },
  { name: 'checkout client POST', method: 'POST', url: '/v1/checkout/client/email' },
  { name: 'refund address', method: 'POST', url: '/v1/checkout/refund-address' },
  { name: 'public link read', method: 'GET', url: '/v1/payment_links/public/acme/nope' },
  { name: 'theme preview', method: 'GET', url: '/v1/themes/preview/sometoken' },
  { name: 'wallet paymaster', method: 'POST', url: '/v1/checkout/paymaster/sometoken' },
  { name: 'public asset', method: 'GET', url: '/v1/assets/assets/mer_1/missing.woff2' },
];

describe('pay-host CORS', () => {
  let app: FastifyInstance;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.CHECKOUT_BASE_URL = PAY;
    process.env.CORS_ORIGINS = APP;
    process.env.ASSET_PUBLIC_PROXY = 'true';
    process.env.TENDR_ASSET_ORIGIN = `${new URL(process.env.API_BASE_URL ?? 'http://localhost:4000').origin}/v1/assets`;
    loadEnv();
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    loadEnv();
    await prisma.$disconnect();
  });

  it.each(ROUTES)('$name: preflight allows the pay origin', async ({ method, url }) => {
    const res = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: PAY,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const allow = res.headers['access-control-allow-origin'];
    expect(allow === PAY || allow === '*').toBe(true);
  });

  it.each(ROUTES)('$name: the response allows the pay origin', async ({ method, url }) => {
    const res = await app.inject({
      method,
      url,
      headers: { origin: PAY },
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    const allow = res.headers['access-control-allow-origin'];
    expect(allow === PAY || allow === '*').toBe(true);
  });

  it('theme preview: the pay origin is allowed without credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/themes/preview/sometoken',
      headers: { origin: PAY },
    });
    expect(res.headers['access-control-allow-origin']).toBe(PAY);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('the dashboard origin stays credentialed on dashboard routes, the pay origin does not', async () => {
    const dash = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { origin: APP },
    });
    expect(dash.headers['access-control-allow-origin']).toBe(APP);
    expect(dash.headers['access-control-allow-credentials']).toBe('true');
    const pay = await app.inject({
      method: 'GET',
      url: '/v1/checkout/client/session',
      headers: { origin: PAY },
    });
    expect(pay.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
