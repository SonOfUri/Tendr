import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `tdr_live_${randomBytes(24).toString('hex')}`;
  const prefix = raw.slice(0, 12);
  return { raw, prefix, hash: sha256(raw) };
}

export function generateWebhookSecret(): { raw: string; preview: string; hash: string } {
  const raw = `whsec_${randomBytes(24).toString('hex')}`;
  return { raw, preview: `${raw.slice(0, 10)}…`, hash: sha256(raw) };
}

export function signPayload(payload: string, secret: string, timestamp: number): string {
  return (
    'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  );
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
