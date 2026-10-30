import { contrastRatio, THEME_PRESETS } from '@tendr/contracts';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dominantColor, draftFromBrand, extractBrand } from './brand.js';
import { validateThemeDocument } from './validate.js';

const PAGE = 'https://shop.example/en/home';

const html = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;

describe('extractBrand', () => {
  it('extractBrand picks apple-touch-icon over favicon', () => {
    const b = extractBrand(
      html(`
        <title>Acme Socks | Warm feet since 1999</title>
        <link rel="icon" href="/icon-32.png" sizes="32x32">
        <link rel="shortcut icon" href="/icon-192.png" sizes="192x192">
        <link rel="apple-touch-icon" href="/touch-120.png" sizes="120x120">
        <link rel="apple-touch-icon" href="https://cdn.example/touch-180.png" sizes="180x180">
        <meta property="og:image" content="/og.jpg">
        <link rel="icon" href="http://insecure.example/x.png">
      `),
      PAGE,
    );
    expect(b.logoCandidates).toEqual([
      'https://cdn.example/touch-180.png',
      'https://shop.example/touch-120.png',
      'https://shop.example/og.jpg',
      'https://shop.example/icon-192.png',
      'https://shop.example/icon-32.png',
      'https://shop.example/favicon.ico',
    ]);
    expect(b.name).toBe('Acme Socks');
  });

  it('prefers og:site_name, else trims the title at the first separator', () => {
    expect(
      extractBrand(
        html('<meta property="og:site_name" content=" Acme &amp; Co "><title>x</title>'),
        PAGE,
      ).name,
    ).toBe('Acme & Co');
    expect(extractBrand(html('<title>Acme – Shop – Socks</title>'), PAGE).name).toBe('Acme');
    expect(extractBrand(html(''), PAGE)).toEqual({
      name: null,
      themeColor: null,
      logoCandidates: ['https://shop.example/favicon.ico'],
    });
  });

  it('normalises theme-color', () => {
    const color = (c: string) =>
      extractBrand(html(`<meta name="theme-color" content="${c}">`), PAGE).themeColor;
    expect(color('#ABC')).toBe('#aabbcc');
    expect(color(' #12AB9f ')).toBe('#12ab9f');
    expect(color('#12ab9fcc')).toBe('#12ab9f');
    expect(color('rgb(255, 0, 16)')).toBe('#ff0010');
    expect(color('hotpink')).toBeNull();
    expect(color('#12')).toBeNull();
  });
});

describe('dominantColor', () => {
  it('returns the dominant colour as #rrggbb', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#d03020' },
    })
      .png()
      .toBuffer();
    const c = await dominantColor(png);
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    // sharp buckets colours; the answer is close to the fill.
    expect(contrastRatio(c, '#d03020')).toBeLessThan(1.2);
  });
});

describe('draftFromBrand', () => {
  const ctx = (ids: string[] = []) => ({
    assetOrigin: 'https://assets.tendr.test',
    assetIds: new Set(ids),
    assetKinds: new Map(ids.map((id) => [id, 'logo' as const])),
  });

  it('draftFromBrand fixes low-contrast accent', () => {
    // A pale yellow is "light" (luminance > 0.4): light mode, on white, darkened until 3:1.
    const light = draftFromBrand('Acme', { name: null, logoAssetId: null, color: '#fff3a0' });
    expect(light.settings.mode).toBe('light');
    const lp = light.settings.palettes.light!;
    expect(contrastRatio(lp.accent, lp.background)).toBeGreaterThanOrEqual(3);
    expect(lp.accent).not.toBe('#fff3a0');
    expect(light.settings.palettes.dark).toBeUndefined();

    // A near-black navy is "dark": dark mode, lightened until it stands out on the dark background.
    const dark = draftFromBrand('Acme', { name: null, logoAssetId: null, color: '#101830' });
    expect(dark.settings.mode).toBe('dark');
    const dp = dark.settings.palettes.dark!;
    expect(contrastRatio(dp.accent, dp.background)).toBeGreaterThanOrEqual(3);

    // A colour that already passes is kept as given.
    const ok = draftFromBrand('Acme', { name: null, logoAssetId: null, color: '#ff8800' });
    expect(ok.settings.palettes.dark!.accent).toBe('#ff8800');
  });

  it('draft passes validateThemeDocument', () => {
    const doc = draftFromBrand('Acme Socks', {
      name: 'Acme',
      logoAssetId: 'tasset_logo',
      color: '#ff8800',
    });
    expect(doc.settings).toMatchObject({ display_name: 'Acme', logo_asset_id: 'tasset_logo' });
    const r = validateThemeDocument(doc, ctx(['tasset_logo']));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // Nothing found: the minimal preset with the store's name.
    const bare = draftFromBrand('Acme Socks', { name: null, logoAssetId: null, color: null });
    expect(bare).toEqual(THEME_PRESETS.minimal.document('Acme Socks'));
    expect(validateThemeDocument(bare, ctx()).ok).toBe(true);
  });
});
