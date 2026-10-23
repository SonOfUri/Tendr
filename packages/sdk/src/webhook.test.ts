import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './webhook.js';

describe('webhook signatures', () => {
  it('verifies a valid signature', () => {
    const payload = JSON.stringify({ type: 'payment.settled', id: 'evt_1' });
    const secret = 'test-secret';
    const { signature, timestamp } = signWebhookPayload({ payload, secret });
    expect(
      verifyWebhookSignature({
        payload,
        secret,
        signatureHeader: signature,
        timestampHeader: String(timestamp),
      }),
    ).toBe(true);
  });

  it('rejects tampered payload', () => {
    const payload = JSON.stringify({ type: 'payment.settled' });
    const secret = 'test-secret';
    const { signature, timestamp } = signWebhookPayload({ payload, secret });
    expect(
      verifyWebhookSignature({
        payload: payload + 'x',
        secret,
        signatureHeader: signature,
        timestampHeader: String(timestamp),
      }),
    ).toBe(false);
  });
});
