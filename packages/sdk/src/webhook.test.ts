import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  constructWebhookEvent,
  TendrWebhookError,
  signWebhookPayload,
  verifyWebhookSignature,
} from './webhook.js';

const payload = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' });
const secret = 'whsec_test';
const now = () => Math.floor(Date.now() / 1000);
const v1 = (s: string, t: number, body: string) =>
  createHmac('sha256', s).update(`${t}.${body}`).digest('hex');

describe('webhook signatures', () => {
  it('verifies a header in the format the API sends', () => {
    const t = now();
    const header = `t=${t},v1=${v1(secret, t, payload)}`;
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(true);
    expect(
      verifyWebhookSignature({ payload: Buffer.from(payload), secret, signatureHeader: header }),
    ).toBe(true);
  });

  it('round-trips with signWebhookPayload', () => {
    const { header } = signWebhookPayload({ payload, secret });
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(true);
  });

  it('accepts a match on any v1 during a secret rotation', () => {
    const t = now();
    const header = `t=${t},v1=${v1('whsec_new', t, payload)},v1=${v1('whsec_old', t, payload)}`;
    expect(verifyWebhookSignature({ payload, secret: 'whsec_old', signatureHeader: header })).toBe(
      true,
    );
    expect(verifyWebhookSignature({ payload, secret: 'whsec_new', signatureHeader: header })).toBe(
      true,
    );
    expect(
      verifyWebhookSignature({ payload, secret: 'whsec_other', signatureHeader: header }),
    ).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const { header } = signWebhookPayload({ payload, secret });
    expect(
      verifyWebhookSignature({ payload: payload + 'x', secret, signatureHeader: header }),
    ).toBe(false);
  });

  it('rejects a timestamp outside the tolerance', () => {
    const { header } = signWebhookPayload({ payload, secret, timestamp: now() - 301 });
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(false);
  });

  it('rejects malformed headers', () => {
    const t = now();
    const sig = v1(secret, t, payload);
    for (const header of [
      '',
      sig,
      `sha256=${sig}`,
      `v1=${sig}`,
      `t=${t}`,
      `t=abc,v1=${sig}`,
      `t=${t},v1=zz`,
    ]) {
      expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(false);
    }
  });
});

describe('strict webhook verification', () => {
  it('rejects a valid MAC with a trailing nibble (Buffer hex decoding would truncate it)', () => {
    const { header } = signWebhookPayload({ payload, secret });
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header + 'f' })).toBe(false);
  });
  it.each([NaN, Infinity, -1])('rejects an unsafe timestamp tolerance: %s', (toleranceSeconds) => {
    const { header } = signWebhookPayload({ payload, secret });
    expect(
      verifyWebhookSignature({ payload, secret, signatureHeader: header, toleranceSeconds }),
    ).toBe(false);
  });
  it('rejects duplicate/unsafe timestamps and future replays', () => {
    const t = now();
    const sig = v1(secret, t, payload);
    for (const signatureHeader of [
      `t=${t},t=${t},v1=${sig}`,
      `t=${'9'.repeat(400)},v1=${sig}`,
      `t=0${t},v1=${sig}`,
    ]) {
      expect(verifyWebhookSignature({ payload, secret, signatureHeader })).toBe(false);
    }
    const { header } = signWebhookPayload({ payload, secret, timestamp: t + 301 });
    expect(verifyWebhookSignature({ payload, secret, signatureHeader: header })).toBe(false);
  });
  it('rejects empty secrets', () => {
    const signatureHeader = `t=${now()},v1=${v1('', now(), payload)}`;
    expect(verifyWebhookSignature({ payload, secret: '', signatureHeader })).toBe(false);
  });
});

describe('constructWebhookEvent', () => {
  const event = {
    id: 'evt_1',
    type: 'payment.succeeded',
    created: 1700000000,
    livemode: false,
    data: { session_id: 'ses_1' },
  };
  it('verifies raw Uint8Array bytes and returns a valid envelope', () => {
    const payload = new TextEncoder().encode(JSON.stringify(event));
    const { header } = signWebhookPayload({ payload, secret });
    expect(constructWebhookEvent({ payload, secret, signatureHeader: header })).toEqual(event);
  });
  it('verifies before parsing, and rejects invalid signed envelopes', () => {
    expect(() =>
      constructWebhookEvent({ payload: 'not json', signatureHeader: 'bad', secret }),
    ).toThrow('signature');
    for (const payload of [
      'bad json',
      'null',
      '[]',
      JSON.stringify({ ...event, data: [] }),
      JSON.stringify({ ...event, livemode: 'false' }),
      JSON.stringify({ ...event, created: -1 }),
    ]) {
      const { header } = signWebhookPayload({ payload, secret });
      expect(() => constructWebhookEvent({ payload, secret, signatureHeader: header })).toThrow(
        TendrWebhookError,
      );
    }
  });
  it('allows unknown future event types so receivers can ignore them safely', () => {
    const payload = JSON.stringify({ ...event, type: 'future.event' });
    const { header } = signWebhookPayload({ payload, secret });
    expect(constructWebhookEvent({ payload, secret, signatureHeader: header }).type).toBe(
      'future.event',
    );
  });
});
