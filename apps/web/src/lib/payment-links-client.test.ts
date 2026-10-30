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
    expect(parseLinkAmount('5,000', 'NGN').ok).toBe(false);
    expect(parseLinkAmount('1.2.3', 'NGN').ok).toBe(false);
    expect(parseLinkAmount('12.345', 'NGN').ok).toBe(false);
    expect(parseLinkAmount('100.5', 'JPY').ok).toBe(false);
    expect(parseLinkAmount('-5', 'USD').ok).toBe(false);
    expect(parseLinkAmount('', 'USD').ok).toBe(false);
    expect(parseLinkAmount('1e3', 'USD').ok).toBe(false);
    expect(parseLinkAmount('.5', 'USD').ok).toBe(false);
    expect(parseLinkAmount('0', 'USD').ok).toBe(false);
  });

  it('accepts amounts within the currency precision', () => {
    expect(parseLinkAmount(' 2500.50 ', 'NGN')).toEqual({ ok: true, amount: '2500.50' });
    expect(parseLinkAmount('1500', 'JPY')).toEqual({ ok: true, amount: '1500' });
    expect(parseLinkAmount('1.234', 'BHD')).toEqual({ ok: true, amount: '1.234' });
  });

  it('says how many decimals the currency takes', () => {
    const jpy = parseLinkAmount('100.5', 'JPY');
    expect(jpy.ok ? null : jpy.error).toBe('Enter a whole number, like 2500.');
    const ngn = parseLinkAmount('5,000', 'NGN');
    expect(ngn.ok ? null : ngn.error).toBe('Enter an amount like 2500.50.');
  });
});

describe('formatting', () => {
  it('formats the link amount in its currency', () => {
    expect(formatLinkAmount('25000.00', 'NGN')).toBe('₦25,000');
    expect(formatLinkAmount('15.20', 'USD')).toBe('$15.20');
    expect(formatLinkAmount('1500', 'JPY')).toBe('¥1,500');
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
        new Response(JSON.stringify({ url: 'http://localhost:3000/pay/ses_x#cs=abc' }), {
          status: 201,
        }),
    );
    vi.stubGlobal('fetch', fn);
    const out = await startLinkPayment('acme', 'tip-jar', true, { amount: '5000', note: 'hi' });
    expect(out).toEqual({ url: 'http://localhost:3000/pay/ses_x#cs=abc' });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toMatch(/\/v1\/payment_links\/public\/acme\/tip-jar\/sessions\?mode=test$/);
    expect(init!.method).toBe('POST');
    expect(init!.credentials).toBe('omit');
    expect(JSON.parse(String(init!.body))).toEqual({ amount: '5000', note: 'hi' });
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
