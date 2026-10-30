import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { sha256 } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';

describe('theme preview links', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let key: string;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Ada Fashion House' });
    key = (await createApiKey(merchant.id, { livemode: false })).raw;
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const auth = () => ({ authorization: `Bearer ${key}` });
  const opts = { sample: 'checkout', scheme: 'light', viewport: 'phone' };

  async function newTheme() {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/themes',
      headers: auth(),
      payload: { name: 'Main', from: 'blank' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; draft: Record<string, unknown> };
  }
  async function mint(themeId: string, o: object = opts) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/themes/${themeId}/preview`,
      headers: auth(),
      payload: o,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { url: string; expires_at: string };
    return { ...body, token: body.url.split('/preview/theme/')[1]! };
  }
  const read = (token: string) =>
    app.inject({ method: 'GET', url: `/v1/themes/preview/${token}` });

  it('preview token expires after 15 minutes', async () => {
    const t = await newTheme();
    const p = await mint(t.id);
    expect(p.url).toMatch(/\/preview\/theme\/[A-Za-z0-9_-]{43}$/);
    const ttl = await getRedis().ttl(`theme-preview:${sha256(p.token)}`);
    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);
    const exp = new Date(p.expires_at).getTime() - Date.now();
    expect(exp).toBeGreaterThan(895_000);
    expect(exp).toBeLessThanOrEqual(900_000);

    await getRedis().del(`theme-preview:${sha256(p.token)}`); // what expiry does
    expect((await read(p.token)).statusCode).toBe(404);
  });

  it('preview shows the current draft', async () => {
    const t = await newTheme();
    const p = await mint(t.id);
    const first = await read(p.token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-robots-tag']).toBe('noindex');
    const body = first.json();
    expect(body).toMatchObject({ preview: true, opts, theme: { id: t.id } });
    expect(body.sample).toMatchObject({
      kind: 'checkout',
      amount: '49.00',
      amount_currency: 'USD',
    });
    expect(body.sample.line_items).toHaveLength(2);
    expect(body.sample.line_items[0].image_url).toMatch(/\/preview\/sample-shirt\.webp$/);
    expect(body.sample.link).toBeUndefined();
    expect(body.theme.payee).toBe('Ada Fashion House');

    const draft = structuredClone(t.draft) as { settings: { display_name: string } };
    draft.settings.display_name = 'Ada Draft Edit';
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/themes/${t.id}`,
      headers: auth(),
      payload: { draft },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const second = (await read(p.token)).json();
    expect(second.theme.document.settings.display_name).toBe('Ada Draft Edit');
    expect(second.theme.trading_as).toBe('Ada Draft Edit');
  });

  it('link sample carries link copy and NGN follows the last session', async () => {
    const t = await newTheme();
    await createRow('Session', merchant.id, false, { amountCurrency: 'NGN' });
    const p = await mint(t.id, { ...opts, sample: 'link' });
    const body = (await read(p.token)).json();
    expect(body.sample).toMatchObject({
      kind: 'link',
      amount: '25000',
      amount_currency: 'NGN',
      link: { title: expect.any(String) },
    });
  });

  it('unknown token 404', async () => {
    const res = await read('x'.repeat(43));
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await read('short')).statusCode).toBe(404);
  });

  it('minting for a theme that is not the merchant’s is 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/themes/thm_nope/preview',
      headers: auth(),
      payload: opts,
    });
    expect(res.statusCode).toBe(404);
  });

  it('preview read creates no session', async () => {
    const t = await newTheme();
    const p = await mint(t.id);
    const before = await prisma.session.count();
    expect((await read(p.token)).statusCode).toBe(200);
    expect((await read(p.token)).statusCode).toBe(200);
    expect(await prisma.session.count()).toBe(before);
  });
});
