import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './webhook.js';

const payload = JSON.stringify({ id: 'evt_1', type: 'payment.settled' });
const secret = 'whsec_test';
const now = () => Math.floor(Date.now() / 1000);
const v1 = (s: string, t: number, body: string) =>
  createHmac('sha256', s).update(`${t}.${body}`).digest('hex');

describe('webhook signatures', () => {
  it('verifies a header in the format the API sends', () => {
    const t = now();
    const header = `t=${t},v1=${v1(secret, t, payload)}`;
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(true);
    expect(verifyWebhookSignature({ payload: Buffer.from(payload), secret, signatureHeader: header })).toBe(
      true,
    );
  });

  it('round-trips with signWebhookPayload', () => {
    const { header } = signWebhookPayload({ payload, secret });
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(true);
  });

  it('accepts a match on any v1 during a secret rotation', () => {
    const t = now();
    const header = `t=${t},v1=${v1('whsec_new', t, payload)},v1=${v1('whsec_old', t, payload)}`;
    expect(verifyWebhookSignature({ payload, secret: 'whsec_old', signatureHeader: header })).toBe(true);
    expect(verifyWebhookSignature({ payload, secret: 'whsec_new', signatureHeader: header })).toBe(true);
    expect(verifyWebhookSignature({ payload, secret: 'whsec_other', signatureHeader: header })).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const { header } = signWebhookPayload({ payload, secret });
    expect(verifyWebhookSignature({ payload: payload + 'x', secret, signatureHeader: header })).toBe(false);
  });

  it('rejects a timestamp outside the tolerance', () => {
    const { header } = signWebhookPayload({ payload, secret, timestamp: now() - 301 });
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(false);
  });

  it('rejects malformed headers', () => {
    const t = now();
    const sig = v1(secret, t, payload);
    for (const header of ['', sig, `sha256=${sig}`, `v1=${sig}`, `t=${t}`, `t=abc,v1=${sig}`, `t=${t},v1=zz`]) {
      expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(false);
    }
  });
});
