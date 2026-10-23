import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Node-only webhook signature verification.
 * Do not import this module into browser bundles.
 */
export function verifyWebhookSignature(opts: {
  payload: string | Buffer;
  signatureHeader: string;
  secret: string;
  timestampHeader: string;
  toleranceSeconds?: number;
}): boolean {
  const tolerance = opts.toleranceSeconds ?? 300;
  const timestamp = Number(opts.timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > tolerance) return false;

  const payload = typeof opts.payload === 'string' ? opts.payload : opts.payload.toString('utf8');
  const signed = `${timestamp}.${payload}`;
  const expected = createHmac('sha256', opts.secret).update(signed).digest('hex');
  const provided = opts.signatureHeader.replace(/^sha256=/, '');

  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signWebhookPayload(opts: {
  payload: string;
  secret: string;
  timestamp?: number;
}): { signature: string; timestamp: number } {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    'sha256=' +
    createHmac('sha256', opts.secret).update(`${timestamp}.${opts.payload}`).digest('hex');
  return { signature, timestamp };
}
