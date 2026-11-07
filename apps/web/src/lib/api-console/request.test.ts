import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultAuth, endpoints, exampleBody } from './catalog';
import { apiConsoleEnabled } from './enabled';
import { fillPath, prepareRequest, readResponse, requestUrl, type ConsoleRequest } from './request';

const base: ConsoleRequest = {
  method: 'POST',
  path: '/v1/payment_links',
  query: '',
  auth: 'session',
  bearer: 'secret-test-token',
  merchantId: 'mer_one',
  livemode: false,
  storeHeaders: true,
  csrf: 'csrf-test',
  headers: '{}',
  body: '{"amount":"123456789012345678.123456789"}',
  multipart: false,
  signingSecret: '',
};

describe('API console requests', () => {
  it('isolates session, bearer and public credentials and never follows redirects', async () => {
    for (const auth of ['session', 'bearer', 'public'] as const) {
      const { init } = await prepareRequest('https://api.example.test', { ...base, auth });
      const headers = new Headers(init.headers);
      expect(init.credentials).toBe(auth === 'session' ? 'include' : 'omit');
      expect(headers.get('authorization')).toBe(
        auth === 'bearer' ? 'Bearer secret-test-token' : null,
      );
      expect(headers.get('tendr-csrf')).toBe(auth === 'session' ? 'csrf-test' : null);
      expect(headers.get('tendr-merchant')).toBe(auth === 'session' ? 'mer_one' : null);
      expect(headers.get('tendr-livemode')).toBe(auth === 'session' ? 'false' : null);
      expect(init.redirect).toBe('error');
      expect(init.cache).toBe('no-store');
      expect(init.body).toBe(base.body);
    }
  });

  it('does not leak store headers into person routes or send bodies on reads', async () => {
    const { init } = await prepareRequest('http://localhost:4300', {
      ...base,
      method: 'GET',
      path: '/v1/me',
      storeHeaders: false,
    });
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('tendr-merchant')).toBe(false);
    expect(new Headers(init.headers).has('tendr-csrf')).toBe(false);
  });

  it('rejects external URLs, path escapes and credential overrides before sending', async () => {
    for (const path of [
      'https://evil.test/v1/me',
      '//evil.test/v1/me',
      '/v1/../../admin',
      '/v1/%2e%2e/admin',
      '/v1/\\evil',
      '/v1/me#token',
    ]) {
      expect(() => requestUrl('https://api.example.test', path, '')).toThrow();
    }
    await expect(
      prepareRequest('https://api.example.test', {
        ...base,
        headers: '{"Authorization":"Bearer other"}',
      }),
    ).rejects.toThrow('authentication');
    await expect(
      prepareRequest('https://api.example.test', { ...base, body: '{bad' }),
    ).rejects.toThrow();
  });

  it('encodes path parameters and keeps query values out of the origin', () => {
    expect(fillPath('/v1/themes/:id', { id: 'a/b?x=1' })).toBe('/v1/themes/a%2Fb%3Fx%3D1');
    expect(fillPath('/v1/assets/*', { '*': 'assets/mer_1/file name.png' })).toBe(
      '/v1/assets/assets/mer_1/file%20name.png',
    );
    expect(() => fillPath('/v1/themes/:id', {})).toThrow('id');
    expect(
      requestUrl('https://api.example.test', '/v1/payments', 'limit=20&starting_after=pay_1'),
    ).toBe('https://api.example.test/v1/payments?limit=20&starting_after=pay_1');
  });

  it('signs exact JSON and multipart bytes using the backend HMAC format', async () => {
    for (const multipart of [false, true]) {
      const { init } = await prepareRequest('http://localhost:4300', {
        ...base,
        multipart,
        signingSecret: 'test-signing-secret',
        file: new File(['image bytes'], 'test.png', { type: 'image/png' }),
        assetKind: 'logo',
      });
      const headers = new Headers(init.headers);
      const signature = headers.get('tendr-signature')!;
      const timestamp = /^t=(\d+),/.exec(signature)![1];
      const bytes =
        typeof init.body === 'string'
          ? Buffer.from(init.body)
          : Buffer.from(init.body as ArrayBuffer);
      const expected = createHmac('sha256', 'test-signing-secret')
        .update(`${timestamp}.`)
        .update(bytes)
        .digest('hex');
      expect(signature).toBe(`t=${timestamp},v1=${expected}`);
      if (multipart) {
        const parsed = await new Response(bytes, { headers }).formData();
        expect(parsed.get('kind')).toBe('logo');
        expect(await (parsed.get('file') as File).text()).toBe('image bytes');
        expect(headers.get('content-type')).toContain('boundary=');
      }
    }
  });

  it('bounds response display and cancels oversized response streams', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('123456789'));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readResponse(new Response(stream), 4)).toEqual({ text: '1234', truncated: true });
    expect(cancelled).toBe(true);
    expect(await readResponse(new Response(null, { status: 204 }))).toEqual({
      text: '',
      truncated: false,
    });
  });
});

describe('console availability and route defaults', () => {
  it('requires explicit opt-in outside development and supports an explicit off switch', () => {
    expect(apiConsoleEnabled('production', undefined)).toBe(false);
    expect(apiConsoleEnabled('production', 'true')).toBe(true);
    expect(apiConsoleEnabled('development', undefined)).toBe(true);
    expect(apiConsoleEnabled('development', 'false')).toBe(false);
  });
  it('covers unique routes with public, session and token defaults and valid JSON examples', () => {
    expect(new Set(endpoints.map((e) => e.id)).size).toBe(endpoints.length);
    for (const endpoint of endpoints) {
      expect(endpoint.principals.length).toBeGreaterThan(0);
      const body = exampleBody(endpoint);
      if (body) expect(() => JSON.parse(body)).not.toThrow();
    }
    const find = (id: string) => endpoints.find((e) => e.id === id)!;
    expect(defaultAuth(find('POST /v1/auth/email/verify'))).toBe('session');
    expect(defaultAuth(find('POST /v1/checkout/client/quote'))).toBe('bearer');
    expect(defaultAuth(find('GET /v1/health'))).toBe('public');
    expect(defaultAuth(find('POST /v1/payment_links'))).toBe('session');
  });
});
