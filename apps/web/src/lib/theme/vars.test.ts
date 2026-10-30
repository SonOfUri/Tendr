import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CURATED_FONTS,
  TENDR_DEFAULT_THEME,
  type ShopperTheme,
  type ThemeDocument,
} from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import { themeDataScheme, themeVars } from './vars';

function shopperTheme(
  patch: Partial<ThemeDocument['settings']> = {},
  assets: ShopperTheme['assets'] = {},
): ShopperTheme {
  const document = TENDR_DEFAULT_THEME('Lagos Leather Co.');
  return {
    id: 'thm_1',
    version: 1,
    document: { ...document, settings: { ...document.settings, ...patch } },
    rendered: {},
    assets,
    css: null,
    payee: 'Lagos Leather Co.',
    trading_as: null,
  };
}

const FONT_ASSET = {
  url: 'https://assets.example/f.woff2',
  kind: 'font',
  mime: 'font/woff2',
} as const;

describe('themeVars', () => {
  it('never sets state colours or tendr fonts', () => {
    const themes = [
      shopperTheme(),
      shopperTheme({ font: { kind: 'asset', asset_id: 'fnt' } }, { fnt: FONT_ASSET }),
      shopperTheme({ mode: 'auto' }),
    ];
    for (const theme of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const vars = themeVars(theme, scheme);
        for (const forbidden of [
          '--tendr-danger',
          '--tendr-warning',
          '--tendr-success',
          '--tendr-font-sans',
          '--tendr-font-mono',
          '--tendr-font-display',
        ]) {
          expect(vars).not.toHaveProperty(forbidden);
        }
        expect(vars['--theme-font']).toBeTruthy();
        expect(vars['--tendr-indigo']).toBe(vars['--theme-accent']);
        expect(vars['--tendr-navy']).toBe(vars['--theme-bg']);
        expect(vars['--tendr-surface']).toBe(vars['--theme-surface']);
        expect(vars['--tendr-white']).toBe(vars['--theme-text']);
      }
    }
  });

  it('only a curated font reaches the sealed block', () => {
    const curated = themeVars(shopperTheme({ font: { kind: 'curated', id: 'lora' } }), 'dark');
    expect(curated['--theme-font-curated']).toContain('"Lora"');
    const asset = themeVars(
      shopperTheme({ font: { kind: 'asset', asset_id: 'fnt' } }, { fnt: FONT_ASSET }),
      'dark',
    );
    expect(asset).not.toHaveProperty('--theme-font-curated');
    expect(asset['--theme-font']).toContain('tdr-brand-font');
    // A deleted font asset falls back to Tendr's font instead of naming a face that never loads.
    const missing = themeVars(shopperTheme({ font: { kind: 'asset', asset_id: 'gone' } }), 'dark');
    expect(missing['--theme-font']).not.toContain('tdr-brand-font');
  });

  it('maps corner shapes', () => {
    const radius = (corner: ThemeDocument['settings']['corner']) =>
      themeVars(shopperTheme({ corner }), 'dark')['--theme-radius'];
    expect(radius('square')).toBe('0px');
    expect(radius('soft')).toBe('8px');
    expect(radius('round')).toBe('16px');
    expect(radius('pill')).toBe('999px');
  });

  it('auto mode needs both palettes', () => {
    const theme = shopperTheme({ mode: 'auto' });
    const { light, dark } = theme.document.settings.palettes;
    expect(themeVars(theme, 'light')['--theme-bg']).toBe(light?.background);
    expect(themeVars(theme, 'dark')['--theme-bg']).toBe(dark?.background);
    expect(themeVars(theme, 'light')['--theme-bg']).not.toBe(
      themeVars(theme, 'dark')['--theme-bg'],
    );

    // A single-mode theme keeps its one palette whatever scheme is asked for.
    const darkOnly = shopperTheme({
      mode: 'dark',
      palettes: {
        dark: { accent: '#9b5cff', background: '#0d0b1a', surface: '#171329', text: '#f4f1ff' },
      },
    });
    expect(themeVars(darkOnly, 'light')['--theme-bg']).toBe('#0d0b1a');
  });

  it('picks a readable label colour for the accent', () => {
    const vars = themeVars(
      shopperTheme({
        mode: 'light',
        palettes: {
          light: { accent: '#f5d90a', background: '#ffffff', surface: '#f7f7f7', text: '#111111' },
        },
      }),
      'light',
    );
    expect(vars['--theme-on-accent']).toBe('#080d1b');
    expect(themeVars(shopperTheme(), 'dark')['--theme-on-accent']).toBe('#ffffff');
  });

  it('copy-fonts ships every curated font', () => {
    const script = readFileSync(resolve(__dirname, '../../../scripts/copy-fonts.mjs'), 'utf8');
    for (const id of Object.keys(CURATED_FONTS)) {
      expect(script, id).toMatch(new RegExp(`(^|\\s)'?${id}'?: \\[`, 'm'));
    }
  });

  it('data-scheme follows the shown palette background, not the mode', () => {
    expect(themeDataScheme(shopperTheme(), 'dark')).toBe('dark');
    // A `dark`-mode theme whose palette is white still gets Tendr's light state colours.
    const whiteDark = shopperTheme({
      mode: 'dark',
      palettes: {
        dark: { accent: '#4035f5', background: '#ffffff', surface: '#f3f4fb', text: '#080d1b' },
      },
    });
    expect(themeDataScheme(whiteDark, 'dark')).toBe('light');
    expect(themeDataScheme(whiteDark, 'light')).toBe('light');
    // A `light`-mode theme on near-black is dark.
    const blackLight = shopperTheme({
      mode: 'light',
      palettes: {
        light: { accent: '#9b5cff', background: '#111111', surface: '#1b1b1b', text: '#ffffff' },
      },
    });
    expect(themeDataScheme(blackLight, 'light')).toBe('dark');
    // `auto` picks the palette by preference, then reads that palette's background.
    const auto = shopperTheme({ mode: 'auto' });
    expect(themeDataScheme(auto, 'light')).toBe('light');
    expect(themeDataScheme(auto, 'dark')).toBe('dark');
    // Mid-grey sits on the 0.4 luminance boundary: #aaaaaa (≈0.40) is light, #a0a0a0 (≈0.35) dark.
    const grey = (background: string) =>
      themeDataScheme(
        shopperTheme({
          mode: 'dark',
          palettes: {
            dark: { accent: '#000000', background, surface: background, text: '#000000' },
          },
        }),
        'dark',
      );
    expect(grey('#aaaaaa')).toBe('light');
    expect(grey('#a0a0a0')).toBe('dark');
  });

  it('keeps the colour-scheme hook out of the server-importable module', () => {
    const vars = readFileSync(resolve(__dirname, 'vars.ts'), 'utf8');
    expect(vars).not.toMatch(/from 'react'/);
    const hook = readFileSync(resolve(__dirname, 'use-scheme.ts'), 'utf8');
    expect(hook.startsWith("'use client';")).toBe(true);
  });
});
