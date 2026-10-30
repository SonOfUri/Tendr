import type { z } from 'zod';
import {
  THEME_SCHEMA_VERSION,
  type ThemeBlock,
  type ThemeDocument,
  type ThemePresetIdSchema,
} from './themes.js';

export type ThemePresetId = z.infer<typeof ThemePresetIdSchema>;

const HEADER: ThemeBlock = { id: 'header', type: 'header', show_logo: true, show_name: true };
const SUMMARY: ThemeBlock = { id: 'summary', type: 'order_summary' };
const PAYMENT: ThemeBlock = { id: 'payment', type: 'payment' };
const THANK_YOU: ThemeBlock = { id: 'thank-you', type: 'thank_you' };
const BACK: ThemeBlock = { id: 'back', type: 'back_to_store' };

function doc(
  settings: Omit<ThemeDocument['settings'], 'celebration'> & {
    celebration?: ThemeDocument['settings']['celebration'];
  },
  blocks: ThemeBlock[] = [HEADER, SUMMARY, PAYMENT],
  successBlocks: ThemeBlock[] = [THANK_YOU, BACK],
): ThemeDocument {
  return {
    schema_version: THEME_SCHEMA_VERSION,
    settings: { celebration: 'none', ...settings },
    blocks,
    success_blocks: successBlocks,
  };
}

/** Today's navy look (the `--tendr-*` tokens) in dark, plus a light palette. */
export function TENDR_DEFAULT_THEME(displayName: string): ThemeDocument {
  return doc({
    display_name: displayName,
    mode: 'dark',
    palettes: {
      dark: { accent: '#7a72ff', background: '#080d1b', surface: '#0f1629', text: '#ffffff' },
      light: { accent: '#4035f5', background: '#ffffff', surface: '#f3f4fb', text: '#080d1b' },
    },
    font: { kind: 'curated', id: 'sora' },
    corner: 'soft',
  });
}

export const THEME_PRESETS: Record<
  ThemePresetId,
  { label: string; description: string; document: (displayName: string) => ThemeDocument }
> = {
  blank: {
    label: 'Tendr default',
    description: 'The standard Tendr look, with light and dark palettes.',
    document: TENDR_DEFAULT_THEME,
  },
  fashion: {
    label: 'Fashion',
    description: 'Warm paper tones, a serif face and square corners.',
    document: (displayName) =>
      doc({
        display_name: displayName,
        mode: 'light',
        palettes: {
          light: { accent: '#1c1a17', background: '#f7f3ee', surface: '#ffffff', text: '#1c1a17' },
        },
        font: { kind: 'curated', id: 'cormorant-garamond' },
        corner: 'square',
        button_label: 'Complete purchase',
      }),
  },
  gaming: {
    label: 'Gaming',
    description: 'Deep purple dark mode with round corners and confetti on success.',
    document: (displayName) =>
      doc({
        display_name: displayName,
        mode: 'dark',
        palettes: {
          dark: { accent: '#9b5cff', background: '#0d0b1a', surface: '#171329', text: '#f4f1ff' },
        },
        font: { kind: 'curated', id: 'space-grotesk' },
        corner: 'round',
        celebration: 'confetti',
      }),
  },
  nonprofit: {
    label: 'Nonprofit',
    description: 'Warm and friendly, with pill buttons and a thank-you note.',
    document: (displayName) =>
      doc(
        {
          display_name: displayName,
          mode: 'light',
          palettes: {
            light: {
              accent: '#c2410c',
              background: '#fffaf2',
              surface: '#ffffff',
              text: '#2b1d12',
            },
          },
          font: { kind: 'curated', id: 'dm-sans' },
          corner: 'pill',
          button_label: 'Give {amount}',
        },
        [HEADER, SUMMARY, PAYMENT],
        [THANK_YOU, BACK],
      ),
  },
  minimal: {
    label: 'Minimal',
    description: 'Quiet slate and indigo that follows the shopper’s light or dark setting.',
    document: (displayName) =>
      doc({
        display_name: displayName,
        mode: 'auto',
        palettes: {
          light: { accent: '#4f46e5', background: '#ffffff', surface: '#f8fafc', text: '#0f172a' },
          dark: { accent: '#818cf8', background: '#0b1020', surface: '#151b2e', text: '#e2e8f0' },
        },
        font: { kind: 'curated', id: 'inter' },
        corner: 'soft',
      }),
  },
};
