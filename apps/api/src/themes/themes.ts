// Checkout themes, merchant side: list, read, create (blank, from a preset or a copy), edit the
// draft, publish, make default, delete, and validate without saving.
//
// Themes are shared between test and live mode (no `livemode` column); every query goes through
// the scoped client, so a merchant only ever sees its own themes. Edits change the draft only;
// shoppers see `published`, which changes only on publish. Both carry the scoped CSS the validator
// produced (`draftCss` / `publishedCss`), never the merchant's raw `custom_css`.
import { Prisma, type CheckoutTheme } from '@prisma/client';
import {
  THEME_MAX_PER_MERCHANT,
  THEME_PRESETS,
  TENDR_DEFAULT_THEME,
  type ThemeCreate,
  type ThemeDocument,
  type ThemeObject,
} from '@tendr/contracts';
import type { ScopedDb } from '../db/scoped.js';
import { env } from '../env.js';
import { AppError, invalidState, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import {
  validateThemeDocument,
  type ThemeProblem,
  type ThemeValidationContext,
} from './validate.js';

export type ThemeCtx = { merchantId: string; db: ScopedDb };

/** A draft edit: a new name, a new draft document (checked here, not by the route), or both. */
export type ThemeDraftInput = { name?: string; draft?: unknown };

const themeNotFound = () => notFound('No theme with that id');

const themeInvalid = (problems: ThemeProblem[]) =>
  new AppError('THEME_INVALID', 'The theme has problems; see details.problems', 400, {
    problems,
  });

const json = (doc: ThemeDocument) => doc as unknown as Prisma.InputJsonValue;

/** The merchant's uploaded assets and the asset origin, for `validateThemeDocument`. */
async function validationContext(ctx: ThemeCtx): Promise<ThemeValidationContext> {
  const assets = await ctx.db.themeAsset.findMany({ select: { id: true, kind: true } });
  return {
    assetOrigin: env().TENDR_ASSET_ORIGIN,
    assetIds: new Set(assets.map((a) => a.id)),
    assetKinds: new Map(assets.map((a) => [a.id, a.kind])),
  };
}

/** The checked, normalised document and its scoped CSS; THEME_INVALID with problems otherwise. */
async function checked(
  ctx: ThemeCtx,
  doc: unknown,
): Promise<{ document: ThemeDocument; css: { css: string; hash: string } | null }> {
  const r = validateThemeDocument(doc, await validationContext(ctx));
  if (!r.ok) throw themeInvalid(r.problems);
  return { document: r.document, css: r.css };
}

/**
 * Payment links (either mode) that name each theme. Links are per-mode and the scoped client sees
 * one mode, so this counts through the unscoped client, filtered to the merchant.
 */
async function linksUsing(merchantId: string, themeIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(themeIds.map((id) => [id, []]));
  if (themeIds.length === 0) return out;
  const rows = await prisma.$queryRaw<{ id: string; theme_id: string }[]>`
    SELECT id, theme_id FROM payment_links
    WHERE merchant_id = ${merchantId} AND theme_id = ANY(${themeIds}::text[])
    ORDER BY id`;
  for (const r of rows) out.get(r.theme_id)?.push(r.id);
  return out;
}

export function toThemeObject(row: CheckoutTheme, usedByLinks: number): ThemeObject {
  return {
    id: row.id,
    object: 'theme',
    name: row.name,
    is_default: row.isDefault,
    version: row.version,
    status: row.status,
    draft: row.draft as unknown as ThemeDocument,
    published: (row.published ?? null) as unknown as ThemeDocument | null,
    published_at: row.publishedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    used_by_links: usedByLinks,
  };
}

async function objectOf(ctx: ThemeCtx, row: CheckoutTheme): Promise<ThemeObject> {
  const links = await linksUsing(ctx.merchantId, [row.id]);
  return toThemeObject(row, links.get(row.id)!.length);
}

async function load(ctx: ThemeCtx, id: string): Promise<CheckoutTheme> {
  const row = await ctx.db.checkoutTheme.findFirst({ where: { id } });
  if (!row) throw themeNotFound();
  return row;
}

export async function listThemes(
  ctx: ThemeCtx,
  q: { limit: number; starting_after?: string },
): Promise<{ data: ThemeObject[]; has_more: boolean }> {
  const rows = await ctx.db.checkoutTheme.findMany({
    where: q.starting_after ? { id: { lt: q.starting_after } } : {},
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const links = await linksUsing(
    ctx.merchantId,
    page.map((r) => r.id),
  );
  return {
    data: page.map((r) => toThemeObject(r, links.get(r.id)!.length)),
    has_more: rows.length > q.limit,
  };
}

export async function getTheme(ctx: ThemeCtx, id: string): Promise<ThemeObject> {
  return objectOf(ctx, await load(ctx, id));
}

/** Every preset, filled in with the store's name. */
export async function listPresets(ctx: ThemeCtx) {
  const { name } = await ctx.db.merchant.findFirstOrThrow({ select: { name: true } });
  return {
    data: Object.entries(THEME_PRESETS).map(([id, p]) => ({
      id,
      label: p.label,
      description: p.description,
      document: p.document(name),
    })),
  };
}

/**
 * A new draft theme: from a preset (filled in with the store's name), blank (the Tendr default) or
 * a copy of another theme's draft. THEME_LIMIT (409) once the store has 20 themes.
 */
export async function createTheme(ctx: ThemeCtx, input: ThemeCreate): Promise<ThemeObject> {
  if ((await ctx.db.checkoutTheme.count()) >= THEME_MAX_PER_MERCHANT) {
    throw new AppError(
      'THEME_LIMIT',
      `A store can have at most ${THEME_MAX_PER_MERCHANT} themes; delete one first`,
      409,
    );
  }
  let source: unknown;
  if (input.from === 'blank' || 'preset' in input.from) {
    const { name } = await ctx.db.merchant.findFirstOrThrow({ select: { name: true } });
    source =
      input.from === 'blank'
        ? TENDR_DEFAULT_THEME(name)
        : THEME_PRESETS[input.from.preset].document(name);
  } else {
    source = (await load(ctx, input.from.theme_id)).draft;
  }
  return createThemeFromDocument(ctx, { name: input.name, document: source });
}

/** A new validated draft only. Serializes the theme cap across regular and AI creation. */
export async function createThemeFromDocument(
  ctx: ThemeCtx,
  input: { name: string; document: unknown },
): Promise<ThemeObject> {
  const { document, css } = await checked(ctx, input.document);
  const row = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${ctx.merchantId} FOR UPDATE`;
    if (
      (await tx.checkoutTheme.count({ where: { merchantId: ctx.merchantId } })) >=
      THEME_MAX_PER_MERCHANT
    )
      throw new AppError(
        'THEME_LIMIT',
        `A store can have at most ${THEME_MAX_PER_MERCHANT} themes; delete one first`,
        409,
      );
    return tx.checkoutTheme.create({
      data: {
        id: newId('thm'),
        merchantId: ctx.merchantId,
        name: input.name,
        status: 'draft',
        draft: json(document),
        draftCss: css?.css ?? null,
      },
    });
  });
  return toThemeObject(row, 0);
}

/** Renames the theme and/or replaces its draft. The published version is untouched. */
export async function updateThemeDraft(
  ctx: ThemeCtx,
  id: string,
  input: ThemeDraftInput,
): Promise<ThemeObject> {
  await load(ctx, id);
  const draft = input.draft === undefined ? undefined : await checked(ctx, input.draft);
  const row = await ctx.db.checkoutTheme.update({
    where: { id },
    data: {
      name: input.name,
      ...(draft ? { draft: json(draft.document), draftCss: draft.css?.css ?? null } : {}),
    },
  });
  return objectOf(ctx, row);
}

/**
 * Publishes the draft: re-checks it (an asset it names may have gone), then copies it and its
 * scoped CSS to the published version and bumps `version`. Shoppers see it on their next load.
 */
export async function publishTheme(ctx: ThemeCtx, id: string): Promise<ThemeObject> {
  const current = await load(ctx, id);
  const { document, css } = await checked(ctx, current.draft);
  const row = await ctx.db.checkoutTheme.update({
    where: { id },
    data: {
      draft: json(document),
      draftCss: css?.css ?? null,
      published: json(document),
      publishedCss: css?.css ?? null,
      cssHash: css?.hash ?? null,
      status: 'published',
      version: { increment: 1 },
      publishedAt: new Date(),
    },
  });
  return objectOf(ctx, row);
}

/** Makes a published theme the store's default, in one transaction with clearing the old one. */
export async function setDefaultTheme(ctx: ThemeCtx, id: string): Promise<ThemeObject> {
  const current = await load(ctx, id);
  if (current.status !== 'published' || current.published === null) {
    throw invalidState('Publish the theme before making it the default');
  }
  const row = await ctx.db.$transaction(async (tx) => {
    await tx.checkoutTheme.updateMany({
      where: { isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
    return tx.checkoutTheme.update({ where: { id }, data: { isDefault: true } });
  });
  return objectOf(ctx, row);
}

const inUse = (message: string, details: unknown) =>
  new AppError('THEME_IN_USE', message, 409, details);

/**
 * Deletes a theme. THEME_IN_USE (409) while it is the default (`details.reason: 'default'`) or any
 * payment link in either mode names it (`details.links`: the link ids).
 */
export async function deleteTheme(
  ctx: ThemeCtx,
  id: string,
): Promise<{ id: string; object: 'theme'; deleted: true }> {
  const current = await load(ctx, id);
  if (current.isDefault) {
    throw inUse('The default theme cannot be deleted; make another theme the default first', {
      reason: 'default',
    });
  }
  const links = (await linksUsing(ctx.merchantId, [id])).get(id)!;
  if (links.length > 0) {
    throw inUse('Payment links use this theme; point them at another theme first', {
      reason: 'links',
      links,
    });
  }
  try {
    await ctx.db.checkoutTheme.delete({ where: { id } });
  } catch (err) {
    // Another row still names the theme (an asset or a link added since the check); sessions do
    // not, their FK clears theme_id.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw inUse('Something still uses this theme', { reason: 'referenced' });
    }
    throw err;
  }
  return { id, object: 'theme', deleted: true };
}

/** The checks a save would run, without saving: `problems` is empty when the document is valid. */
export async function validateOnly(
  ctx: ThemeCtx,
  doc: unknown,
): Promise<{ valid: boolean; problems: ThemeProblem[] }> {
  const r = validateThemeDocument(doc, await validationContext(ctx));
  return r.ok ? { valid: true, problems: [] } : { valid: false, problems: r.problems };
}
