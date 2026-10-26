// Connect (WooCommerce plugin spec §2): the popup the plugin's "Connect to tendr" button opens.
//
// The plugin opens `/connect?site_url&return_url&state&code_challenge&platform&plugin_version`
// (`code_challenge_method` is optional and only `S256`). Every parameter is checked here, then
// again by the API (`POST /v1/connect/authorize`):
// - `return_url` is http(s), on the same origin as `site_url`, with no fragment or credentials;
// - the rest match the API's `ConnectAuthorizeRequestSchema`; a parameter given twice is refused.
//
// The parameters live in this tab's sessionStorage (`tendr:connect`) while the person signs in,
// signs up or creates a store, and are cleared on approval or cancel. They are never put in any
// other URL. The tab an email link opens has its own sessionStorage, so it learns only that a
// connect is waiting (`tendr:connect:waiting` in localStorage: a timestamp, no parameters) and
// sends the person back to this window.
//
// The browser leaves only by `window.location.assign`, to a URL on the return_url (checked here:
// `checkedRedirect`, `cancelRedirect`).
import { ConnectAuthorizeRequestSchema, type ConnectAuthorizeRequest } from '@tendr/contracts';
import type { Role } from './api';

export type ConnectParams = ConnectAuthorizeRequest;

export const CONNECT_STORAGE_KEY = 'tendr:connect';
export const CONNECT_WAITING_KEY = 'tendr:connect:waiting';
/** How long stored parameters (and the waiting flag) are kept: long enough for a full sign-up. */
export const CONNECT_TTL_MS = 60 * 60_000;

const FIELDS = [
  'site_url',
  'return_url',
  'state',
  'code_challenge',
  'code_challenge_method',
  'platform',
  'plugin_version',
] as const;

export type ParseResult = { ok: true; params: ConnectParams } | { ok: false; error: string };

const fail = (error: string): ParseResult => ({ ok: false, error });

/** An http(s) URL with no credentials and no fragment (an empty `#` counts), or null. */
function plainHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.hash || raw.includes('#')) return null;
  return u;
}

/** Whether the query carries any connect parameter (a fresh start from the plugin). */
export function hasConnectParams(q: URLSearchParams): boolean {
  return FIELDS.some((f) => q.has(f));
}

/** Checks the plugin's parameters. The error is for the person; it never echoes a value. */
export function parseConnectParams(q: URLSearchParams): ParseResult {
  const raw: Record<string, string> = {};
  for (const f of FIELDS) {
    const all = q.getAll(f);
    if (all.length > 1) return fail('The link from your site has a repeated parameter.');
    if (all.length === 1) raw[f] = all[0]!;
  }
  const parsed = ConnectAuthorizeRequestSchema.safeParse({
    ...raw,
    code_challenge_method: raw.code_challenge_method ?? 'S256',
  });
  if (!parsed.success) {
    return fail('The link from your site is incomplete or not valid. Start again from your site.');
  }
  const site = plainHttpUrl(parsed.data.site_url);
  if (!site) return fail('The site address is not a valid web address.');
  const ret = plainHttpUrl(parsed.data.return_url);
  if (!ret || ret.origin !== site.origin) {
    return fail('The return address is not on your site. Start again from your site.');
  }
  return { ok: true, params: parsed.data };
}

function defaultStorage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Keeps the parameters in this tab while the person signs in or signs up. */
export function saveConnectParams(
  params: ConnectParams,
  storage: Storage | null = defaultStorage('session'),
): void {
  try {
    storage?.setItem(CONNECT_STORAGE_KEY, JSON.stringify({ at: Date.now(), params }));
  } catch {
    // Storage unavailable: the person starts again from their site after signing in.
  }
}

/** This tab's connect parameters, re-checked; null when none, stale or not valid. */
export function loadConnectParams(
  storage: Storage | null = defaultStorage('session'),
  now: number = Date.now(),
): ConnectParams | null {
  try {
    const raw = storage?.getItem(CONNECT_STORAGE_KEY);
    if (!raw) return null;
    const { at, params } = JSON.parse(raw) as { at?: unknown; params?: unknown };
    if (typeof at !== 'number' || now - at > CONNECT_TTL_MS || now < at - 60_000) return null;
    if (!params || typeof params !== 'object') return null;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string') q.set(k, v);
    const r = parseConnectParams(q);
    return r.ok ? r.params : null;
  } catch {
    return null;
  }
}

export function clearConnectParams(storage: Storage | null = defaultStorage('session')): void {
  try {
    storage?.removeItem(CONNECT_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Tells the tab an email link opens that a connect is waiting in another window. */
export function markConnectWaiting(storage: Storage | null = defaultStorage('local')): void {
  try {
    storage?.setItem(CONNECT_WAITING_KEY, String(Date.now()));
  } catch {
    // The email-link tab then goes to the dashboard; the popup still finishes on its own.
  }
}

/** Whether a connect is waiting in another window (fresh flag), clearing the flag. */
export function takeConnectWaiting(
  storage: Storage | null = defaultStorage('local'),
  now: number = Date.now(),
): boolean {
  try {
    const raw = storage?.getItem(CONNECT_WAITING_KEY);
    storage?.removeItem(CONNECT_WAITING_KEY);
    const at = Number(raw);
    return !!raw && Number.isFinite(at) && now - at <= CONNECT_TTL_MS;
  } catch {
    return false;
  }
}

export function clearConnectWaiting(storage: Storage | null = defaultStorage('local')): void {
  try {
    storage?.removeItem(CONNECT_WAITING_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The stores a person may connect a site to: those they own or administer. */
export function eligibleStores<T extends { role: Role }>(stores: readonly T[]): T[] {
  return stores.filter((s) => s.role === 'owner' || s.role === 'admin');
}

/** The site's origin (scheme, host, port), shown in full on the approval screen. */
export function siteOrigin(p: Pick<ConnectParams, 'site_url'>): string {
  return new URL(p.site_url).origin;
}

/** The site as the approval copy names it: `shop.example.com`, or `example.com/shop`. */
export function siteLabel(p: Pick<ConnectParams, 'site_url'>): string {
  const u = new URL(p.site_url);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.host}${path}`;
}

/** Spec §2.3, verbatim. */
export const APPROVAL_DETAIL =
  "This lets the site create checkouts, receive payment updates and request refunds. Refunds still need your signers' approval.";

export const approvalQuestion = (site: string, storeName: string) =>
  `Connect ${site} to ${storeName}?`;

/** The full approval sentence (spec §2.3). */
export const approvalCopy = (site: string, storeName: string) =>
  `${approvalQuestion(site, storeName)} ${APPROVAL_DETAIL}`;

/** `POST /v1/connect/authorize` body. */
export function authorizeBody(p: ConnectParams): ConnectAuthorizeRequest {
  return {
    site_url: p.site_url,
    return_url: p.return_url,
    state: p.state,
    code_challenge: p.code_challenge,
    code_challenge_method: 'S256',
    platform: p.platform,
    plugin_version: p.plugin_version,
  };
}

/**
 * The redirect from `POST /v1/connect/authorize`, when it goes back to the return_url (same
 * origin and path, http(s), no credentials); otherwise null and the popup does not navigate.
 */
export function checkedRedirect(redirect: string, returnUrl: string): string | null {
  const target = plainHttpUrl(redirect);
  const expected = plainHttpUrl(returnUrl);
  if (!target || !expected) return null;
  if (target.origin !== expected.origin || target.pathname !== expected.pathname) return null;
  return target.toString();
}

/** Where Cancel goes: the return_url with `error=access_denied` and the plugin's `state`. */
export function cancelRedirect(p: ConnectParams): string {
  const u = new URL(p.return_url);
  u.searchParams.delete('code');
  u.searchParams.set('error', 'access_denied');
  u.searchParams.set('state', p.state);
  return u.toString();
}

/** A checkout domain or a site URL as a comparable origin, or null. */
function originOf(value: string): string | null {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The checkout domains a save would remove (in `before`, not in `after`) that a live connection
 * uses: removing one stops that site's checkout from opening in its frame.
 */
export function domainsUsedByConnections(
  before: readonly string[],
  after: readonly string[],
  connections: readonly { site_url: string; status: string }[],
): { origin: string; site_url: string }[] {
  const kept = new Set(after.map(originOf).filter((o): o is string => o !== null));
  const removed = new Set(
    before.map(originOf).filter((o): o is string => o !== null && !kept.has(o)),
  );
  const hits: { origin: string; site_url: string }[] = [];
  for (const c of connections) {
    if (c.status !== 'active') continue;
    const o = originOf(c.site_url);
    if (o && removed.has(o) && !hits.some((h) => h.origin === o)) {
      hits.push({ origin: o, site_url: c.site_url });
    }
  }
  return hits;
}
