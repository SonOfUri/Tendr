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

describe('client.themes', () => {
  it('publish posts to publish path', async () => {
    const { client, fetchMock } = setup(200, { id: 'th_1', object: 'theme' });
    await client.themes.publish('th_1');
    const c = call(fetchMock);
    expect([c.method, c.url]).toEqual(['POST', 'https://api.test/v1/themes/th_1/publish']);
  });

  it('setDefault posts to default path', async () => {
    const { client, fetchMock } = setup();
    await client.themes.setDefault('th_1');
    expect(call(fetchMock).url).toBe('https://api.test/v1/themes/th_1/default');
  });

  it('create sends the body and idempotency key', async () => {
    const { client, fetchMock } = setup(201);
    await client.themes.create(
      { name: 'Spring', from: { preset: 'fashion' } },
      { idempotencyKey: 'k' },
    );
    const c = call(fetchMock);
    expect(c.body).toEqual({ name: 'Spring', from: { preset: 'fashion' } });
    expect(c.headers['Idempotency-Key']).toBe('k');
  });

  it('list builds the query and presets/validate/preview hit their paths', async () => {
    const a = setup(200, { data: [], has_more: false });
    await a.client.themes.list({ limit: 5, starting_after: 'th_0' });
    expect(call(a.fetchMock).url).toBe('https://api.test/v1/themes?limit=5&starting_after=th_0');

    const b = setup(200, { data: [] });
    await b.client.themes.presets();
    expect(call(b.fetchMock).url).toBe('https://api.test/v1/themes/presets');

    const c = setup(200, { valid: true, problems: [] });
    await c.client.themes.validate({ schema_version: 1 });
    expect(call(c.fetchMock).body).toEqual({ document: { schema_version: 1 } });

    const d = setup(201, { url: 'x' });
    await d.client.themes.preview('th_1', {
      sample: 'checkout',
      scheme: 'dark',
      viewport: 'phone',
    });
    expect(call(d.fetchMock).url).toBe('https://api.test/v1/themes/th_1/preview');
  });

  it('update PATCHes, delete DELETEs, brand pulls POST', async () => {
    const a = setup();
    await a.client.themes.update('th_1', { name: 'New' });
    expect([call(a.fetchMock).method, call(a.fetchMock).body]).toEqual(['PATCH', { name: 'New' }]);
    const b = setup();
    await b.client.themes.delete('th_1');
    expect(call(b.fetchMock).method).toBe('DELETE');
    const c = setup(201);
    await c.client.themes.fromWebsite({ url: 'https://shop.example' });
    expect(call(c.fetchMock).url).toBe('https://api.test/v1/themes/from-website');
    const d = setup(201);
    await d.client.themes.fromStore({ connection_id: 'conn_1' });
    expect(call(d.fetchMock).url).toBe('https://api.test/v1/themes/from-store');
  });
});

describe('client.themeAssets', () => {
  it('upload sends multipart', async () => {
    const { client, fetchMock } = setup(201, { id: 'ta_1', object: 'theme_asset' });
    await client.themeAssets.upload({
      kind: 'logo',
      file: new Blob(['x'], { type: 'image/png' }),
      filename: 'logo.png',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/theme-assets');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('kind')).toBe('logo');
    expect((form.get('file') as File).name).toBe('logo.png');
    // fetch sets the multipart boundary itself
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('list and delete', async () => {
    const a = setup(200, { data: [] });
    await a.client.themeAssets.list();
    expect(call(a.fetchMock).url).toBe('https://api.test/v1/theme-assets');
    const b = setup();
    await b.client.themeAssets.delete('ta_1');
    expect([call(b.fetchMock).method, call(b.fetchMock).url]).toEqual([
      'DELETE',
      'https://api.test/v1/theme-assets/ta_1',
    ]);
  });
});

describe('client.checkoutSessions', () => {
  it('session create passes line_items and theme_id', async () => {
    const { client, fetchMock } = setup(201, { id: 'cs_1' });
    const input = {
      amount: '25.00',
      amount_currency: 'USD',
      external_ref: 'order-1',
      success_url: 'https://shop.example/ok',
      cancel_url: 'https://shop.example/no',
      theme_id: 'th_1',
      line_items: [{ name: 'Tee', quantity: 2, unit_amount: '12.50' }],
    };
    await client.checkoutSessions.create(input, { idempotencyKey: 'o1' });
    const c = call(fetchMock);
    expect([c.method, c.url]).toEqual(['POST', 'https://api.test/v1/checkout/sessions']);
    expect(c.body).toEqual(input);
    expect(c.headers['Idempotency-Key']).toBe('o1');
  });
});
