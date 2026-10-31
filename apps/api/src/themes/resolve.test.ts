import { Prisma, type Merchant } from '@prisma/client';
import { TENDR_DEFAULT_THEME, type ThemeDocument } from '@tendr/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scopedDb } from '../db/scoped.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import { resolveShopperTheme, type ShopperThemeInput } from './resolve.js';

const doc = (displayName: string, over: Partial<ThemeDocument> = {}): ThemeDocument => ({
  ...TENDR_DEFAULT_THEME(displayName),
  ...over,
});
const json = (d: unknown) => d as Prisma.InputJsonValue;

describe('resolveShopperTheme', () => {
  let merchant: Merchant;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    merchant = await createMerchant({ name: 'Bean Shop Ltd' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const resolve = (over: Partial<ShopperThemeInput> = {}) => {
    const livemode = over.livemode ?? true;
    return resolveShopperTheme(scopedDb({ merchantId: merchant.id, livemode }), {
      merchantId: merchant.id,
      merchantName: merchant.name,
      themeId: null,
      livemode,
      kind: 'checkout',
      ...over,
    });
  };

  /** A theme row: `published` (and its css) set when given. */
  const theme = (
    o: {
      draft?: unknown;
      published?: unknown;
      isDefault?: boolean;
      draftCss?: string;
      publishedCss?: string;
      version?: number;
    } = {},
  ) =>
    createRow('CheckoutTheme', merchant.id, false, {
      draft: json(o.draft ?? doc('Draft name')),
      published: o.published === undefined ? Prisma.JsonNull : json(o.published),
      status: o.published === undefined ? 'draft' : 'published',
      isDefault: o.isDefault ?? false,
      draftCss: o.draftCss ?? null,
      publishedCss: o.publishedCss ?? null,
      version: o.version ?? 1,
    });

  it('named published theme wins', async () => {
    await theme({ published: doc('Default Shop'), isDefault: true });
    const named = await theme({
      published: doc('Named Shop'),
      publishedCss: '.tdr-scope .x{color:red}',
      version: 3,
    });
    const t = await resolve({ themeId: named.id });
    expect(t.id).toBe(named.id);
    expect(t.version).toBe(3);
    expect(t.document.settings.display_name).toBe('Named Shop');
    expect(t.css).toBe('.tdr-scope .x{color:red}');
  });

  it('never sends the custom_css source to shoppers, only the scoped css', async () => {
    const named = await theme({
      published: doc('Styled Shop', { custom_css: '.x { color: red }' }),
      publishedCss: '.tdr-scope .x{color:red}',
    });
    const t = await resolve({ themeId: named.id });
    expect(t.document.settings.display_name).toBe('Styled Shop');
    expect('custom_css' in t.document).toBe(false);
    expect(t.css).toBe('.tdr-scope .x{color:red}');
  });

  it('test session renders named draft, live session ignores draft', async () => {
    const def = await theme({ published: doc('Default Shop'), isDefault: true });
    const draftOnly = await theme({ draft: doc('Draft Shop'), draftCss: '.tdr-scope a{}' });
    const test = await resolve({ themeId: draftOnly.id, livemode: false });
    expect(test.id).toBe(draftOnly.id);
    expect(test.document.settings.display_name).toBe('Draft Shop');
    expect(test.css).toBe('.tdr-scope a{}');
    const live = await resolve({ themeId: draftOnly.id, livemode: true });
    expect(live.id).toBe(def.id);
    expect(live.document.settings.display_name).toBe('Default Shop');

    // A published theme with a newer draft: test shows the draft, live the published version.
    const both = await theme({ draft: doc('Edited'), published: doc('Live') });
    expect(
      (await resolve({ themeId: both.id, livemode: false })).document.settings.display_name,
    ).toBe('Edited');
    expect((await resolve({ themeId: both.id })).document.settings.display_name).toBe('Live');
  });

  it('falls back to default then Tendr default', async () => {
    const none = await resolve({ themeId: 'thm_missing' });
    expect(none.id).toBeNull();
    expect(none.version).toBe(0);
    expect(none.css).toBeNull();
    expect(none.document).toEqual(TENDR_DEFAULT_THEME('Bean Shop Ltd'));

    const def = await theme({ published: doc('Default Shop'), isDefault: true });
    expect((await resolve({ themeId: 'thm_missing' })).id).toBe(def.id);
    expect((await resolve()).id).toBe(def.id);

    // Another merchant's theme is never used, even by id.
    const other = await createMerchant();
    const foreign = await createRow('CheckoutTheme', other.id, false, {
      published: json(doc('Foreign')),
      status: 'published',
    });
    expect((await resolve({ themeId: foreign.id })).id).toBe(def.id);
  });

  it('resolveShopperTheme falls back on invalid stored json', async () => {
    const def = await theme({ published: doc('Default Shop'), isDefault: true });
    const corrupt = await theme({ published: { schema_version: 1, settings: 'broken' } });
    const t = await resolve({ themeId: corrupt.id });
    expect(t.id).toBe(def.id);
    const warns = logSpy.mock.calls
      .map((c) => JSON.parse(String(c[0])) as { level: string; msg: string; themeId?: string })
      .filter((l) => l.level === 'warn');
    expect(warns).toEqual([expect.objectContaining({ themeId: corrupt.id })]);

    // A corrupt default too: the Tendr default, and the page still renders.
    await prisma.checkoutTheme.update({ where: { id: def.id }, data: { published: json([]) } });
    const fallback = await resolve({ themeId: corrupt.id });
    expect(fallback.id).toBeNull();
    expect(fallback.document).toEqual(TENDR_DEFAULT_THEME('Bean Shop Ltd'));
  });

  it('trading_as set only when names differ', async () => {
    const same = await theme({ published: doc('  bean shop LTD ') });
    const t1 = await resolve({ themeId: same.id });
    expect(t1.payee).toBe('Bean Shop Ltd');
    expect(t1.trading_as).toBeNull();
    const different = await theme({ published: doc('Beans & Co') });
    const t2 = await resolve({ themeId: different.id });
    expect(t2.payee).toBe('Bean Shop Ltd');
    expect(t2.trading_as).toBe('Beans & Co');
    expect((await resolve()).trading_as).toBeNull();
  });

  it('rich_text rendered to safe html', async () => {
    const base = doc('Bean Shop Ltd');
    const published = doc('Bean Shop Ltd', {
      blocks: [
        { id: 'intro', type: 'rich_text', markdown: '**Fresh** beans & [more](https://x.test)' },
        ...base.blocks,
        {
          id: 'sec',
          type: 'section',
          blocks: [{ id: 'nested', type: 'rich_text', markdown: '*hi* "there"' }],
        },
      ],
    });
    const t = await resolve({ themeId: (await theme({ published })).id });
    expect(Object.keys(t.rendered).sort()).toEqual(['intro', 'nested']);
    expect(t.rendered.intro).toContain('<strong>Fresh</strong>');
    expect(t.rendered.intro).toContain('&amp;');
    expect(t.rendered.intro).not.toMatch(/<script|on\w+=/i);
    expect(t.rendered.nested).toContain('<em>hi</em>');
  });

  it('maps the assets the document uses to their urls', async () => {
    const logo = await createRow('ThemeAsset', merchant.id, false, { kind: 'logo' });
    await createRow('ThemeAsset', merchant.id, false, { kind: 'image' }); // unused
    const published = doc('Bean Shop Ltd');
    published.settings.logo_asset_id = logo.id;
    const t = await resolve({ themeId: (await theme({ published })).id });
    expect(t.assets).toEqual({
      [logo.id]: { url: logo.url, kind: 'logo', mime: 'image/png' },
    });
  });
});
