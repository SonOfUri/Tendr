import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Node-only webhook signature verification.
 * Do not import this module into browser bundles.
 *
 * Header: `Tendr-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * After a secret rotation the header carries a second `v1=` signed with the old secret for a
 * while; a match on any `v1` is accepted.
 */
export function verifyWebhookSignature(opts: {
  payload: string | Buffer;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
}): boolean {
  const tolerance = opts.toleranceSeconds ?? 300;
  const parsed = parseSignatureHeader(opts.signatureHeader);
  if (!parsed) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - parsed.t);
  if (age > tolerance) return false;

  const payload = typeof opts.payload === 'string' ? Buffer.from(opts.payload, 'utf8') : opts.payload;
  const expected = Buffer.from(hmac(opts.secret, parsed.t, payload), 'hex');
  return parsed.v1.some((sig) => {
    const provided = Buffer.from(sig, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

/** Builds a `Tendr-Signature` header value, e.g. for testing a webhook receiver. */
export function signWebhookPayload(opts: {
  payload: string | Buffer;
  secret: string;
  timestamp?: number;
}): { header: string; timestamp: number } {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const payload = typeof opts.payload === 'string' ? Buffer.from(opts.payload, 'utf8') : opts.payload;
  return { header: `t=${timestamp},v1=${hmac(opts.secret, timestamp, payload)}`, timestamp };
}

function hmac(secret: string, timestamp: number, payload: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
}

/** `t=<int>` once and one or more hex `v1=` values; null when malformed. */
function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    const eq = item.indexOf('=');
    if (eq <= 0) return null;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key === 't') {
      if (t !== undefined || !/^\d+$/.test(value)) return null;
      t = Number(value);
    } else if (key === 'v1') {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      v1.push(value);
    }
  }
  return t === undefined || v1.length === 0 ? null : { t, v1 };
}
