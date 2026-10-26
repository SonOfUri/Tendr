import { describe, expect, it, vi } from 'vitest';
import { CheckoutApiError, createCheckoutClient, submitRefundAddressByToken } from './api';

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const SECRET = `${SESSION}_secret_0123456789abcdef0123456789abcdef`;
const BASE = 'https://api.tendr.test';

function okFetch(body: unknown = {}, status = 200) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('checkout API client', () => {
  it('sends the client secret only as a Bearer header, never in a URL or body', async () => {
    const fetchFn = okFetch({ id: SESSION });
    const c = createCheckoutClient({ baseUrl: BASE, secret: SECRET, fetchFn });
    await c.session();
    await c.tokens();
    await c.quote({ origin_asset: 'nep141:eth.test' });
    await c.deposit('0xabc', 'quo_01JABCDEFGHJKMNPQRSTVWXYZ0');
    await c.email('a@b.example');
    await c.refundAddress({ address: '0x1', chain: 'eth' });
    await c.simulate('exact');
    expect(fetchFn).toHaveBeenCalledTimes(7);
    const dep = fetchFn.mock.calls.find(([u]) => u.endsWith('/deposit'))!;
    expect(JSON.parse(String(dep[1]!.body))).toEqual({
      tx_hash: '0xabc',
      quote_id: 'quo_01JABCDEFGHJKMNPQRSTVWXYZ0',
    });
    for (const [url, init] of fetchFn.mock.calls) {
      expect(url).not.toContain(SECRET);
      expect(url).not.toContain('secret');
      expect(url.startsWith(`${BASE}/v1/checkout/client/`)).toBe(true);
      expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
      expect(init!.credentials).toBe('omit');
      expect(String(init!.body ?? '')).not.toContain(SECRET);
    }
  });

  it('maps the error envelope to CheckoutApiError', async () => {
    const fetchFn = okFetch(
      { error: { code: 'QUOTE_PRICE_MOVED', message: 'moved', details: { a: 1 } } },
      409,
    );
    const c = createCheckoutClient({ baseUrl: BASE, secret: SECRET, fetchFn });
    const err = await c.quote({ origin_asset: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckoutApiError);
    expect(err).toMatchObject({ status: 409, code: 'QUOTE_PRICE_MOVED', details: { a: 1 } });
  });

  it('reports a network failure as NETWORK_ERROR (status 0)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const c = createCheckoutClient({ baseUrl: BASE, secret: SECRET, fetchFn });
    await expect(c.session()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('the emailed link posts the token in the body, with no Authorization header', async () => {
    const fetchFn = okFetch({ refund_id: 'ref_1', status: 'queued' });
    await submitRefundAddressByToken(
      { baseUrl: BASE, fetchFn },
      { token: 'ref_1.abc', address: '0x1', chain: 'eth' },
    );
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/checkout/refund-address`);
    expect(new Headers(init!.headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(init!.body))).toEqual({
      token: 'ref_1.abc',
      address: '0x1',
      chain: 'eth',
    });
  });
});
