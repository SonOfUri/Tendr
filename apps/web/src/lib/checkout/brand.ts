// The store name and logo a shopper page shows, read from its resolved theme. The payee (the
// account's legal name) is `theme.payee` / `merchant.name`; this is the brand the theme sets.
import { TENDR_DEFAULT_THEME, type ShopperTheme } from '@tendr/contracts';

/** The store name the theme shows (`settings.display_name`). */
export function themeDisplayName(theme: ShopperTheme): string {
  return theme.document.settings.display_name;
}

/** The theme's logo URL (`settings.logo_asset_id` → `assets[id].url`), or null when it has none. */
export function themeLogoUrl(theme: ShopperTheme): string | null {
  const id = theme.document.settings.logo_asset_id;
  return id ? (theme.assets[id]?.url ?? null) : null;
}

const LOGO_ID = 'logo';

/**
 * The Tendr default theme for a store, as the API resolves it when the store has no theme, with
 * `logoUrl` as its logo when given. For pages built without the API (the demo) and tests.
 */
export function tendrShopperTheme(name: string, logoUrl: string | null = null): ShopperTheme {
  const document = TENDR_DEFAULT_THEME(name);
  return {
    id: null,
    version: 0,
    document: logoUrl
      ? { ...document, settings: { ...document.settings, logo_asset_id: LOGO_ID } }
      : document,
    rendered: {},
    assets: logoUrl ? { [LOGO_ID]: { url: logoUrl, kind: 'logo', mime: 'image/png' } } : {},
    css: null,
    payee: name,
    trading_as: null,
  };
}
