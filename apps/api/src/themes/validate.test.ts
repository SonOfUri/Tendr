import { THEME_PRESETS, type ThemeDocument } from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import { validateThemeDocument } from './validate.js';

const ORIGIN = 'https://assets.tendr.test';

function ctx(assets: Record<string, 'logo' | 'image' | 'font'> = {}) {
  return {
    assetOrigin: ORIGIN,
    assetIds: new Set(Object.keys(assets)),
    assetKinds: new Map(Object.entries(assets)),
  };
}

function preset(): ThemeDocument {
  return THEME_PRESETS.minimal.document('Acme Socks');
}

describe('validateThemeDocument', () => {
  it('valid preset passes and returns scoped css', () => {
    const doc = { ...preset(), custom_css: 'h2 { letter-spacing: 0.02em }' };
    const r = validateThemeDocument(doc, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.document).toEqual(doc);
    expect(r.css?.css).toBe('.tdr-scope h2{letter-spacing:0.02em}');
    expect(r.css?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null css when there is none', () => {
    const r = validateThemeDocument(preset(), ctx());
    expect(r).toMatchObject({ ok: true, css: null });
  });

  it('schema problems carry their path', () => {
    const doc = { ...preset(), blocks: [] };
    const r = validateThemeDocument(doc, ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toContainEqual({
      path: 'blocks',
      message: 'The page needs exactly one payment block',
    });
  });

  it('unknown asset id is a problem with its path', () => {
    const base = preset();
    const doc: ThemeDocument = {
      ...base,
      settings: { ...base.settings, logo_asset_id: 'ast_missing' },
      blocks: [
        ...base.blocks,
        {
          id: 'sec',
          type: 'section',
          blocks: [{ id: 'pic', type: 'image', asset_id: 'ast_gone', alt: 'A sock' }],
        },
      ],
    };
    const r = validateThemeDocument(doc, ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.path)).toEqual([
      'settings.logo_asset_id',
      'blocks.3.blocks.0.asset_id',
    ]);
    expect(r.problems[0]?.message).toMatch(/can't be found/);
  });

  it('font asset of kind image is rejected', () => {
    const base = preset();
    const doc: ThemeDocument = {
      ...base,
      settings: {
        ...base.settings,
        font: { kind: 'asset', asset_id: 'ast_img' },
        logo_asset_id: 'ast_font',
      },
    };
    const r = validateThemeDocument(doc, ctx({ ast_img: 'image', ast_font: 'font' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      { path: 'settings.logo_asset_id', message: 'This file must be an uploaded image or logo' },
      { path: 'settings.font.asset_id', message: 'This file must be an uploaded font' },
    ]);
  });

  it('accepts assets of the right kind', () => {
    const base = preset();
    const doc: ThemeDocument = {
      ...base,
      settings: {
        ...base.settings,
        font: { kind: 'asset', asset_id: 'ast_font' },
        logo_asset_id: 'ast_logo',
        background_image_asset_id: 'ast_img',
      },
      blocks: [
        ...base.blocks,
        { id: 'ban', type: 'banner', asset_id: 'ast_logo' },
        {
          id: 'trust',
          type: 'trust_badges',
          badges: [{ kind: 'asset', asset_id: 'ast_img', alt: 'Badge' }],
        },
      ],
    };
    const r = validateThemeDocument(
      doc,
      ctx({ ast_font: 'font', ast_logo: 'logo', ast_img: 'image' }),
    );
    expect(r.ok).toBe(true);
  });

  it('low-contrast palette is a problem naming the pair', () => {
    const base = preset();
    const doc: ThemeDocument = {
      ...base,
      settings: {
        ...base.settings,
        palettes: {
          ...base.settings.palettes,
          dark: { accent: '#818cf8', background: '#0b1020', surface: '#151b2e', text: '#333333' },
        },
      },
    };
    const r = validateThemeDocument(doc, ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      {
        path: 'settings.palettes.dark',
        message: 'Text is too hard to read on the background (needs a contrast of at least 4.5:1)',
      },
      {
        path: 'settings.palettes.dark',
        message: 'Text is too hard to read on cards (needs a contrast of at least 4.5:1)',
      },
    ]);
  });

  it('sanitises custom html and reports html and css problems with paths', () => {
    const base = preset();
    const ok = validateThemeDocument(
      {
        ...base,
        blocks: [...base.blocks, { id: 'raw', type: 'custom_html', html: '<p data-x="1">Hi</p>' }],
      },
      ctx(),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.document.blocks[3]).toEqual({ id: 'raw', type: 'custom_html', html: '<p>Hi</p>' });

    const bad = validateThemeDocument(
      {
        ...base,
        blocks: [
          ...base.blocks,
          {
            id: 'cols',
            type: 'columns',
            columns: [[{ id: 'raw', type: 'custom_html', html: '<form></form>' }], []],
          },
        ],
        custom_css: 'p {}\n.pay-card { display: none }',
      },
      ctx(),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((p) => p.path)).toEqual(['blocks.3.columns.0.0.html', 'custom_css']);
    expect(bad.problems[1]?.message).toMatch(/^Line 2: /);
  });
});
