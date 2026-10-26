// Links into the dashboard from emails carry the store and mode they are about:
// `/dashboard/payments/<id>?store=<merchantId>&mode=<test|live>`. The dashboard switches to that
// store and mode only when the person is a member of it; otherwise the page is not found (it never
// says whether the store exists).
import type { StoreContext } from './api';

export type LinkedStore =
  { kind: 'none' } | { kind: 'switch'; ctx: StoreContext } | { kind: 'not-found' };

const MODES: Record<string, boolean> = { test: false, live: true };

export function linkedStore(
  search: string | URLSearchParams,
  stores: readonly { id: string }[],
): LinkedStore {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const store = q.get('store');
  if (store === null) return { kind: 'none' };
  const mode = q.get('mode');
  if (mode === null || !Object.hasOwn(MODES, mode)) return { kind: 'not-found' };
  if (!stores.some((s) => s.id === store)) return { kind: 'not-found' };
  return { kind: 'switch', ctx: { merchantId: store, livemode: MODES[mode]! } };
}

/** The address without the link parameters, so a later store change is not undone on reload. */
export function withoutStoreLink(pathname: string, search: string): string {
  const q = new URLSearchParams(search);
  q.delete('store');
  q.delete('mode');
  const rest = q.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
