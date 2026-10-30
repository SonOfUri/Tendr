import type { ShopperTheme } from '@tendr/contracts';

/** A URL safe to place inside a quoted CSS `url("…")`. */
export const CSS_SAFE_URL = /^https:\/\/[^\s"'\\()<>]+$/;

/**
 * The URL of an image asset a block names, or null when the asset is gone (deleted after the
 * theme was saved) or isn't an image — the block then shows no image rather than failing.
 */
export function imageUrl(theme: ShopperTheme, assetId: string | undefined): string | null {
  if (!assetId) return null;
  const asset = theme.assets[assetId];
  return asset && asset.kind !== 'font' ? asset.url : null;
}

/** `background-image` for an asset, or undefined when the asset is missing or its URL is odd. */
export function backgroundImage(
  theme: ShopperTheme,
  assetId: string | undefined,
): string | undefined {
  const url = imageUrl(theme, assetId);
  return url && CSS_SAFE_URL.test(url) ? `url("${url}")` : undefined;
}
