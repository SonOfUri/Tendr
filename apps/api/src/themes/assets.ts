// Theme assets (spec §10): logos, images and fonts a merchant uploads for its checkout themes.
//
// An upload is judged by its bytes, never its name: `sniffAsset` decides the type, each kind takes
// only its own types and size (logo/image: PNG, JPEG, WebP, GIF up to 2 MB or SVG up to 512 KB;
// font: WOFF2 up to 500 KB), rasters must decode and be at most 8000×8000, and SVG is rebuilt
// from a strict allowlist so it can never run script or load anything from outside itself. The
// stored bytes go to the object store at `assets/<merchantId>/<assetId>.<ext>` and are served from
// TENDR_ASSET_ORIGIN. Assets are shared by both modes (no `livemode`).
import type { ThemeAsset } from '@prisma/client';
import {
  THEME_ASSET_MAX_PER_MERCHANT,
  type ThemeAssetKind,
  type ThemeAssetObject,
} from '@tendr/contracts';
import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import sharp, { type Metadata } from 'sharp';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { assetUrl, type ObjectStore } from '../storage/object-store.js';
import { sniffAsset, type AssetMime } from './sniff.js';
import type { ThemeCtx } from './themes.js';

export type AssetCtx = ThemeCtx & { store: ObjectStore };

export const RASTER_MAX_BYTES = 2 * 1024 * 1024;
export const SVG_MAX_BYTES = 512 * 1024;
export const FONT_MAX_BYTES = 500 * 1024;
/** Largest width or height of a raster image, in pixels. */
export const RASTER_MAX_DIMENSION = 8000;

const RASTER: readonly AssetMime[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ACCEPTS: Record<ThemeAssetKind, readonly AssetMime[]> = {
  logo: [...RASTER, 'image/svg+xml'],
  image: [...RASTER, 'image/svg+xml'],
  font: ['font/woff2'],
};
const EXTENSION: Record<AssetMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'font/woff2': 'woff2',
};
const SHARP_FORMAT: Partial<Record<AssetMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const invalid = (message: string) => new AppError('ASSET_INVALID', message, 400);

const KIND_TYPES: Record<ThemeAssetKind, string> = {
  logo: 'PNG, JPEG, WebP, GIF or SVG',
  image: 'PNG, JPEG, WebP, GIF or SVG',
  font: 'WOFF2',
};

// ─── SVG ────────────────────────────────────────────────────────────────────

// prettier-ignore
const SVG_TAGS = [
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'pattern', 'marker',
];

// prettier-ignore
const SVG_ATTRIBUTES = [
  'xmlns', 'xmlns:xlink', 'version', 'id', 'class', 'viewBox', 'preserveAspectRatio', 'width',
  'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd',
  'points', 'dx', 'dy', 'rotate', 'transform', 'href', 'xlink:href', 'fill', 'fill-opacity',
  'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color', 'display',
  'visibility', 'overflow', 'clip-path', 'clip-rule', 'mask', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'clipPathUnits',
  'maskUnits', 'maskContentUnits', 'patternUnits', 'patternContentUnits', 'patternTransform',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'marker-start',
  'marker-mid', 'marker-end', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'letter-spacing', 'word-spacing', 'vector-effect',
  'shape-rendering', 'xml:space', 'role', 'aria-label', 'aria-hidden',
];

/** A `url(...)` that points anywhere but a fragment of this document. */
const EXTERNAL_URL = /url\s*\((?!\s*['"]?\s*#)/i;

/**
 * Rebuilds an SVG from the allowlist: no script or style (dropped with their contents), no event
 * handlers, links only to fragments of the document itself, no `url()` to anything outside it.
 * `foreignObject` (HTML inside SVG) is refused outright rather than stripped.
 */
function sanitizeSvg(buf: Buffer): Buffer {
  let foreign = false;
  const out = sanitizeHtml(buf.toString('utf8'), {
    parser: { xmlMode: true },
    allowedTags: SVG_TAGS,
    allowedAttributes: { '*': SVG_ATTRIBUTES },
    allowedSchemes: [],
    allowedSchemesAppliedToAttributes: [],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
    onOpenTag: (name) => {
      if (name.toLowerCase() === 'foreignobject') foreign = true;
    },
    transformTags: {
      '*': (tagName, attribs) => {
        const kept: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) {
          const isLink = name === 'href' || name === 'xlink:href';
          if (isLink && !value.trim().startsWith('#')) continue;
          if (EXTERNAL_URL.test(value)) continue;
          kept[name] = value;
        }
        return { tagName, attribs: kept };
      },
    },
  });
  if (foreign) throw invalid("SVG files can't contain foreignObject (HTML inside the image)");
  const clean = Buffer.from(out.trim(), 'utf8');
  if (sniffAsset(clean)?.mime !== 'image/svg+xml') {
    throw invalid('The SVG has no drawing left after removing unsafe content');
  }
  return clean;
}

// ─── raster ─────────────────────────────────────────────────────────────────

/** Rasters must be what their bytes say, decode completely and fit 8000×8000. */
async function checkRaster(buf: Buffer, mime: AssetMime): Promise<void> {
  const unreadable = () => invalid('The image could not be read; it may be damaged');
  const limits = {
    limitInputPixels: RASTER_MAX_DIMENSION * RASTER_MAX_DIMENSION,
    failOn: 'error' as const,
  };
  let meta: Metadata;
  try {
    meta = await sharp(buf, limits).metadata();
  } catch {
    throw unreadable();
  }
  if (meta.format !== SHARP_FORMAT[mime] || !meta.width || !meta.height) throw unreadable();
  if (meta.width > RASTER_MAX_DIMENSION || meta.height > RASTER_MAX_DIMENSION) {
    throw invalid(
      `Images can be at most ${RASTER_MAX_DIMENSION}×${RASTER_MAX_DIMENSION} pixels ` +
        `(this one is ${meta.width}×${meta.height})`,
    );
  }
  try {
    // A full decode (shrunk as it goes, so memory stays small) proves the pixel data is intact.
    await sharp(buf, limits).resize(64, 64, { fit: 'inside' }).raw().toBuffer();
  } catch {
    throw unreadable();
  }
}

// ─── service ────────────────────────────────────────────────────────────────

export function toThemeAssetObject(row: ThemeAsset): ThemeAssetObject {
  return {
    id: row.id,
    object: 'theme_asset',
    kind: row.kind,
    url: row.url,
    mime: row.mime,
    size_bytes: row.sizeBytes,
    checksum: row.checksum,
    created_at: row.createdAt.toISOString(),
  };
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${n / (1024 * 1024)} MB` : `${n / 1024} KB`);

/** The bytes to store for an upload of `kind`, after every check; ASSET_INVALID otherwise. */
async function prepare(
  kind: ThemeAssetKind,
  buf: Buffer,
): Promise<{ mime: AssetMime; body: Buffer }> {
  const sniffed = sniffAsset(buf);
  if (!sniffed || !ACCEPTS[kind].includes(sniffed.mime)) {
    throw invalid(`A ${kind} must be a ${KIND_TYPES[kind]} file`);
  }
  const { mime } = sniffed;
  if (mime === 'font/woff2') {
    if (buf.length > FONT_MAX_BYTES) throw invalid(`Fonts can be at most ${kb(FONT_MAX_BYTES)}`);
    return { mime, body: buf };
  }
  if (mime === 'image/svg+xml') {
    if (buf.length > SVG_MAX_BYTES) throw invalid(`SVG files can be at most ${kb(SVG_MAX_BYTES)}`);
    return { mime, body: sanitizeSvg(buf) };
  }
  if (buf.length > RASTER_MAX_BYTES) throw invalid(`Images can be at most ${kb(RASTER_MAX_BYTES)}`);
  await checkRaster(buf, mime);
  return { mime, body: buf };
}

/**
 * Checks and stores an upload. ASSET_INVALID (400) for a wrong type, an oversized or damaged
 * file, or once the store has 200 assets. `filename` is informational only.
 */
export async function uploadThemeAsset(
  ctx: AssetCtx,
  input: { kind: ThemeAssetKind; filename: string; buf: Buffer },
): Promise<ThemeAssetObject> {
  if ((await ctx.db.themeAsset.count()) >= THEME_ASSET_MAX_PER_MERCHANT) {
    throw invalid(
      `A store can have at most ${THEME_ASSET_MAX_PER_MERCHANT} assets; delete one first`,
    );
  }
  const { mime, body } = await prepare(input.kind, input.buf);
  const id = newId('tasset');
  const key = `assets/${ctx.merchantId}/${id}.${EXTENSION[mime]}`;
  await ctx.store.put(key, body, mime);
  try {
    const row = await ctx.db.themeAsset.create({
      data: {
        id,
        merchantId: ctx.merchantId,
        kind: input.kind,
        key,
        url: assetUrl(key),
        mime,
        sizeBytes: body.length,
        checksum: createHash('sha256').update(body).digest('hex'),
      },
    });
    return toThemeAssetObject(row);
  } catch (err) {
    await removeObject(ctx, key);
    throw err;
  }
}

/** Every asset the store has (at most 200), newest first. */
export async function listThemeAssets(ctx: AssetCtx): Promise<{ data: ThemeAssetObject[] }> {
  const rows = await ctx.db.themeAsset.findMany({ orderBy: { id: 'desc' } });
  return { data: rows.map(toThemeAssetObject) };
}

/**
 * Deletes an asset. ASSET_IN_USE (409, `details.themes`: the theme ids) while any theme's draft
 * or published version names it — by id, or by URL in custom CSS or HTML (the key holds the id).
 */
export async function deleteThemeAsset(
  ctx: AssetCtx,
  id: string,
): Promise<{ id: string; object: 'theme_asset'; deleted: true }> {
  const row = await ctx.db.themeAsset.findFirst({ where: { id } });
  if (!row) throw notFound('No theme asset with that id');
  // A store has at most 20 themes; read as raw JSON so a damaged document is still searched.
  const themes = await ctx.db.checkoutTheme.findMany({
    select: { id: true, draft: true, published: true },
    orderBy: { id: 'asc' },
  });
  const using = themes
    .filter((t) => [t.draft, t.published].some((doc) => JSON.stringify(doc ?? null).includes(id)))
    .map((t) => t.id);
  if (using.length > 0) {
    throw new AppError(
      'ASSET_IN_USE',
      'Themes use this asset; remove it from their draft and published versions first',
      409,
      { themes: using },
    );
  }
  await ctx.db.themeAsset.delete({ where: { id } });
  await removeObject(ctx, row.key);
  return { id, object: 'theme_asset', deleted: true };
}

/** Best effort: a stored object nothing points at is harmless, so a failure is only logged. */
async function removeObject(ctx: AssetCtx, key: string): Promise<void> {
  try {
    await ctx.store.delete(key);
  } catch (err) {
    log('warn', 'theme asset object delete failed', { key, err: String(err) });
  }
}
