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
