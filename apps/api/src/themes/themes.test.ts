import type { Merchant } from '@prisma/client';
import { THEME_PRESETS, type ThemeDocument } from '@tendr/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scopedDb } from '../db/scoped.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  createTheme,
  deleteTheme,
  getTheme,
  listThemes,
  publishTheme,
  setDefaultTheme,
  updateThemeDraft,
  validateOnly,
  type ThemeCtx,
} from './themes.js';

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('theme service', () => {
  let merchant: Merchant;
  const ctxOf = (livemode = false, merchantId = merchant.id): ThemeCtx => ({
    merchantId,
    db: scopedDb({ merchantId, livemode }),
  });

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    merchant = await createMerchant({ name: 'Ada Fashion House', slug: 'ada' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const blank = () => createTheme(ctxOf(), { name: 'Main', from: 'blank' });
  const withName = (doc: ThemeDocument, displayName: string): ThemeDocument => ({
    ...doc,
    settings: { ...doc.settings, display_name: displayName },
  });

  it('create from preset uses merchant name', async () => {
    const t = await createTheme(ctxOf(), { name: 'Shop', from: { preset: 'fashion' } });
    expect(t).toMatchObject({
      object: 'theme',
      name: 'Shop',
      status: 'draft',
      is_default: false,
      published: null,
      used_by_links: 0,
    });
    expect(t.draft).toEqual(THEME_PRESETS.fashion.document('Ada Fashion House'));
    const b = await blank();
    expect(b.draft.settings.display_name).toBe('Ada Fashion House');
    const copy = await createTheme(ctxOf(), { name: 'Copy', from: { theme_id: t.id } });
    expect(copy.draft).toEqual(t.draft);
  });

  it('21st theme is THEME_LIMIT', async () => {
    for (let i = 0; i < 20; i++) {
      await createTheme(ctxOf(i % 2 === 0), { name: `T${i}`, from: 'blank' });
    }
    const err = await rejection(blank());
    expect(err.code).toBe('THEME_LIMIT');
    expect(err.status).toBe(409);
    // The limit is per store: another merchant still has room.
    const other = await createMerchant();
    await expect(
      createTheme(ctxOf(false, other.id), { name: 'X', from: 'blank' }),
    ).resolves.toMatchObject({ name: 'X' });
  });

  it('invalid draft is THEME_INVALID with paths', async () => {
    const t = await blank();
    const bad = {
      ...t.draft,
      settings: { ...t.draft.settings, button_label: 'Pay 5 USD' },
      blocks: [...t.draft.blocks, { id: 'x', type: 'custom_html', html: '<form>hi</form>' }],
      custom_css: 'body * { color: red }',
    };
    const err = await rejection(updateThemeDraft(ctxOf(), t.id, { draft: bad }));
    expect(err.code).toBe('THEME_INVALID');
    expect(err.status).toBe(400);
    const problems = (err.details as { problems: { path: string; message: string }[] }).problems;
    expect(problems.map((p) => p.path)).toContain('settings.button_label');
    // Nothing was saved.
    expect((await getTheme(ctxOf(), t.id)).draft).toEqual(t.draft);

    const missingAsset = { ...t.draft, settings: { ...t.draft.settings, logo_asset_id: 'nope' } };
    const err2 = await rejection(updateThemeDraft(ctxOf(), t.id, { draft: missingAsset }));
    expect(err2.code).toBe('THEME_INVALID');
    expect((err2.details as { problems: { path: string }[] }).problems).toEqual([
      expect.objectContaining({ path: 'settings.logo_asset_id' }),
    ]);
  });

  it('stores the scoped css, never the raw css', async () => {
    const t = await blank();
    await updateThemeDraft(ctxOf(), t.id, {
      draft: { ...t.draft, custom_css: '.hero { color: #123456 }' },
    });
    const row = await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.draftCss).toContain('.tdr-scope .hero');
    expect(row.publishedCss).toBeNull();
    await publishTheme(ctxOf(true), t.id);
    const after = await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.publishedCss).toBe(row.draftCss);
    expect(after.cssHash).toMatch(/\S/);
  });

  it('publish copies draft and bumps version', async () => {
    const t = await blank();
    const draft = withName(t.draft, 'Ada');
    await updateThemeDraft(ctxOf(), t.id, { draft });
    const p = await publishTheme(ctxOf(true), t.id);
    expect(p.status).toBe('published');
    expect(p.version).toBe(t.version + 1);
    expect(p.published).toEqual(draft);
    expect(p.published_at).not.toBeNull();
    const again = await publishTheme(ctxOf(true), t.id);
    expect(again.version).toBe(t.version + 2);
  });

  it('editing a published theme leaves published unchanged until publish', async () => {
    const t = await blank();
    const published = await publishTheme(ctxOf(true), t.id);
    const edited = await updateThemeDraft(ctxOf(), t.id, {
      name: 'Renamed',
      draft: withName(t.draft, 'Ada Edit'),
    });
    expect(edited.name).toBe('Renamed');
    expect(edited.draft.settings.display_name).toBe('Ada Edit');
    expect(edited.published).toEqual(published.published);
    expect(edited.version).toBe(published.version);
    const row = await prisma.checkoutTheme.findUniqueOrThrow({ where: { id: t.id } });
    expect((row.published as ThemeDocument).settings.display_name).toBe('Ada Fashion House');
    const republished = await publishTheme(ctxOf(true), t.id);
    expect(republished.published?.settings.display_name).toBe('Ada Edit');
  });

  it('only one default after setDefault', async () => {
    const a = await blank();
    const b = await blank();
    const draftOnly = await blank();
    expect((await rejection(setDefaultTheme(ctxOf(true), draftOnly.id))).status).toBe(409);
    await publishTheme(ctxOf(true), a.id);
    await publishTheme(ctxOf(true), b.id);
    await setDefaultTheme(ctxOf(true), a.id);
    const d = await setDefaultTheme(ctxOf(true), b.id);
    expect(d.is_default).toBe(true);
    const defaults = await prisma.checkoutTheme.findMany({
      where: { merchantId: merchant.id, isDefault: true },
    });
    expect(defaults.map((x) => x.id)).toEqual([b.id]);
    // Setting it again is a no-op, not a clash.
    await expect(setDefaultTheme(ctxOf(true), b.id)).resolves.toMatchObject({ is_default: true });
  });

  it('delete refused while default or used by a link', async () => {
    const a = await blank();
    await publishTheme(ctxOf(true), a.id);
    await setDefaultTheme(ctxOf(true), a.id);
    const asDefault = await rejection(deleteTheme(ctxOf(), a.id));
    expect(asDefault.code).toBe('THEME_IN_USE');
    expect(asDefault.details).toMatchObject({ reason: 'default' });

    const b = await blank();
    // A live link uses the theme; the request comes from a test-mode context.
    const link = await createRow('PaymentLink', merchant.id, true, { themeId: b.id });
    expect((await getTheme(ctxOf(), b.id)).used_by_links).toBe(1);
    expect(
      (await listThemes(ctxOf(), { limit: 10 })).data.find((x) => x.id === b.id),
    ).toMatchObject({ used_by_links: 1 });
    const used = await rejection(deleteTheme(ctxOf(), b.id));
    expect(used.code).toBe('THEME_IN_USE');
    expect(used.status).toBe(409);
    expect(used.details).toMatchObject({ links: [link.id] });

    await prisma.paymentLink.update({ where: { id: link.id }, data: { themeId: null } });
    await expect(deleteTheme(ctxOf(), b.id)).resolves.toMatchObject({ id: b.id, deleted: true });
    expect((await rejection(getTheme(ctxOf(), b.id))).status).toBe(404);
  });

  it('deleting a theme only a session names succeeds and clears the session theme_id', async () => {
    const t = await blank();
    const session = await createRow('Session', merchant.id, false, { themeId: t.id });
    await expect(deleteTheme(ctxOf(), t.id)).resolves.toMatchObject({ id: t.id, deleted: true });
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id as string } });
    expect(after.themeId).toBeNull();
    expect(after.merchantId).toBe(merchant.id);
  });

  it("another merchant's theme is not found", async () => {
    const other = await createMerchant();
    const t = await createTheme(ctxOf(false, other.id), { name: 'Theirs', from: 'blank' });
    expect((await rejection(getTheme(ctxOf(), t.id))).status).toBe(404);
    expect((await rejection(publishTheme(ctxOf(true), t.id))).status).toBe(404);
    expect((await rejection(deleteTheme(ctxOf(), t.id))).status).toBe(404);
    expect(
      (await rejection(createTheme(ctxOf(), { name: 'C', from: { theme_id: t.id } }))).status,
    ).toBe(404);
  });

  it('validateOnly reports problems and saves nothing', async () => {
    const t = await blank();
    const r = await validateOnly(ctxOf(), { ...t.draft, custom_css: '@import "x.css";' });
    expect(r.valid).toBe(false);
    expect(r.problems[0]?.path).toBe('custom_css');
    expect(await validateOnly(ctxOf(), t.draft)).toEqual({ valid: true, problems: [] });
    expect(await prisma.checkoutTheme.count()).toBe(1);
  });
});
