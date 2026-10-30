// The payer's link page in the browser (spec §4): amount parsing and display, and "Pay", which
// asks the public API for a checkout session (`POST …/sessions`) and returns its hosted URL.
// Amounts are decimal strings checked and compared with integer arithmetic, never floats. The
// POST goes straight from the browser, so the API limits it on the payer's own IP.
import { formatUsd } from './checkout/format';
import { publicEnv } from './env';

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** The currency's minor units (JPY 0, NGN 2, BHD 3), from the runtime's ISO 4217 data. */
export function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export type ParsedAmount = { ok: true; amount: string } | { ok: false; error: string };

/** What the payer typed in an open link's amount box: digits, at most the currency's decimals. */
export function parseLinkAmount(raw: string, currency: string): ParsedAmount {
  const digits = fractionDigits(currency);
  const error = digits === 0 ? 'Enter a whole number, like 2500.' : 'Enter an amount like 2500.50.';
  const s = raw.trim();
  const m = DECIMAL.exec(s);
  if (!m || (m[2] ?? '').length > digits) return { ok: false, error };
  if (!/[1-9]/.test(s)) return { ok: false, error: 'Enter an amount above zero.' };
  return { ok: true, amount: s };
}

/** A decimal string as an integer number of `scale`-digit units (truncated), or null. */
function scaled(amount: string, scale: number): bigint | null {
  const m = DECIMAL.exec(amount.trim());
  if (!m) return null;
  const frac = ((m[2] ?? '') + '0'.repeat(scale)).slice(0, scale);
  return BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt(frac);
}

/** a < b for decimal strings (false when either is not a decimal). */
export function decimalLess(a: string, b: string): boolean {
  const x = scaled(a, 18);
  const y = scaled(b, 18);
  return x !== null && y !== null && x < y;
}

/** "25000.00" NGN → "₦25,000"; whole amounts drop their zero decimals, others keep them all. */
export function formatLinkAmount(amount: string, currency: string): string {
  const m = DECIMAL.exec(amount.trim());
  if (!m) return `${amount} ${currency}`;
  const digits = fractionDigits(currency);
  const whole = !/[1-9]/.test(m[2] ?? '');
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
      // A decimal string is formatted exactly (Intl.NumberFormat v3).
    }).format(amount.trim() as unknown as number);
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * The amount in dollars ("$15.63", to the nearest cent) at `usdRate` (1 USD = rate), or null for
 * a USD link or when no rate is known.
 */
export function usdEquivalent(
  amount: string,
  currency: string,
  usdRate: string | null,
): string | null {
  if (currency === 'USD' || !usdRate) return null;
  const a = scaled(amount, 18);
  const r = scaled(usdRate, 18);
  if (a === null || r === null || r === 0n) return null;
  const cents = (a * 200n + r) / (2n * r);
  return formatUsd(`${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`);
}

export interface LinkPayError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * "Pay": a checkout session from the link. `{ url }` is the hosted checkout (client secret in its
 * fragment); errors come back in the API's envelope, plus `RATE_LIMITED` for a bare 429 and
 * `NETWORK_ERROR` when the request never completed.
 */
export async function startLinkPayment(
  merchant: string,
  link: string,
  test: boolean,
  body: { amount?: string; note?: string },
): Promise<{ url: string } | { error: LinkPayError }> {
  const path = `/v1/payment_links/public/${encodeURIComponent(merchant)}/${encodeURIComponent(link)}/sessions`;
  let res: Response;
  try {
    res = await fetch(`${publicEnv.apiBaseUrl}${path}${test ? '?mode=test' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    return { error: { code: 'NETWORK_ERROR', message: 'The request did not complete' } };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON (a proxy's page): handled by status below.
  }
  if (res.ok) {
    const url = (json as { url?: unknown } | null)?.url;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return { url };
    return { error: { code: 'BAD_RESPONSE', message: 'Unexpected response' } };
  }
  const err = (json as { error?: Partial<LinkPayError> } | null)?.error;
  if (err && typeof err.code === 'string') {
    return {
      error: {
        code: err.code,
        message: typeof err.message === 'string' ? err.message : '',
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }
  return {
    error: {
      code: res.status === 429 ? 'RATE_LIMITED' : `HTTP_${res.status}`,
      message: `Request failed (${res.status})`,
    },
  };
}
