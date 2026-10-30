// The theme's stylesheet: the brand font's `@font-face`, the theme variables on `.tdr-theme`, and
// the merchant CSS. Only `theme.css` is ever injected — the API has validated it and scoped every
// selector to `.tdr-scope …`. `document.custom_css` (the unvalidated source) is never rendered.
import { CURATED_FONTS, type ShopperTheme } from '@tendr/contracts';
import { ASSET_FONT_FAMILY, themeVars, type Scheme } from '@/lib/theme/vars';
import { CSS_SAFE_URL } from './blocks/assets';

function fontFace(theme: ShopperTheme): string {
  const font = theme.document.settings.font;
  if (font.kind === 'curated') {
    const f = CURATED_FONTS[font.id];
    if (!f) return '';
    // `/fonts/<id>.woff2` is copied from @fontsource by scripts/copy-fonts.mjs.
    return `@font-face { font-family: "${f.family}"; src: url("/fonts/${font.id}.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }`;
  }
  const asset = theme.assets[font.asset_id];
  if (!asset || asset.kind !== 'font' || !CSS_SAFE_URL.test(asset.url)) return '';
  return `@font-face { font-family: "${ASSET_FONT_FAMILY}"; src: url("${asset.url}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }`;
}

/** Keeps a stylesheet from closing its own `<style>` element. */
function inStyleElement(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

export function ThemeStyles({ theme, scheme }: { theme: ShopperTheme; scheme: Scheme }) {
  const vars = Object.entries(themeVars(theme, scheme))
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  const tendr = `${fontFace(theme)}\n.tdr-theme { ${vars} }`;
  return (
    <>
      <style data-tendr-theme="" dangerouslySetInnerHTML={{ __html: inStyleElement(tendr) }} />
      {theme.css ? (
        <style
          data-tendr-theme-css=""
          dangerouslySetInnerHTML={{ __html: inStyleElement(theme.css) }}
        />
      ) : null}
    </>
  );
}
