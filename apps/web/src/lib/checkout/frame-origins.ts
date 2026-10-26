// The middleware's lookup of the origins allowed to frame a checkout (CSP frame-ancestors), from
// the API's public `GET /v1/checkout/public/:sessionId/frame-origins`. It fails closed: any error,
// a non-200, a malformed body or no answer within the timeout gives null, which the CSP builder
// turns into `frame-ancestors 'self'`. Successes are cached briefly in memory; failures are not.
import { plainOrigins } from '../csp';

/** The checkout page's own path: `/pay/<session id>` (not its sub-pages). */
const CHECKOUT_PAGE = /^\/pay\/(ses_[0-9A-HJKMNP-TV-Z]{26})\/?$/;

/** The session id when `pathname` is a checkout page, else null. */
export function checkoutSessionIdOf(pathname: string): string | null {
  return CHECKOUT_PAGE.exec(pathname)?.[1] ?? null;
}

/**
 * Whether a request could be rendered inside a frame, from its `Sec-Fetch-Dest`. A top-level
 * navigation (`document`) or a data fetch (`empty`) is never framed, so `'self'` is enough and the
 * API is not asked. A missing header (older browsers) is looked up.
 */
export function needsFrameLookup(secFetchDest: string | null): boolean {
  return secFetchDest === null || secFetchDest === 'iframe' || secFetchDest === 'frame';
}

export type FrameOriginsLookup = (sessionId: string) => Promise<string[] | null>;

export function createFrameOriginsLookup(opts: {
  apiBaseUrl: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** How long a success is reused (at most 60 s). */
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  maxEntries?: number;
}): FrameOriginsLookup {
  const base = opts.apiBaseUrl.replace(/\/+$/, '');
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const ttl = Math.min(opts.ttlMs ?? 60_000, 60_000);
  const timeout = opts.timeoutMs ?? 1500;
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? 1000;
  const cache = new Map<string, { origins: string[]; until: number }>();

  return async (sessionId) => {
    const hit = cache.get(sessionId);
    if (hit && hit.until > now()) return hit.origins;
    if (hit) cache.delete(sessionId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchFn(
        `${base}/v1/checkout/public/${encodeURIComponent(sessionId)}/frame-origins`,
        { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } },
      );
      if (res.status !== 200) return null;
      const body = (await res.json()) as { origins?: unknown };
      if (!Array.isArray(body.origins)) return null;
      const origins = plainOrigins(body.origins);
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(sessionId, { origins, until: now() + ttl });
      return origins;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
