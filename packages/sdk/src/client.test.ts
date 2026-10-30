import { describe, expect, it, vi } from 'vitest';
import { TendrApiError } from './errors.js';
import { TendrClient } from './client.js';

const LINK = { id: 'plink_1', object: 'payment_link', title: 'Tee' };

function setup(status = 200, body: unknown = LINK) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const client = new TendrClient({
    baseUrl: 'https://api.test/',
    apiKey: 'tdr_test_x',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

const call = (m: ReturnType<typeof setup>['fetchMock']) => {
  const [url, init] = m.mock.calls[0]!;
  return {
    url,
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    headers: init?.headers as Record<string, string>,
  };
};

describe('client.paymentLinks', () => {
  it('create POSTs the body with the key', async () => {
    const { client, fetchMock } = setup(201);
    const input = {
      title: 'Tee',
      amount_type: 'fixed' as const,
      amount: '25.00',
      currency: 'USD',
      note: 'optional' as const,
    };
    await expect(client.paymentLinks.create(input)).resolves.toMatchObject({ id: 'plink_1' });
    const c = call(fetchMock);
    expect(c.url).toBe('https://api.test/v1/payment_links');
    expect(c.method).toBe('POST');
    expect(c.body).toEqual(input);
    expect(c.headers.Authorization).toBe('Bearer tdr_test_x');
  });

  it('create sends an Idempotency-Key when given', async () => {
    const { client, fetchMock } = setup(201);
    await client.paymentLinks.create(
      { title: 'Tee', amount_type: 'open', currency: 'USD', note: 'off' },
      { idempotencyKey: 'k1' },
    );
    expect(call(fetchMock).headers['Idempotency-Key']).toBe('k1');
  });

  it('list GETs with the query string', async () => {
    const { client, fetchMock } = setup(200, { data: [], has_more: false });
    await client.paymentLinks.list({ status: 'active', include_archived: true, limit: 5 });
    const c = call(fetchMock);
    expect(c.method).toBe('GET');
    expect(c.url).toBe(
      'https://api.test/v1/payment_links?status=active&include_archived=true&limit=5',
    );
    expect(c.body).toBeUndefined();
  });

  it('list without a query has no question mark', async () => {
    const { client, fetchMock } = setup(200, { data: [], has_more: false });
    await client.paymentLinks.list();
    expect(call(fetchMock).url).toBe('https://api.test/v1/payment_links');
  });

  it('retrieve GETs one link', async () => {
    const { client, fetchMock } = setup();
    await client.paymentLinks.retrieve('plink_1');
    const c = call(fetchMock);
    expect([c.method, c.url]).toEqual(['GET', 'https://api.test/v1/payment_links/plink_1']);
  });

  it('update PATCHes, null clears a field', async () => {
    const { client, fetchMock } = setup();
    await client.paymentLinks.update('plink_1', { status: 'inactive', max_uses: null });
    const c = call(fetchMock);
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe('https://api.test/v1/payment_links/plink_1');
    expect(c.body).toEqual({ status: 'inactive', max_uses: null });
  });

  it('archive DELETEs', async () => {
    const { client, fetchMock } = setup();
    await client.paymentLinks.archive('plink_1');
    const c = call(fetchMock);
    expect([c.method, c.url]).toEqual(['DELETE', 'https://api.test/v1/payment_links/plink_1']);
  });

  it('escapes the id', async () => {
    const { client, fetchMock } = setup();
    await client.paymentLinks.retrieve('a/b');
    expect(call(fetchMock).url).toBe('https://api.test/v1/payment_links/a%2Fb');
  });

  it('throws TendrApiError with the API code', async () => {
    const { client } = setup(409, {
      error: { code: 'LINK_UNAVAILABLE', message: 'no', requestId: 'r1' },
    });
    const err = await client.paymentLinks.retrieve('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TendrApiError);
    expect(err).toMatchObject({ code: 'LINK_UNAVAILABLE', status: 409 });
  });
});
