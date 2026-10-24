import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Raw API key prefixes by kind and mode; the gateway parses keys by these prefixes. */
export const API_KEY_PREFIXES = {
  secret: { test: 'tdr_test_', live: 'tdr_live_' },
  publishable: { test: 'tdr_pk_test_', live: 'tdr_pk_live_' },
} as const;

/**
 * A new raw API key. Only `hash` (sha256 hex, the `api_keys.key_hash` the gateway looks up)
 * and `prefix` (the type prefix plus 4 characters, for display) are stored; `raw` is shown once.
 */
export function generateApiKey(
  kind: 'secret' | 'publishable',
  livemode: boolean,
): { raw: string; prefix: string; hash: string } {
  const typePrefix = API_KEY_PREFIXES[kind][livemode ? 'live' : 'test'];
  const raw = `${typePrefix}${randomBytes(24).toString('hex')}`;
  return { raw, prefix: raw.slice(0, typePrefix.length + 4), hash: sha256(raw) };
}

export function generateWebhookSecret(): { raw: string; preview: string; hash: string } {
  const raw = `whsec_${randomBytes(24).toString('hex')}`;
  return { raw, preview: `${raw.slice(0, 10)}…`, hash: sha256(raw) };
}

export function signPayload(payload: string, secret: string, timestamp: number): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function hashRequest(body: unknown): string {
  return sha256(JSON.stringify(body));
}
