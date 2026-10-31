import type { Merchant } from '@prisma/client';
import { THEME_PRESETS } from '@tendr/contracts';
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

describe('theme routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let liveKey: string;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Ada Fashion House' });
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    liveKey = (await createApiKey(merchant.id, { livemode: true })).raw;
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  async function newTheme(key = testKey) {
    const res = await call('POST', '/v1/themes', bearer(key), { name: 'Main', from: 'blank' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: number; draft: Record<string, unknown> };
  }

  async function member(role: 'viewer' | 'admin', stepUp = true) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: user.id, role });
    const login = await loginAs(user.id, { stepUp });
    return dashHeaders(login, { merchantId: merchant.id, livemode: false });
  }

  it('presets, create, read, list, edit and delete round trip', async () => {
    const presets = await call('GET', '/v1/themes/presets', bearer(testKey));
    expect(presets.statusCode, presets.body).toBe(200);
    const data = presets.json().data as { id: string; document: unknown }[];
    expect(data.map((p) => p.id).sort()).toEqual(Object.keys(THEME_PRESETS).sort());
    expect(data.find((p) => p.id === 'gaming')?.document).toEqual(
      THEME_PRESETS.gaming.document('Ada Fashion House'),
    );

    const t = await newTheme();
    expect((await call('GET', `/v1/themes/${t.id}`, bearer(testKey))).json().id).toBe(t.id);
    const list = await call('GET', '/v1/themes?limit=10', bearer(testKey));
    expect(list.json()).toMatchObject({ data: [{ id: t.id }], has_more: false });

    const patched = await call('PATCH', `/v1/themes/${t.id}`, bearer(testKey), { name: 'Sale' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().name).toBe('Sale');

    const del = await call('DELETE', `/v1/themes/${t.id}`, bearer(testKey));
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ id: t.id, object: 'theme', deleted: true });
  });

  it('an invalid draft is THEME_INVALID with paths', async () => {
    const t = await newTheme();
    const res = await call('PATCH', `/v1/themes/${t.id}`, bearer(testKey), {
      draft: { ...t.draft, blocks: [] },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('THEME_INVALID');
    expect(res.json().error.details.problems).toEqual([
      { path: 'blocks', message: 'The page needs exactly one payment block' },
    ]);
  });

  it('test secret key cannot publish or set default (403)', async () => {
    const t = await newTheme();
    expect((await call('POST', `/v1/themes/${t.id}/publish`, bearer(testKey))).statusCode).toBe(
      403,
    );
    await call('POST', `/v1/themes/${t.id}/publish`, bearer(liveKey));
    expect((await call('POST', `/v1/themes/${t.id}/default`, bearer(testKey))).statusCode).toBe(
      403,
    );
    const row = await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.isDefault).toBe(false);
  });

  it('live secret key can publish', async () => {
    const t = await newTheme();
    const pub = await call('POST', `/v1/themes/${t.id}/publish`, bearer(liveKey));
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json()).toMatchObject({ status: 'published', version: t.version + 1 });
    const def = await call('POST', `/v1/themes/${t.id}/default`, bearer(liveKey));
    expect(def.statusCode, def.body).toBe(200);
    expect(def.json().is_default).toBe(true);
  });

  it('dashboard publish needs step-up (401 STEP_UP_REQUIRED)', async () => {
    const t = await newTheme();
    const noStepUp = await member('admin', false);
    const res = await call('POST', `/v1/themes/${t.id}/publish`, noStepUp);
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await call('POST', `/v1/themes/${t.id}/default`, noStepUp)).statusCode).toBe(401);
    // Drafts need no step-up.
    expect((await call('PATCH', `/v1/themes/${t.id}`, noStepUp, { name: 'X' })).statusCode).toBe(
      200,
    );

    // A stepped-up admin publishes, even acting in test mode (dashboard users act on the store).
    const admin = await member('admin');
    const ok = await call('POST', `/v1/themes/${t.id}/publish`, admin);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await call('POST', `/v1/themes/${t.id}/default`, admin)).statusCode).toBe(200);
  });

  it('member without settings:manage gets 403', async () => {
    const t = await newTheme();
    const viewer = await member('viewer');
    expect((await call('GET', '/v1/themes', viewer)).statusCode).toBe(200);
    expect((await call('GET', `/v1/themes/${t.id}`, viewer)).statusCode).toBe(200);
    expect(
      (await call('POST', '/v1/themes', viewer, { name: 'A', from: 'blank' })).statusCode,
    ).toBe(403);
    expect((await call('PATCH', `/v1/themes/${t.id}`, viewer, { name: 'A' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/themes/${t.id}/publish`, viewer)).statusCode).toBe(403);
    expect((await call('DELETE', `/v1/themes/${t.id}`, viewer)).statusCode).toBe(403);

    // A key without the theme scopes is refused too.
    const noScope = (await createApiKey(merchant.id, { livemode: true, scopes: ['themes:read'] }))
      .raw;
    expect((await call('GET', '/v1/themes', bearer(noScope))).statusCode).toBe(200);
    expect((await call('POST', `/v1/themes/${t.id}/publish`, bearer(noScope))).statusCode).toBe(
      403,
    );
  });

  it('validate returns problems without saving', async () => {
    const t = await newTheme();
    const res = await call('POST', '/v1/themes/validate', bearer(testKey), {
      document: { ...t.draft, custom_css: '.x { position: fixed }' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().valid).toBe(false);
    expect(res.json().problems[0].path).toBe('custom_css');
    const ok = await call('POST', '/v1/themes/validate', bearer(testKey), { document: t.draft });
    expect(ok.json()).toEqual({ valid: true, problems: [] });
    expect(await prisma.checkoutTheme.count()).toBe(1);
    const row = await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.draft).toEqual(t.draft);
  });

  it('cross-merchant theme id is 404', async () => {
    const other = await createMerchant();
    const otherKey = (await createApiKey(other.id, { livemode: true })).raw;
    const t = await newTheme();
    for (const [method, path] of [
      ['GET', `/v1/themes/${t.id}`],
      ['PATCH', `/v1/themes/${t.id}`],
      ['DELETE', `/v1/themes/${t.id}`],
      ['POST', `/v1/themes/${t.id}/publish`],
      ['POST', `/v1/themes/${t.id}/default`],
    ] as const) {
      const res = await call(method, path, bearer(otherKey), method === 'PATCH' ? {} : undefined);
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
    // A link cannot name another store's theme either.
    const link = await call('POST', '/v1/payment_links', bearer(otherKey), {
      title: 'Gift',
      amount_type: 'open',
      currency: 'USD',
      theme_id: t.id,
    });
    expect(link.statusCode, link.body).toBe(404);
    expect(link.json().error.message).toBe('No theme with that id');
  });
});
