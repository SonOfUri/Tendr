'use client';

// The shopper's colour-scheme preference, for themes in `auto` mode. Kept apart from vars.ts so
// the variable helpers (and ThemeStyles) stay importable from server components.
import { useSyncExternalStore } from 'react';
import type { ThemeSettings } from '@tendr/contracts';
import { themeScheme, type Scheme } from './vars';

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
 * Which palette to draw a theme in: its fixed mode, or with `auto` the shopper's
 * `prefers-color-scheme` (dark during server rendering, matching Tendr's default look). Pass the
 * result to `themeVars`/`ThemeStyles`, and `themeDataScheme(theme, result)` to `data-scheme`.
 */
export function useScheme(mode: ThemeSettings['mode']): Scheme {
  const preferred = useSyncExternalStore(subscribe, preferredScheme, () => 'dark' as const);
  return themeScheme(mode, preferred);
}
