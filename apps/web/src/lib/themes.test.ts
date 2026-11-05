import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  draftDirty,
  fieldKeyOf,
  mapProblems,
  themeProblems,
  type ThemeDocument,
  type ThemeProblem,
} from './themes';

const doc = (displayName: string): ThemeDocument =>
  ({
    schema_version: 1,
    settings: {
      display_name: displayName,
      mode: 'light',
      palettes: { light: { background: '#fff', surface: '#f5f5f5', text: '#111', accent: '#111' } },
      font: { kind: 'curated', id: 'sora' },
      corner: 'soft',
      celebration: 'none',
    },
    blocks: [{ id: 'pay', type: 'payment' }],
    success_blocks: [{ id: 'ty', type: 'thank_you', headline: 'Thanks' }],
  }) as unknown as ThemeDocument;

describe('draftDirty', () => {
  it('is true for a draft status, missing publish, or draft differing from published', () => {
    const d = doc('A');
    expect(draftDirty({ status: 'draft', draft: d, published: d })).toBe(true);
    expect(draftDirty({ status: 'published', draft: d, published: null })).toBe(true);
    const published = doc('A');
    const edited = doc('B');
    expect(draftDirty({ status: 'published', draft: edited, published })).toBe(true);
    expect(draftDirty({ status: 'published', draft: d, published: d })).toBe(false);
  });
});

describe('THEME_INVALID problem mapping', () => {
  const problems: ThemeProblem[] = [
    { path: 'name', message: 'Name is required' },
    { path: 'settings.palettes.light.accent', message: 'Bad accent' },
    { path: 'blocks.2.text', message: 'Block copy issue' },
    { path: 'custom_css', message: 'Line 3: unexpected token' },
  ];

  it('themeProblems returns problems only for THEME_INVALID ApiErrors', () => {
    const err = new ApiError(400, 'THEME_INVALID', 'Invalid theme', 'req_1', { problems });
    expect(themeProblems(err)).toEqual(problems);
    expect(themeProblems(new ApiError(400, 'OTHER', 'Nope'))).toBeNull();
    expect(themeProblems(new Error('plain'))).toBeNull();
    expect(
      themeProblems(new ApiError(400, 'THEME_INVALID', 'Bad', undefined, { problems: 'nope' })),
    ).toEqual([]);
  });

  it('fieldKeyOf maps editor paths and mapProblems splits fields vs other', () => {
    expect(fieldKeyOf('settings.display_name')).toBe('display_name');
    expect(fieldKeyOf('settings.palettes.dark')).toBe('palettes.dark');
    expect(fieldKeyOf('settings.palettes.light.text')).toBe('palettes.light.text');
    expect(fieldKeyOf('blocks.0.type')).toBeNull();

    const mapped = mapProblems(problems);
    expect(mapped.fields).toEqual({
      name: 'Name is required',
      'palettes.light.accent': 'Bad accent',
      custom_css: 'Line 3: unexpected token',
    });
    expect(mapped.other).toEqual([{ path: 'blocks.2.text', message: 'Block copy issue' }]);
    expect(mapProblems(problems).fields.name).toBe('Name is required');
  });
});
