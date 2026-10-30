// Brand pulled in automatically (spec §7): a new DRAFT theme from a website's brand or from the
// brand a connected WooCommerce store sent. Neither ever publishes anything.
//
// Every fetch goes through `safeFetch` (public https only, 5 s, 2 MB, ≤ 3 redirects). A logo is
// copied into Tendr's storage as a theme asset (`uploadThemeAsset`, which checks and sanitises
// it), never hot-linked. The draft starts from the `minimal` preset and always passes the same
// checks as a manual edit; if nothing usable is found, the merchant gets that preset with their
// name filled in.
import {
  ConnectionBrandSchema,
  contrastRatio,
  THEME_PRESETS,
  type ThemeDocument,
  type ThemeObject,
  type ThemePalette,
} from '@tendr/contracts';
import { Parser } from 'htmlparser2';
import sharp from 'sharp';
import { AppError, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { safeFetch, SafeFetchError } from '../lib/safe-fetch.js';
import { RASTER_MAX_BYTES, uploadThemeAsset, type AssetCtx } from './assets.js';
import { sniffAsset } from './sniff.js';
import { createTheme, updateThemeDraft } from './themes.js';

export type BrandCtx = AssetCtx & { fetch?: typeof safeFetch };

export type ExtractedBrand = {
  name: string | null;
  themeColor: string | null;
  logoCandidates: string[];
};

export const BRAND_FETCH = { timeoutMs: 5_000, maxBytes: RASTER_MAX_BYTES, maxRedirects: 3 };
/** Logo candidates tried, in order, before giving up on a logo. */
const MAX_LOGO_TRIES = 5;
const NAME_MAX = 80;

// ─── colours ────────────────────────────────────────────────────────────────

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const channels = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};

/** WCAG relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb(r, g, b)` as lower-case `#rrggbb`; null otherwise. */
export function normaliseColor(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return `#${[...m[1]!].map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return `#${m[1]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+%?\s*)?\)$/.exec(
    s,
  );
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
    if ([r, g, b].every((v) => v <= 255)) return toHex(r, g, b);
  }
  return null;
}

/** The image's dominant colour (sharp's histogram) as `#rrggbb`. */
export async function dominantColor(buf: Buffer): Promise<string> {
  const { dominant } = await sharp(buf).stats();
  return toHex(dominant.r, dominant.g, dominant.b);
}

/** Too close to white or black to be a brand's accent colour. */
function nearWhiteOrBlack(hex: string): boolean {
  const l = relativeLuminance(hex);
  return l > 0.85 || l < 0.01;
}

/**
 * `color` moved 5% at a time toward black (on a light background) or white (on a dark one)
 * until it has the 3:1 contrast an accent needs against `background`.
 */
function accentFor(color: string, background: string): string {
  const darken = relativeLuminance(background) > 0.5;
  let [r, g, b] = channels(color) as readonly number[] as number[];
  let out = color;
  for (let i = 0; i < 200 && contrastRatio(out, background) < 3; i++) {
    [r, g, b] = [r!, g!, b!].map((c) => (darken ? c * 0.95 : c + (255 - c) * 0.05));
    out = toHex(r!, g!, b!);
  }
  return contrastRatio(out, background) >= 3 ? out : darken ? '#000000' : '#ffffff';
}

// ─── page parsing ───────────────────────────────────────────────────────────

/** The largest dimension a `sizes` attribute names (`any` counts as largest), 0 when none. */
function largestSize(sizes: string | undefined): number {
  let best = 0;
  for (const token of (sizes ?? '').toLowerCase().split(/\s+/)) {
    if (token === 'any') return Number.MAX_SAFE_INTEGER;
    const m = /^(\d+)x(\d+)$/.exec(token);
    if (m) best = Math.max(best, Number(m[1]), Number(m[2]));
  }
  return best;
}

/** `<title>` up to the first ` | ` or ` – `. */
function nameFromTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  const cut = [' | ', ' – '].map((sep) => t.indexOf(sep)).filter((i) => i >= 0);
  return (cut.length > 0 ? t.slice(0, Math.min(...cut)) : t).trim();
}

/**
 * The brand a page declares (pure). Logo candidates, as absolute https URLs in order: apple touch
 * icons (largest `sizes` first), `og:image`, icons (largest first), then `/favicon.ico`. The name
 * is `og:site_name`, else the title up to its first ` | ` or ` – `. `themeColor` is the first
 * `theme-color` as `#rrggbb`.
 */
export function extractBrand(html: string, pageUrl: string): ExtractedBrand {
  const touch: { href: string; size: number }[] = [];
  const icons: { href: string; size: number }[] = [];
  let ogImage: string | null = null;
  let siteName: string | null = null;
  let themeColor: string | null = null;
  let base: string | null = null;
  let title = '';
  let inTitle = false;
  let sawTitle = false;

  const parser = new Parser(
    {
      onopentag(name, a) {
        if (name === 'base' && base === null && a.href) base = a.href;
        if (name === 'title' && !sawTitle) inTitle = true;
        if (name === 'link' && a.href) {
          const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
          const entry = { href: a.href, size: largestSize(a.sizes) };
          if (rel.includes('apple-touch-icon')) touch.push(entry);
          else if (rel.includes('icon')) icons.push(entry);
        }
        if (name === 'meta' && a.content !== undefined) {
          const prop = (a.property ?? '').toLowerCase();
          const metaName = (a.name ?? '').toLowerCase();
          if (prop === 'og:image' && ogImage === null) ogImage = a.content;
          if (prop === 'og:site_name' && siteName === null) siteName = a.content;
          if (metaName === 'theme-color' && themeColor === null) {
            themeColor = normaliseColor(a.content) ?? '';
          }
        }
      },
      ontext(text) {
        if (inTitle) title += text;
      },
      onclosetag(name) {
        if (name === 'title' && inTitle) {
          inTitle = false;
          sawTitle = true;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  let baseUrl: URL;
  try {
    baseUrl = new URL(base ?? pageUrl, pageUrl);
  } catch {
    baseUrl = new URL(pageUrl);
  }
  const absolute = (href: string): string | null => {
    try {
      const u = new URL(href.trim(), baseUrl);
      if (u.protocol !== 'https:') return null;
      u.hash = '';
      return u.toString();
    } catch {
      return null;
    }
  };
  const bySize = (list: { href: string; size: number }[]) =>
    list
      .map((e, i) => ({ ...e, i }))
      .sort((x, y) => y.size - x.size || x.i - y.i)
      .map((e) => e.href);
  const candidates = [
    ...bySize(touch),
    ...(ogImage !== null ? [ogImage] : []),
    ...bySize(icons),
  ].flatMap((h) => absolute(h) ?? []);
  const favicon = absolute(new URL('/favicon.ico', pageUrl).toString());
  if (favicon) candidates.push(favicon);

  const name = (siteName as string | null)?.replace(/\s+/g, ' ').trim() || nameFromTitle(title);
  return {
    name: name || null,
    themeColor: themeColor || null,
    logoCandidates: [...new Set(candidates)],
  };
}

// ─── draft ──────────────────────────────────────────────────────────────────

/**
 * A theme document from a brand: the `minimal` preset with the brand's name (else the store's)
 * and logo. With a colour, the mode is light when the colour's luminance is above 0.4, else dark,
 * and that palette's accent is the colour, moved in 5% steps until it has 3:1 contrast against
 * the background.
 */
export function draftFromBrand(
  merchantName: string,
  brand: { name: string | null; logoAssetId: string | null; color: string | null },
): ThemeDocument {
  const name = brand.name?.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim() || merchantName;
  const doc = THEME_PRESETS.minimal.document(name);
  if (brand.logoAssetId) doc.settings.logo_asset_id = brand.logoAssetId;
  const color = brand.color === null ? null : normaliseColor(brand.color);
  if (color) {
    const mode = relativeLuminance(color) > 0.4 ? 'light' : 'dark';
    const palette = doc.settings.palettes[mode]!;
    const fixed: ThemePalette = { ...palette, accent: accentFor(color, palette.background) };
    doc.settings.mode = mode;
    doc.settings.palettes = { [mode]: fixed };
  }
  return doc;
}

// ─── service ────────────────────────────────────────────────────────────────

const brandFetchFailed = (reason: string, message: string) =>
  new AppError('BRAND_FETCH_FAILED', message, 422, { reason });

type Logo = { assetId: string; raster: Buffer | null };

/**
 * Downloads `url` and stores it as a `logo` asset: null when it can't be fetched or isn't an
 * accepted image (the asset checks decide). `raster` is the bytes when they are a raster image.
 */
async function copyLogo(ctx: BrandCtx, url: string): Promise<Logo | null> {
  const fetch = ctx.fetch ?? safeFetch;
  try {
    const { body } = await fetch(url, { ...BRAND_FETCH, accept: 'image/*' });
    const mime = sniffAsset(body)?.mime;
    if (!mime || mime === 'font/woff2') return null;
    const filename = new URL(url).pathname.split('/').pop() || 'logo';
    const asset = await uploadThemeAsset(ctx, { kind: 'logo', filename, buf: body });
    return { assetId: asset.id, raster: mime === 'image/svg+xml' ? null : body };
  } catch (err) {
    if (
      err instanceof SafeFetchError ||
      (err instanceof AppError && err.code === 'ASSET_INVALID')
    ) {
      return null;
    }
    throw err;
  }
}

async function safeDominant(buf: Buffer | null): Promise<string | null> {
  if (!buf) return null;
  try {
    return await dominantColor(buf);
  } catch {
    return null;
  }
}

/**
 * Creates the draft: first the `minimal` preset (the theme-limit check runs before any logo is
 * stored), then the brand draft over it. Should the brand draft fail the checks, the preset stays.
 */
async function createBrandDraft(
  ctx: BrandCtx,
  themeName: string,
  build: () => Promise<{ name: string | null; logo: Logo | null; color: string | null }>,
): Promise<ThemeObject> {
  const theme = await createTheme(ctx, { name: themeName, from: { preset: 'minimal' } });
  const { name: merchantName } = await ctx.db.merchant.findFirstOrThrow({ select: { name: true } });
  const brand = await build();
  const doc = draftFromBrand(merchantName, {
    name: brand.name,
    logoAssetId: brand.logo?.assetId ?? null,
    color: brand.color,
  });
  try {
    return await updateThemeDraft(ctx, theme.id, { draft: doc });
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'THEME_INVALID')) throw err;
    log('warn', 'brand draft failed theme checks; kept the preset', {
      merchantId: ctx.merchantId,
      themeId: theme.id,
      details: JSON.stringify(err.details),
    });
    return theme;
  }
}

const themeNameFor = (given: string | undefined, fallback: string) =>
  given ?? fallback.slice(0, NAME_MAX);

/**
 * A draft from a website's brand. BRAND_FETCH_FAILED (422, `details.reason`) only when the page
 * itself can't be fetched; a missing logo or colour still gives a draft.
 */
export async function themeFromWebsite(
  ctx: BrandCtx,
  input: { url: string; name?: string },
): Promise<ThemeObject> {
  const fetch = ctx.fetch ?? safeFetch;
  let page;
  try {
    page = await fetch(input.url, { ...BRAND_FETCH, accept: 'text/html' });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      throw brandFetchFailed(err.reason, `The website could not be read: ${err.message}`);
    }
    throw err;
  }
  const brand = extractBrand(page.body.toString('utf8'), page.finalUrl);
  const host = new URL(page.finalUrl).hostname;
  return createBrandDraft(ctx, themeNameFor(input.name, `From ${host}`), async () => {
    let logo: Logo | null = null;
    for (const url of brand.logoCandidates.slice(0, MAX_LOGO_TRIES)) {
      logo = await copyLogo(ctx, url);
      if (logo) break;
    }
    return {
      name: brand.name,
      logo,
      color: brand.themeColor ?? (await safeDominant(logo?.raster ?? null)),
    };
  });
}

/**
 * A draft from the brand a connected store sent (`PUT /v1/connection/brand`); 404 when the
 * connection has none. Logo: `logo_url`, else `icon_url`. Colour: the first palette colour that
 * isn't near-white or near-black, else the logo's dominant colour.
 */
export async function themeFromStore(
  ctx: BrandCtx,
  input: { connection_id: string; name?: string },
): Promise<ThemeObject> {
  const connection = await ctx.db.connection.findFirst({
    where: { id: input.connection_id },
    select: { brand: true },
  });
  const parsed = ConnectionBrandSchema.safeParse(connection?.brand ?? undefined);
  if (!connection || !parsed.success) {
    throw notFound('No brand has been sent for that connection');
  }
  const brand = parsed.data;
  return createBrandDraft(ctx, themeNameFor(input.name, 'From my store'), async () => {
    const logoUrl = brand.logo_url ?? brand.icon_url;
    const logo = logoUrl ? await copyLogo(ctx, logoUrl) : null;
    const fromPalette = brand.palette
      .map((c) => normaliseColor(c))
      .find((c): c is string => c !== null && !nearWhiteOrBlack(c));
    return {
      name: brand.site_name ?? null,
      logo,
      color: fromPalette ?? (await safeDominant(logo?.raster ?? null)),
    };
  });
}
