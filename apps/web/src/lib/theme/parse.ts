// Reads the theme a shopper view carries. A missing, invalid or unparsable theme never breaks the
// page: it renders the Tendr default look and the shopper can still pay (spec §8).
import { ShopperThemeSchema, type ShopperTheme } from '@tendr/contracts';
import { tendrShopperTheme } from '@/lib/checkout/brand';

/** The validated theme, or the Tendr default theme for `merchantName` (logged once per call). */
export function parseShopperTheme(raw: unknown, merchantName: string): ShopperTheme {
  const parsed = ShopperThemeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn('[tendr] theme failed to parse; showing the Tendr default theme', {
    issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
  });
  return tendrShopperTheme(merchantName);
}

const CACHE_MAX = 8;
const cache = new Map<string, ShopperTheme>();

/** What identifies a theme the API returned: its id and version (a publish bumps the version). */
function cacheKey(raw: unknown, merchantName: string): string {
  const r = raw && typeof raw === 'object' ? (raw as { id?: unknown; version?: unknown }) : {};
  return JSON.stringify([r.id ?? null, r.version ?? null, merchantName]);
}

/**
 * `parseShopperTheme`, remembered per theme id and version: the checkout polls every few seconds,
 * and a broken theme is parsed (and warned about) once, not on every poll. A republished theme has
 * a new version, so the shopper's next poll shows the new look.
 */
export function parseShopperThemeCached(raw: unknown, merchantName: string): ShopperTheme {
  const key = cacheKey(raw, merchantName);
  const hit = cache.get(key);
  if (hit) return hit;
  const theme = parseShopperTheme(raw, merchantName);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, theme);
  return theme;
}
