import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicEnv } from './env';
import { fetchPublicLink, payerIpFrom } from './payment-links';

const TOKEN = 'x'.repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('payerIpFrom', () => {
  it('payerIpFrom takes the rightmost forwarded entry and rejects junk', () => {
    const h = (xff: string) => new Headers({ 'x-forwarded-for': xff });
    // One trusted proxy hop: the entry it appended is the last one; earlier ones are client-set.
    expect(payerIpFrom(h('6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7');
    expect(payerIpFrom(h(' 203.0.113.7 '))).toBe('203.0.113.7');
    expect(payerIpFrom(h('1.1.1.1, 2001:db8::1'))).toBe('2001:db8::1');
    expect(payerIpFrom(h('203.0.113.7, junk'))).toBeNull();
    expect(payerIpFrom(h('203.0.113.7,'))).toBeNull();
    expect(payerIpFrom(h('999.1.1.1'))).toBeNull();
    expect(payerIpFrom(h('1.2.3'))).toBeNull();
    expect(payerIpFrom(h('01.2.3.4'))).toBeNull();
    expect(payerIpFrom(h('fe80::1%eth0'))).toBeNull();
    expect(payerIpFrom(h('[2001:db8::1]'))).toBeNull();
    expect(payerIpFrom(h('example.com'))).toBeNull();
    expect(payerIpFrom(new Headers())).toBeNull();
  });
});

describe('fetchPublicLink', () => {
  const VIEW = {
    merchant: { name: 'Acme', logo_url: null },
    title: 'T-shirt',
    description: null,
    amount_type: 'fixed',
    amount: '25000.00',
    currency: 'NGN',
    min_amount: null,
    usd_rate: '1600',
    note: 'optional',
    fee_payer: 'merchant',
    availability: 'available',
    livemode: false,
  };

  function stubFetch(status = 200, body: unknown = VIEW) {
    const fn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('fetchPublicLink sends the internal headers', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api.internal:4000');
    vi.stubEnv('WEB_INTERNAL_TOKEN', TOKEN);
    const fn = stubFetch();
    const view = await fetchPublicLink('acme', 'tshirt', true, '203.0.113.7');
    expect(view?.title).toBe('T-shirt');
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://api.internal:4000/v1/payment_links/public/acme/tshirt?mode=test');
    expect(init!.cache).toBe('no-store');
    const headers = new Headers(init!.headers);
    expect(headers.get('x-tendr-internal')).toBe(TOKEN);
    expect(headers.get('x-tendr-client-ip')).toBe('203.0.113.7');
  });

  it('asks for the live link without mode, and sends no client ip when unknown', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api.internal:4000');
    vi.stubEnv('WEB_INTERNAL_TOKEN', TOKEN);
    const fn = stubFetch();
    await fetchPublicLink('acme', 'tshirt', false, null);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://api.internal:4000/v1/payment_links/public/acme/tshirt');
    const headers = new Headers(init!.headers);
    expect(headers.get('x-tendr-internal')).toBe(TOKEN);
    expect(headers.has('x-tendr-client-ip')).toBe(false);
  });

  it('is null for an unknown link and throws on other failures', async () => {
    stubFetch(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    await expect(fetchPublicLink('acme', 'nope', false, null)).resolves.toBeNull();
    stubFetch(500, { error: { code: 'INTERNAL', message: 'boom' } });
    await expect(fetchPublicLink('acme', 'tshirt', false, null)).rejects.toThrow();
  });

  it('never puts the internal token in the public env', () => {
    vi.stubEnv('WEB_INTERNAL_TOKEN', TOKEN);
    expect(Object.keys(publicEnv).some((k) => /internal/i.test(k))).toBe(false);
    expect(JSON.stringify(publicEnv)).not.toContain(TOKEN);
  });
});
