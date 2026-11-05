// Checkout theme helpers for the dashboard. The shapes come from `@tendr/contracts` (types only,
// so no schema code is pulled into the page); the API validates everything, these helpers only map
// its answers onto the form.
import type {
  ThemeAssetObject,
  ThemeDocument,
  ThemeObject,
  ThemePalette,
  ThemeSettings,
} from '@tendr/contracts';
import { ApiError } from './api';

export type { ThemeAssetObject, ThemeDocument, ThemeObject, ThemePalette, ThemeSettings };

export type ThemeList = { data: ThemeObject[]; has_more: boolean };
export type ThemeAssetList = { data: ThemeAssetObject[] };
export type ThemeMode = ThemeSettings['mode'];
export type ThemeScheme = 'light' | 'dark';
export type ThemePreviewResult = { url: string; expires_at: string };
export type ThemeProblem = { path: string; message: string };

/** The palette colours the editor exposes. `muted` is not in the contract (palettes are strict). */
export const PALETTE_KEYS = ['background', 'surface', 'text', 'accent'] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

export const PALETTE_LABELS: Record<PaletteKey, string> = {
  background: 'Background',
  surface: 'Surface',
  text: 'Text',
  accent: 'Accent',
};

/** Used when a scheme is switched on that the draft has no palette for yet. */
export const DEFAULT_PALETTES: Record<ThemeScheme, ThemePalette> = {
  light: { background: '#ffffff', surface: '#f5f5f5', text: '#111111', accent: '#111111' },
  dark: { background: '#0b0b0b', surface: '#161616', text: '#f5f5f5', accent: '#f5f5f5' },
};

/** True when the draft has edits the published version does not (or nothing is published). */
export function draftDirty(theme: Pick<ThemeObject, 'status' | 'draft' | 'published'>): boolean {
  if (theme.status === 'draft') return true;
  if (!theme.published) return true;
  return JSON.stringify(theme.draft) !== JSON.stringify(theme.published);
}

/** The schemes whose palette the document needs for its mode. */
export function requiredSchemes(mode: ThemeMode): ThemeScheme[] {
  return mode === 'auto' ? ['light', 'dark'] : [mode];
}

/** `THEME_INVALID` carries `details.problems`; null for any other error. */
export function themeProblems(err: unknown): ThemeProblem[] | null {
  if (!(err instanceof ApiError) || err.code !== 'THEME_INVALID') return null;
  const raw = (err.details as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p): ThemeProblem[] => {
    const { path, message } = (p ?? {}) as Partial<ThemeProblem>;
    return typeof message === 'string' ? [{ path: typeof path === 'string' ? path : '', message }] : [];
  });
}

/**
 * Form field a problem path belongs to. Paths are dotted and relative to the document
 * (`settings.palettes.light.accent`, `custom_css`, `blocks.2.text`). Returns null when the editor
 * has no field for it (blocks, fonts, ...).
 */
export function fieldKeyOf(path: string): string | null {
  if (path === 'name') return 'name';
  if (path === 'custom_css') return 'custom_css';
  const m = /^settings\.(display_name|mode|logo_asset_id)$/.exec(path);
  if (m) return m[1]!;
  const p = /^settings\.palettes\.(light|dark)(?:\.(background|surface|text|accent))?$/.exec(path);
  if (p) return p[2] ? `palettes.${p[1]}.${p[2]}` : `palettes.${p[1]}`;
  return null;
}

export type MappedProblems = {
  /** Field key (see `fieldKeyOf`) to the first message for it. */
  fields: Record<string, string>;
  /** Problems with no field in this editor, shown as a list. */
  other: ThemeProblem[];
};

/** Splits problems into per-field messages and the rest. `custom_css` messages start `Line N:`. */
export function mapProblems(problems: ThemeProblem[]): MappedProblems {
  const out: MappedProblems = { fields: {}, other: [] };
  for (const p of problems) {
    const key = fieldKeyOf(p.path);
    if (key) out.fields[key] ??= p.message;
    else out.other.push(p);
  }
  return out;
}

/** The draft with new settings; blocks, success blocks and CSS stay as they were. */
export function withSettings(doc: ThemeDocument, settings: ThemeSettings): ThemeDocument {
  return { ...doc, settings };
}

/** Sets or clears `custom_css` (an empty string removes the key). */
export function withCustomCss(doc: ThemeDocument, css: string): ThemeDocument {
  const { custom_css: _old, ...rest } = doc;
  return css.trim() === '' ? rest : { ...rest, custom_css: css };
}

/** A palette for each scheme the mode needs; extra palettes already in the draft are kept. */
export function ensurePalettes(settings: ThemeSettings): ThemeSettings {
  const palettes = { ...settings.palettes };
  for (const s of requiredSchemes(settings.mode)) {
    palettes[s] ??= { ...DEFAULT_PALETTES[s] };
  }
  return { ...settings, palettes };
}

export function sameDocument(a: ThemeDocument, b: ThemeDocument): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** `THEME_IN_USE` (delete of the default, or of a theme payment links still name); else null. */
export function themeInUseMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'THEME_IN_USE') return null;
  const links = (err.details as { links?: unknown } | undefined)?.links;
  const n = Array.isArray(links) ? links.length : 0;
  return n > 0 ? `${err.message} (${n} payment link${n === 1 ? '' : 's'}).` : err.message;
}
