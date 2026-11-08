import { randomUUID } from 'node:crypto';
import {
  CSRF_HEADER,
  MERCHANT_HEADER,
  TENDR_DEFAULT_THEME,
  THEME_MAX_PER_MERCHANT,
} from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { merchantInsights } from '../ai/insights.js';
import * as provider from '../ai/provider.js';
import { prisma } from '../lib/prisma.js';
import { newId } from '../lib/ids.js';
import { dashHeaders, loginAs } from '../test/dashboard.js';
import {
  createApiKey,
  createMerchant,
  createRow,
  createUser,
  minimalSession,
  resetDb,
  setLiveMode,
} from '../test/helpers.js';

const style = {
  mode: 'dark',
  palettes: {
    dark: { accent: '#7a72ff', background: '#080d1b', surface: '#0f1629', text: '#ffffff' },
  },
  font: 'sora',
  corner: 'round',
  celebration: 'none',
  blocks: ['header', 'order_summary', 'payment'],
  custom_css: 'h2 { letter-spacing: 0.02em; }',
};

beforeAll(() => setLiveMode(true));
afterAll(() => setLiveMode(undefined));

describe('merchant AI APIs', () => {
  let app: FastifyInstance;
  let merchantId: string;
  let headers: Record<string, string>;
  let generate: ReturnType<typeof vi.fn<provider.JsonGenerator>>;
  let selector: ReturnType<typeof vi.fn<provider.FactSelector>>;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    generate = vi
      .fn<provider.JsonGenerator>()
      .mockImplementation(async () => structuredClone(style));
    selector = vi.fn<provider.FactSelector>().mockResolvedValue(['conversion', 'dropoff']);
    vi.spyOn(provider, 'configuredJsonGenerator').mockResolvedValue(generate);
    vi.spyOn(provider, 'configuredSelector').mockResolvedValue(selector);
    merchantId = (await createMerchant({ name: 'Merchant Private Name' })).id;
    headers = await member('admin');
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function member(role: 'viewer' | 'admin', merchant = merchantId) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant, false, { userId: user.id, role });
    return dashHeaders(await loginAs(user.id), { merchantId: merchant, livemode: false });
  }
  function theme(over: object = {}, auth = headers, key = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: '/v1/ai/themes',
      headers: { ...auth, 'idempotency-key': key },
      payload: { name: 'AI midnight', prompt: 'Dark rounded checkout', ...over },
    });
  }
  async function session(over: Partial<Parameters<typeof minimalSession>[0]> = {}) {
    return prisma.session.create({
      data: minimalSession({
        merchantId,
        livemode: false,
        createdAt: new Date(Date.now() - 86_400_000),
        customerEmail: 'private-shopper@example.com',
        metadata: { private: 'order-note' },
        ...over,
      }),
    });
  }
  async function quote(sessionId: string) {
    return prisma.quote.create({
      data: {
        id: newId('quo'),
        merchantId,
        livemode: false,
        sessionId,
        originAssetId: 'nep141:usdc.test',
        depositAddress: randomUUID(),
        amountIn: '49000000',
        amountOut: '49000000',
        refundTo: 'private.near',
        deadline: new Date(Date.now() + 60_000),
      },
    });
  }

  it('returns zero-data metrics without a model, preserving null conversion and comparison', async () => {
    const res = await app.inject({ url: '/v1/ai/insights?days=7', headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().current).toMatchObject({
      sessions_created: 0,
      conversion_percent: null,
      settled_order_totals: [],
    });
    expect(res.json().conversion_change_percentage_points).toBeNull();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(provider.configuredSelector).not.toHaveBeenCalled();
  });

  it('counts distinct session cohorts, preserves currencies, and isolates other stores and modes', async () => {
    const first = await session({
      merchantId,
      livemode: false,
      status: 'SETTLED',
      amount: '25.10',
    });
    const q1 = await quote(first.id);
    await quote(first.id); // A second quote must not double-count the session.
    const p = await prisma.payment.create({
      data: {
        id: newId('pay'),
        merchantId,
        livemode: false,
        sessionId: first.id,
        quoteId: q1.id,
        amountReceived: '25100000',
        status: 'PARTIALLY_REFUNDED',
        settledAt: new Date(),
      },
    });
    await prisma.refund.create({
      data: {
        id: newId('ref'),
        merchantId,
        livemode: false,
        paymentId: p.id,
        reason: 'merchant',
        externalRef: 'refund-1',
        requestedAmountUsd: '1',
        amount: '1000000',
        assetId: 'nep141:usdc.test',
      },
    });
    await session({
      merchantId,
      livemode: false,
      status: 'SETTLED',
      amountCurrency: 'nep141:eth.test',
      destAsset: 'nep141:eth.test',
      amount: '0.01',
    });
    await session({ merchantId, livemode: false, status: 'EXPIRED' });
    await session({
      merchantId,
      livemode: false,
      createdAt: new Date(Date.now() - 10 * 86_400_000),
      status: 'SETTLED',
      amount: '80',
    });
    const other = await createMerchant();
    await session({ merchantId: other.id, livemode: false, status: 'SETTLED', amount: '999999' });
    await session({ merchantId, livemode: true, status: 'SETTLED', amount: '888888' });
    const res = await app.inject({ url: '/v1/ai/insights?days=7', headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().current).toMatchObject({
      sessions_created: 3,
      sessions_quoted: 1,
      sessions_with_deposit: 1,
      sessions_settled: 2,
      expired_without_deposit: 1,
      sessions_with_refunds: 1,
      conversion_percent: '66.67',
      settled_order_totals: [
        { currency: 'USD', amount: '25.1' },
        { currency: 'nep141:eth.test', amount: '0.01' },
      ],
    });
    expect(res.json().previous.sessions_created).toBe(1);
    expect(res.json().conversion_change_percentage_points).toBe('-33.33');
    expect(res.body).not.toMatch(/private-shopper|order-note|private.near|999999|888888/);
  });

  it('does not count an automatic refund before settlement as a paid order', async () => {
    const s = await session({ merchantId, livemode: false, status: 'REFUNDED' });
    const q = await quote(s.id);
    await prisma.payment.create({
      data: {
        id: newId('pay'),
        merchantId,
        livemode: false,
        sessionId: s.id,
        quoteId: q.id,
        amountReceived: '1',
        status: 'REFUNDED',
      },
    });
    const report = await merchantInsights({ merchantId, livemode: false }, 7);
    expect(report.current.sessions_settled).toBe(0);
    expect(report.current.sessions_with_deposit).toBe(1);
  });

  it('gives the model calculated facts only, with the merchant context selected by authentication', async () => {
    await session();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ai/insights',
      headers,
      payload: { days: 7, question: 'Where are shoppers dropping off?' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().answer).toContain('sessions created');
    expect(res.json().read_only).toBe(true);
    expect(provider.configuredSelector).toHaveBeenCalledWith('insights');
    expect(JSON.stringify(selector.mock.calls[0]![1])).not.toMatch(
      /Merchant Private Name|private-shopper|order-note|mer_/,
    );
  });

  it('rejects missing auth, API-key auth, invalid windows and cross-store requests', async () => {
    expect((await app.inject({ url: '/v1/ai/insights' })).statusCode).toBe(401);
    const key = await createApiKey(merchantId, { livemode: false });
    expect(
      (
        await app.inject({
          url: '/v1/ai/insights',
          headers: { authorization: `Bearer ${key.raw}` },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/v1/ai/insights?days=91', headers })).statusCode).toBe(400);
    const other = await createMerchant();
    expect(
      (
        await app.inject({
          url: '/v1/ai/insights',
          headers: { ...headers, [MERCHANT_HEADER]: other.id },
        })
      ).statusCode,
    ).toBe(403);
    const noCsrf = { ...headers };
    delete noCsrf[CSRF_HEADER];
    expect(
      (await app.inject({ method: 'POST', url: '/v1/ai/insights', headers: noCsrf, payload: {} }))
        .statusCode,
    ).toBe(403);
  });

  it('creates a validated draft while preserving the real merchant name and existing published theme', async () => {
    const original = await createRow('CheckoutTheme', merchantId, false, {
      status: 'published',
      isDefault: true,
      published: TENDR_DEFAULT_THEME('Merchant Private Name'),
    });
    const before = await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: original.id } });
    const res = await theme({ prompt: 'A dark luxury layout. Contact me at owner@example.com' });
    expect(res.statusCode, res.body).toBe(201);
    const t = res.json().theme;
    expect(res.json()).toMatchObject({ source: 'model_generated_draft', requires_publish: true });
    expect(t).toMatchObject({
      name: 'AI midnight',
      status: 'draft',
      is_default: false,
      published: null,
    });
    expect(t.draft.settings.display_name).toBe('Merchant Private Name');
    const row = await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.draftCss).toContain('.tdr-scope');
    expect(await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: original.id } })).toEqual(
      before,
    );
    const sent = JSON.stringify(generate.mock.calls);
    expect(sent).not.toMatch(/owner@example.com|Merchant Private Name|mer_/);
    expect(generate.mock.calls[0]![0].maxTokens).toBe(2000);
  });

  it('requires settings permission, CSRF and an idempotency key before generating', async () => {
    const viewer = await member('viewer');
    expect((await theme({}, viewer)).statusCode).toBe(403);
    const noCsrf = { ...headers };
    delete noCsrf[CSRF_HEADER];
    expect((await theme({}, noCsrf)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/ai/themes',
          headers,
          payload: { name: 'Draft', prompt: 'Blue' },
        })
      ).statusCode,
    ).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('replays generation retries without charging again or duplicating drafts', async () => {
    const key = randomUUID();
    const first = await theme({}, headers, key);
    const again = await theme({}, headers, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(again.body).toBe(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await prisma.checkoutTheme.count()).toBe(1);
  });

  it.each([
    { ...style, custom_css: 'body { position: fixed; inset: 0; }' },
    { ...style, blocks: ['header', 'order_summary'] },
    { ...style, custom_css: 'div { background-image: url(https://attacker.example/x); }' },
    { ...style, palettes: { dark: { ...style.palettes.dark, text: '#080d1b' } } },
  ])('rejects unsafe/unusable model themes without leaving drafts: %j', async (proposal) => {
    generate.mockResolvedValue(proposal);
    const res = await theme();
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('THEME_INVALID');
    expect(await prisma.checkoutTheme.count()).toBe(0);
  });

  it('rejects model attempts to override merchant identity or add fields', async () => {
    generate.mockResolvedValue({
      ...style,
      display_name: 'Some Other Brand',
      recipient: 'attacker.near',
    });
    const res = await theme();
    expect(res.statusCode, res.body).toBe(503);
    expect(await prisma.checkoutTheme.count()).toBe(0);
  });

  it('serializes concurrent creates at the theme cap', async () => {
    await prisma.checkoutTheme.createMany({
      data: Array.from({ length: THEME_MAX_PER_MERCHANT - 1 }, () => ({
        id: newId('thm'),
        merchantId,
        name: 'Existing',
        draft: TENDR_DEFAULT_THEME('Merchant Private Name'),
      })),
    });
    const results = await Promise.all([theme(), theme(), theme()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await prisma.checkoutTheme.count()).toBe(THEME_MAX_PER_MERCHANT);
  });
});
