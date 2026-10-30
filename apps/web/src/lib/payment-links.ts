// Server-only: the web server's reads of the public payment-link API (spec §4, §5). The link page
// and its QR and preview routes are rendered here, so every read comes from this server's
// address: it sends `x-tendr-internal: <WEB_INTERNAL_TOKEN>` and the payer's IP in
// `x-tendr-client-ip`, and the API keys its per-IP limits on that IP. The token is a server env
// var (never NEXT_PUBLIC_*) and this module must never be imported by a client component.
import type { PublicPaymentLinkView } from '@tendr/contracts';
import { serverEnv } from './env';

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv4 or IPv6 literal (no zone, no brackets, no port). Runs in any runtime. */
function isIpLiteral(s: string): boolean {
  if (IPV4.test(s)) return true;
  if (!s.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(s)) return false;
  try {
    return new URL(`http://[${s}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/**
 * The payer's IP: the rightmost `x-forwarded-for` entry, the one our single trusted proxy hop
 * appended (the API's `trustProxy` trusts the same one hop). Entries to its left are whatever the
 * client sent. Null when absent or not a valid IP literal.
 */
export function payerIpFrom(h: Headers): string | null {
  const xff = h.get('x-forwarded-for');
  if (!xff) return null;
  const last = xff.split(',').at(-1)!.trim();
  return isIpLiteral(last) ? last : null;
}

/** `/v1/payment_links/public/<merchant>/<link>[?mode=test]` on `base`. */
export function publicLinkPath(merchant: string, link: string, test: boolean): string {
  const path = `/v1/payment_links/public/${encodeURIComponent(merchant)}/${encodeURIComponent(link)}`;
  return test ? `${path}?mode=test` : path;
}

/**
 * What the payer's page shows for a link, never cached. Null for an unknown merchant or link
 * (the API's 404); any other failure throws (the page's error boundary handles it).
 */
export async function fetchPublicLink(
  merchant: string,
  link: string,
  test: boolean,
  payerIp: string | null,
): Promise<PublicPaymentLinkView | null> {
  const env = serverEnv();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.webInternalToken) headers['x-tendr-internal'] = env.webInternalToken;
  if (payerIp) headers['x-tendr-client-ip'] = payerIp;
  const res = await fetch(`${env.apiBaseUrl}${publicLinkPath(merchant, link, test)}`, {
    headers,
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`payment link lookup failed (${res.status})`);
  return (await res.json()) as PublicPaymentLinkView;
}
