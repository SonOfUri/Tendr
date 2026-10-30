// The CSS variables a shopper theme sets on the checkout. Theme colours replace the `--tendr-*`
// palette tokens (so every existing `.pay-*` rule follows the theme); Tendr's state colours and
// its own fonts are never set here, so warnings, errors, timers, amounts and addresses keep
// Tendr's look whatever the theme says.
import { useSyncExternalStore } from 'react';
import {
  CURATED_FONTS,
  type ShopperTheme,
  type ThemePalette,
  type ThemeSettings,
} from '@tendr/contracts';

export type Scheme = 'light' | 'dark';

/** The `@font-face` family name an uploaded (asset) brand font is registered under. */
export const ASSET_FONT_FAMILY = 'tdr-brand-font';

const RADIUS: Record<ThemeSettings['corner'], string> = {
  square: '0px',
  soft: '8px',
  round: '16px',
  pill: '999px',
};

const GENERIC: Record<'sans' | 'serif' | 'display' | 'mono', string> = {
  sans: 'system-ui, sans-serif',
  display: 'system-ui, sans-serif',
  serif: 'Georgia, serif',
  mono: 'ui-monospace, monospace',
};

const ON_ACCENT_LIGHT = '#ffffff';
const ON_ACCENT_DARK = '#080d1b';

/** The palette shown for `scheme`: the theme's own one, or its only palette in single-mode. */
export function themePalette(theme: ShopperTheme, scheme: Scheme): ThemePalette {
  const { palettes } = theme.document.settings;
  const other: Scheme = scheme === 'light' ? 'dark' : 'light';
  // The schema guarantees the palette for each mode the theme uses; one of them always exists.
  return (palettes[scheme] ?? palettes[other]) as ThemePalette;
}

/** The scheme a theme is drawn in when the shopper's preference is `preferred`. */
export function themeScheme(mode: ThemeSettings['mode'], preferred: Scheme): Scheme {
  return mode === 'auto' ? preferred : mode;
}

/** The `font-family` value for the theme's brand font, or null when it can't load. */
function brandFontFamily(theme: ShopperTheme): string | null {
  const font = theme.document.settings.font;
  if (font.kind === 'curated') {
    const f = CURATED_FONTS[font.id];
    return f ? `"${f.family}", ${GENERIC[f.category]}` : null;
  }
  return theme.assets[font.asset_id]?.kind === 'font'
    ? `"${ASSET_FONT_FAMILY}", system-ui, sans-serif`
    : null;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** White labels on the accent unless they would be hard to read; then Tendr navy. */
function onAccent(accent: string): string {
  const contrastWithWhite = 1.05 / (luminance(accent) + 0.05);
  return contrastWithWhite >= 3 ? ON_ACCENT_LIGHT : ON_ACCENT_DARK;
}

/**
 * The variables for `theme` drawn in `scheme`. Never sets `--tendr-danger`, `--tendr-warning`,
 * `--tendr-success`, `--tendr-font-sans`, `--tendr-font-display` or `--tendr-font-mono`.
 * `--theme-font-curated` is set only for a curated font: it's the one font the sealed payment
 * block may use (headings and the Pay button label only).
 */
export function themeVars(theme: ShopperTheme, scheme: Scheme): Record<string, string> {
  const p = themePalette(theme, scheme);
  const brandFont = brandFontFamily(theme);
  const vars: Record<string, string> = {
    '--theme-accent': p.accent,
    '--theme-bg': p.background,
    '--theme-surface': p.surface,
    '--theme-text': p.text,
    '--theme-on-accent': onAccent(p.accent),
    '--theme-radius': RADIUS[theme.document.settings.corner] ?? RADIUS.soft,
    '--theme-font': brandFont ?? 'var(--tendr-font-sans)',
    '--tendr-indigo': p.accent,
    '--tendr-navy': p.background,
    '--tendr-surface': p.surface,
    '--tendr-white': p.text,
  };
  if (theme.document.settings.font.kind === 'curated' && brandFont) {
    vars['--theme-font-curated'] = brandFont;
  }
  return vars;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function preferredScheme(): Scheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * The scheme to draw a theme in: its fixed mode, or with `auto` the shopper's
 * `prefers-color-scheme` (dark during server rendering, matching Tendr's default look).
 */
export function useScheme(mode: ThemeSettings['mode']): Scheme {
  const preferred = useSyncExternalStore(subscribe, preferredScheme, () => 'dark' as const);
  return themeScheme(mode, preferred);
}
