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

describe('gasless routes', () => {
  it('posts options, prepare and submit, and reads a submission, with the Bearer header', async () => {
    const fetchFn = okFetch({});
    const c = createCheckoutClient({ baseUrl: BASE, secret: SECRET, fetchFn });
    await c.gaslessOptions({ origin_asset: 'nep141:x', wallet_address: '0x1' });
    await c.gaslessPrepare({ quote_id: 'quo_1', fee_mode: 'token' });
    await c.gaslessSubmit({ quote_id: 'quo_1', transaction: 'AAA=' });
    await c.gaslessSubmission('gas_1');
    const urls = fetchFn.mock.calls.map(([u, i]) => `${i!.method} ${u.slice(BASE.length)}`);
    expect(urls).toEqual([
      'POST /v1/checkout/client/gasless/options',
      'POST /v1/checkout/client/gasless/prepare',
      'POST /v1/checkout/client/gasless/submit',
      'GET /v1/checkout/client/gasless/submissions/gas_1',
    ]);
    expect(JSON.parse(String(fetchFn.mock.calls[2]![1]!.body))).toEqual({
      quote_id: 'quo_1',
      transaction: 'AAA=',
    });
    for (const [, init] of fetchFn.mock.calls) {
      expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    }
  });

  it('encodes the submission id into the path', async () => {
    const fetchFn = okFetch({});
    const c = createCheckoutClient({ baseUrl: BASE, secret: SECRET, fetchFn });
    await c.gaslessSubmission('tap_1/../x');
    expect(fetchFn.mock.calls[0]![0]).toBe(
      `${BASE}/v1/checkout/client/gasless/submissions/tap_1%2F..%2Fx`,
    );
  });

  it('sends the gasless quote fields', async () => {
    const fetchFn = okFetch({});
    const c = createCheckoutClient({ baseUrl: BASE, secret: SECRET, fetchFn });
    await c.quote({
      origin_asset: 'nep141:x',
      refund_address: '0x1',
      refund_chain: 'base',
      wallet_address: '0x1',
      gasless_method: 'eip3009',
      fee_mode: 'token',
    });
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body))).toMatchObject({
      wallet_address: '0x1',
      gasless_method: 'eip3009',
      fee_mode: 'token',
    });
  });
});
