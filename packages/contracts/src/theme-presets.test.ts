import { describe, expect, it } from 'vitest';
import {
  TENDR_DEFAULT_THEME,
  THEME_PRESETS,
  ThemeDocumentSchema,
  findContrastProblems,
  type ThemePresetId,
} from './index.js';

const ids = Object.keys(THEME_PRESETS) as ThemePresetId[];

describe('theme presets', () => {
  it('every preset parses with ThemeDocumentSchema', () => {
    for (const id of ids) {
      const r = ThemeDocumentSchema.safeParse(THEME_PRESETS[id].document('Kola Kicks'));
      expect(r.success, id + JSON.stringify(r.success ? '' : r.error.issues)).toBe(true);
    }
  });

  it('every preset palette passes findContrastProblems', () => {
    for (const id of ids) {
      const { palettes } = THEME_PRESETS[id].document('X').settings;
      for (const p of Object.values(palettes)) {
        expect(findContrastProblems(p!), id).toEqual([]);
      }
    }
  });

  it('default theme parses', () => {
    const d = TENDR_DEFAULT_THEME('Kola Kicks');
    expect(ThemeDocumentSchema.safeParse(d).success).toBe(true);
    expect(d.blocks.map((b) => b.type)).toEqual(['header', 'order_summary', 'payment']);
    expect(d.success_blocks.map((b) => b.type)).toEqual(['thank_you', 'back_to_store']);
    expect(THEME_PRESETS.blank.document('Kola Kicks')).toEqual(d);
  });
});
