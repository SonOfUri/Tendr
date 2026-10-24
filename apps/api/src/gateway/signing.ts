// Optional HMAC request signing for secret-key callers.
//
// Header: `Tendr-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>`.
// The MAC covers the raw request bytes, never re-serialised JSON.
import { createHmac } from 'node:crypto';
import { safeEqualHex } from '../lib/crypto.js';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureResult = 'ok' | 'missing' | 'stale' | 'invalid';

export function computeSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/** Parses `k=v` pairs separated by commas, tolerating whitespace. Null when malformed. */
function parseHeader(header: string): { t: number; v1: string[] } | null {
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
      if (t !== undefined || !/^\d{1,12}$/.test(value)) return null; // duplicate or non-numeric t
      t = Number(value);
    } else if (key === 'v1') {
      v1.push(value);
    } // unknown keys (future schemes) are ignored
  }
  return t === undefined || v1.length === 0 ? null : { t, v1 };
}

/**
 * Verifies a `Tendr-Signature` header. `now` is unix seconds. When several `v1` values are
 * present any one matching is accepted (as Stripe does, to allow secret rotation); each
 * comparison is constant-time. The MAC is checked before the timestamp, so a forged header
 * reports `invalid` regardless of its age.
 */
export function verifyRequestSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string,
  now: number,
): SignatureResult {
  if (header === undefined || header.trim() === '') return 'missing';
  const parsed = parseHeader(header);
  if (!parsed) return 'invalid';
  const expected = computeSignature(secret, parsed.t, rawBody);
  // Evaluate every candidate (no early exit) so timing does not reveal which one matched.
  const matches = parsed.v1.map((candidate) => safeEqualHex(expected, candidate));
  if (!matches.includes(true)) return 'invalid';
  return Math.abs(now - parsed.t) > SIGNATURE_TOLERANCE_SECONDS ? 'stale' : 'ok';
}
