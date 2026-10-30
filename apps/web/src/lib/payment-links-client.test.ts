import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatLinkAmount,
  parseLinkAmount,
  startLinkPayment,
  usdEquivalent,
} from './payment-links-client';

afterEach(() => vi.unstubAllGlobals());

describe('parseLinkAmount', () => {
  it('amount input rejects bad formats', () => {
    expect(parseLinkAmount('5,000', 2).ok).toBe(false);
    expect(parseLinkAmount('1.2.3', 2).ok).toBe(false);
    expect(parseLinkAmount('12.345', 2).ok).toBe(false); // NGN
    expect(parseLinkAmount('100.5', 0).ok).toBe(false); // JPY
    expect(parseLinkAmount('5.5', 0).ok).toBe(false); // IRT (Intl says 2)
    expect(parseLinkAmount('-5', 2).ok).toBe(false);
    expect(parseLinkAmount('', 2).ok).toBe(false);
    expect(parseLinkAmount('1e3', 2).ok).toBe(false);
    expect(parseLinkAmount('.5', 2).ok).toBe(false);
    expect(parseLinkAmount('0', 2).ok).toBe(false);
  });

  it('accepts amounts within the currency precision from the API, not Intl', () => {
    expect(parseLinkAmount(' 2500.50 ', 2)).toEqual({ ok: true, amount: '2500.50' });
    expect(parseLinkAmount('1500', 0)).toEqual({ ok: true, amount: '1500' });
    expect(parseLinkAmount('1.234', 3)).toEqual({ ok: true, amount: '1.234' }); // BHD
    expect(parseLinkAmount('100.50', 2)).toEqual({ ok: true, amount: '100.50' }); // RSD (Intl 0)
    expect(parseLinkAmount('0.001', 8)).toEqual({ ok: true, amount: '0.001' }); // BTC (Intl 2)
  });

  it('says how many decimals the currency takes', () => {
    const jpy = parseLinkAmount('100.5', 0);
    expect(jpy.ok ? null : jpy.error).toBe('Enter a whole number, like 2500.');
    const ngn = parseLinkAmount('5,000', 2);
    expect(ngn.ok ? null : ngn.error).toBe('Enter an amount like 2500.50.');
  });
});

describe('formatting', () => {
  it('formats like money, never rounding: whole amounts without decimals', () => {
    // All-zero decimals: none shown.
    expect(formatLinkAmount('25000.00', 'NGN', 2)).toBe('₦25,000');
    expect(formatLinkAmount('1500', 'JPY', 0)).toBe('¥1,500');
    expect(formatLinkAmount('2.00000000', 'BTC', 8)).toBe('BTC\u00a02');
    // Up to 2 minor units: exactly that many (RSD is 2 here, Intl says 0).
    expect(formatLinkAmount('100.50', 'RSD', 2)).toBe('RSD\u00a0100.50');
    expect(formatLinkAmount('15.2', 'USD', 2)).toBe('$15.20');
    expect(formatLinkAmount('15.20', 'USD', 2)).toBe('$15.20');
    // More minor units (BTC, IQD...): the significant decimals, trailing zeros trimmed.
    expect(formatLinkAmount('0.00100000', 'BTC', 8)).toBe('BTC\u00a00.001');
    expect(formatLinkAmount('0.12345678', 'BTC', 8)).toBe('BTC\u00a00.12345678');
    expect(formatLinkAmount('1.250', 'BHD', 3)).toBe('BHD\u00a01.25');
  });

  it('gives the USD equivalent from the rate, or null without one', () => {
    expect(usdEquivalent('25000', 'NGN', '1600')).toBe('$15.63');
    expect(usdEquivalent('25000', 'NGN', null)).toBeNull();
    expect(usdEquivalent('25', 'USD', null)).toBeNull();
    expect(usdEquivalent('25', 'NGN', 'junk')).toBeNull();
  });
});

describe('startLinkPayment', () => {
  it('posts the amount and note to the public link route and returns the checkout url', async () => {
    const fn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            url: 'http://localhost:3000/pay/ses_x#cs=abc',
            expires_at: '2026-10-30T12:05:00.000Z',
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal('fetch', fn);
    const out = await startLinkPayment('acme', 'tip-jar', true, { amount: '5000', note: 'hi' });
    expect(out).toEqual({
      url: 'http://localhost:3000/pay/ses_x#cs=abc',
      expires_at: '2026-10-30T12:05:00.000Z',
    });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toMatch(/\/v1\/payment_links\/public\/acme\/tip-jar\/sessions\?mode=test$/);
    expect(init!.method).toBe('POST');
    expect(init!.credentials).toBe('omit');
    expect(JSON.parse(String(init!.body))).toEqual({ amount: '5000', note: 'hi' });
  });

  it('an answer without expires_at still returns the url', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ url: 'https://x.example/pay/s' }), { status: 201 }),
      ),
    );
    expect(await startLinkPayment('acme', 'l', false, {})).toEqual({
      url: 'https://x.example/pay/s',
      expires_at: null,
    });
  });

  it('returns the API error envelope, and a code for a bare 429 or a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'LINK_UNAVAILABLE',
                message: 'x',
                details: { availability: 'expired' },
              },
            }),
            { status: 409 },
          ),
      ),
    );
    expect(await startLinkPayment('acme', 'l', false, {})).toEqual({
      error: { code: 'LINK_UNAVAILABLE', message: 'x', details: { availability: 'expired' } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 })),
    );
    const busy = await startLinkPayment('acme', 'l', false, {});
    expect('error' in busy && busy.error.code).toBe('RATE_LIMITED');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    const net = await startLinkPayment('acme', 'l', false, {});
    expect('error' in net && net.error.code).toBe('NETWORK_ERROR');
  });
});
