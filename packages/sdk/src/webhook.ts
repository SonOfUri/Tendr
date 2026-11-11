import { createHmac, timingSafeEqual } from 'node:crypto';
import { TendrWebhookError } from './errors.js';
import type { WebhookEvent } from './types.js';
export { TendrWebhookError } from './errors.js';
export type { WebhookEvent } from './types.js';

export interface VerifyWebhookOptions {
  payload: string | Uint8Array;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
}

/**
 * Node-only webhook signature verification.
 * Do not import this module into browser bundles.
 *
 * Header: `Tendr-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * After a secret rotation the header carries a second `v1=` signed with the old secret for a
 * while; a match on any `v1` is accepted.
 */
export function verifyWebhookSignature(opts: VerifyWebhookOptions): boolean {
  const tolerance = opts.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0 || !opts.secret) return false;
  if (typeof opts.signatureHeader !== 'string' || opts.signatureHeader.length > 8192) return false;
  const parsed = parseSignatureHeader(opts.signatureHeader);
  if (!parsed) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - parsed.t);
  if (age > tolerance) return false;

  const payload =
    typeof opts.payload === 'string'
      ? Buffer.from(opts.payload, 'utf8')
      : Buffer.from(opts.payload);
  const expected = Buffer.from(hmac(opts.secret, parsed.t, payload), 'hex');
  return parsed.v1.some((sig) => {
    const provided = Buffer.from(sig, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

/** Builds a `Tendr-Signature` header value, e.g. for testing a webhook receiver. */
export function signWebhookPayload(opts: {
  payload: string | Uint8Array;
  secret: string;
  timestamp?: number;
}): { header: string; timestamp: number } {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !opts.secret)
    throw new TypeError('A valid timestamp and nonempty signing secret are required');
  const payload =
    typeof opts.payload === 'string'
      ? Buffer.from(opts.payload, 'utf8')
      : Buffer.from(opts.payload);
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
      if (t !== undefined || !/^(0|[1-9]\d*)$/.test(value)) return null;
      t = Number(value);
      if (!Number.isSafeInteger(t)) return null;
    } else if (key === 'v1') {
      if (!/^[0-9a-f]{64}$/i.test(value)) return null;
      v1.push(value);
    }
  }
  return t === undefined || v1.length === 0 ? null : { t, v1 };
}

/** Verify the raw bytes first, then parse and validate the event envelope. */
export function constructWebhookEvent(opts: VerifyWebhookOptions): WebhookEvent {
  if (!verifyWebhookSignature(opts))
    throw new TendrWebhookError('Invalid or expired Tendr webhook signature');
  let event: unknown;
  try {
    event = JSON.parse(
      typeof opts.payload === 'string' ? opts.payload : Buffer.from(opts.payload).toString('utf8'),
    );
  } catch {
    throw new TendrWebhookError('Webhook payload is not valid JSON');
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event))
    throw new TendrWebhookError('Invalid webhook event envelope');
  const value = event as Record<string, unknown>;
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.type !== 'string' ||
    !value.type ||
    typeof value.created !== 'number' ||
    !Number.isSafeInteger(value.created) ||
    value.created < 0 ||
    typeof value.livemode !== 'boolean' ||
    typeof value.data !== 'object' ||
    value.data === null ||
    Array.isArray(value.data)
  ) {
    throw new TendrWebhookError('Invalid webhook event envelope');
  }
  return value as unknown as WebhookEvent;
}
