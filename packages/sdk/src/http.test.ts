import { afterEach, describe, expect, it, vi } from 'vitest';
import { TendrClient } from './client.js';
import {
  TendrAbortError,
  TendrApiError,
  TendrConnectionError,
  TendrResponseError,
  TendrTimeoutError,
} from './errors.js';
const key = 'tdr_test_sdk_fixture';
const make = (implementation: typeof fetch, timeoutMs?: number) =>
  new TendrClient({ apiKey: key, fetch: implementation, timeoutMs });
const mock = () => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'ses_1' }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('transport guarantees', () => {
  it('defaults to the hosted API, isolates secret credentials, and refuses redirects/cookies', async () => {
    const fetch = mock();
    const client = make(fetch);
    await client.checkoutSessions.retrieve('ses_1');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.usetendr.tech/v1/checkout/sessions/ses_1');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(JSON.stringify(client)).not.toContain(key);
  });
  it.each(['', 'tdr_pk_live_x', 'tdr_test_x\nother'])(
    'rejects a missing or non-secret key: %s',
    (apiKey) => {
      expect(() => new TendrClient({ apiKey })).toThrow(TypeError);
    },
  );
  it.each([
    'http://api.example.com',
    'https://x.example/?secret=x',
    'https://user:pass@x.example',
    'https://x.example/#x',
    'ftp://x.example',
  ])('refuses an unsafe base URL: %s', (baseUrl) => {
    expect(() => new TendrClient({ apiKey: key, baseUrl })).toThrow(TypeError);
  });
  it('permits a local test server and rejects browser usage', () => {
    expect(() => new TendrClient({ apiKey: key, baseUrl: 'http://localhost:4000' })).not.toThrow();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(() => new TendrClient({ apiKey: key })).toThrow('server-only');
  });
  it('does not hide unknown API codes or request/Retry-After headers', async () => {
    const fetch = mock().mockResolvedValue(
      Response.json(
        { error: { code: 'NEW_CODE', message: 'Wait', details: { field: 'x' } } },
        { status: 429, headers: { 'x-request-id': 'req_1', 'retry-after': '10' } },
      ),
    );
    await expect(make(fetch).ping()).rejects.toMatchObject({
      name: 'TendrApiError',
      status: 429,
      code: 'NEW_CODE',
      requestId: 'req_1',
      retryAfter: '10',
      details: { field: 'x' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports HTML errors as HTTP failures without retaining their contents', async () => {
    const fetch = mock().mockResolvedValue(
      new Response('<html>internal details</html>', {
        status: 502,
        headers: { 'x-request-id': 'edge_1' },
      }),
    );
    const error = await make(fetch)
      .ping()
      .catch((e) => e);
    expect(error).toBeInstanceOf(TendrApiError);
    expect(error).toMatchObject({ status: 502, requestId: 'edge_1', code: 'HTTP_ERROR' });
    expect(JSON.stringify(error)).not.toContain('internal details');
  });
  it.each(['not JSON', 'null', '[]', '"ok"'])(
    'refuses invalid successful responses: %s',
    async (body) => {
      await expect(
        make(mock().mockResolvedValue(new Response(body))).ping(),
      ).rejects.toBeInstanceOf(TendrResponseError);
    },
  );
  it('never automatically repeats a write on a lost response', async () => {
    const fetch = mock().mockRejectedValue(new TypeError('network failed'));
    await expect(
      make(fetch).refunds.create(
        { session: 'ses_1', amount: '1.00', external_ref: 'r1' },
        { idempotencyKey: 'refund-r1' },
      ),
    ).rejects.toBeInstanceOf(TendrConnectionError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Idempotency-Key': 'refund-r1' },
      body: '{"session":"ses_1","amount":"1.00","external_ref":"r1"}',
    });
  });
  it('supports cancellation before a call without sending anything', async () => {
    const fetch = mock();
    const controller = new AbortController();
    controller.abort();
    await expect(make(fetch).ping({ signal: controller.signal })).rejects.toBeInstanceOf(
      TendrAbortError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('supports cancellation during a call and removes listeners', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const promise = make(fetch).ping({ signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(TendrAbortError);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('times out while reading a response body, not just awaiting headers', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
        ),
    );
    const assertion = expect(make(fetch, 1000).ping({ timeoutMs: 20 })).rejects.toMatchObject({
      name: 'TendrTimeoutError',
      timeoutMs: 20,
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(TendrTimeoutError.prototype).toBeInstanceOf(TendrConnectionError);
  });
  it.each([0, -1, Infinity, NaN, 0.5, 2 ** 32])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() => make(mock(), timeoutMs)).toThrow(TypeError);
  });
  it('rejects unsafe IDs and empty/overlong idempotency keys before network I/O', async () => {
    const fetch = mock();
    const client = make(fetch);
    for (const id of ['', '.', '..'])
      expect(() => client.checkoutSessions.retrieve(id)).toThrow(TypeError);
    for (const idempotencyKey of ['', 'x'.repeat(256), 'hello\nheader']) {
      await expect(client.checkoutSessions.expire('ses_1', { idempotencyKey })).rejects.toThrow(
        TypeError,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('cursor traversal', () => {
  it('keeps filters and advances using returned IDs without mutating the query', async () => {
    const fetch = mock()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'plink_2' }], has_more: true }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'plink_3' }], has_more: false }));
    const query = { starting_after: 'plink_1', status: 'active' as const, limit: 1 };
    const ids = [];
    for await (const link of make(fetch).paymentLinks.iterate(query)) ids.push(link.id);
    expect(ids).toEqual(['plink_2', 'plink_3']);
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      'starting_after=plink_2&status=active&limit=1',
    );
    expect(query.starting_after).toBe('plink_1');
  });
  it('does not fetch another page if the consumer stops early', async () => {
    const fetch = mock().mockResolvedValue(
      Response.json({ data: [{ id: 'th_1' }], has_more: true }),
    );
    const iterable = make(fetch).themes.iterate();
    expect(fetch).not.toHaveBeenCalled();
    for await (const item of iterable) {
      expect(item.id).toBe('th_1');
      break;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses hook next_cursor, and refuses a non-advancing server cursor', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ hook_calls: [{ id: 'hook_1' }], has_more: true, next_cursor: 'cursor_2' }),
    );
    const collect = async () => {
      for await (const _item of make(fetch).hookCalls.iterate()) {
        /* consume */
      }
    };
    await expect(collect()).rejects.toBeInstanceOf(TendrResponseError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain('starting_after=cursor_2');
  });
  it('rejects an empty page claiming more results', async () => {
    const fetch = mock().mockResolvedValue(
      Response.json({ gas_sponsorships: [], has_more: true, next_cursor: 'cursor_2' }),
    );
    await expect(make(fetch).gasSponsorships.iterate().next()).rejects.toBeInstanceOf(
      TendrResponseError,
    );
  });
});
