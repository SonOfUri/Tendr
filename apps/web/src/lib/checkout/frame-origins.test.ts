import { describe, expect, it, vi } from 'vitest';
import { checkoutSessionIdOf, createFrameOriginsLookup, needsFrameLookup } from './frame-origins';

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const API = 'https://api.tendr.test';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('frame-origins lookup (middleware)', () => {
  it('fetches the public route and returns the origins', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ origins: ['https://shop.example'] }),
    );
    const lookup = createFrameOriginsLookup({ apiBaseUrl: `${API}/`, fetchFn });
    expect(await lookup(SESSION)).toEqual(['https://shop.example']);
    expect(fetchFn.mock.calls[0]![0]).toBe(`${API}/v1/checkout/public/${SESSION}/frame-origins`);
  });

  it('caches a success briefly (≤ 60 s), then asks again', async () => {
    let now = 1_000_000;
    const fetchFn = vi.fn(async () => json({ origins: ['https://shop.example'] }));
    const lookup = createFrameOriginsLookup({ apiBaseUrl: API, fetchFn, now: () => now });
    await lookup(SESSION);
    now += 30_000;
    await lookup(SESSION);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 31_000;
    await lookup(SESSION);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails closed (null) on an error status, bad JSON, or a network error, and does not cache it', async () => {
    for (const make of [
      async () => json({ error: { code: 'RATE_LIMITED' } }, 429),
      async () => new Response('nope', { status: 200 }),
      async () => json({ origins: 'https://shop.example' }),
      async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const fetchFn = vi.fn(make);
      const lookup = createFrameOriginsLookup({ apiBaseUrl: API, fetchFn });
      expect(await lookup(SESSION)).toBeNull();
      expect(await lookup(SESSION)).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(2);
    }
  });

  it('fails closed (null) when the API takes longer than the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const lookup = createFrameOriginsLookup({ apiBaseUrl: API, fetchFn, timeoutMs: 1500 });
      const pending = lookup(SESSION);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only well-formed origins from the response', async () => {
    const fetchFn = vi.fn(async () =>
      json({ origins: ['https://shop.example', "x'; script-src *", 42, 'https://*.x'] }),
    );
    const lookup = createFrameOriginsLookup({ apiBaseUrl: API, fetchFn });
    expect(await lookup(SESSION)).toEqual(['https://shop.example']);
  });
});

describe('which /pay requests need the lookup', () => {
  it('only the checkout page itself, by session id', () => {
    expect(checkoutSessionIdOf(`/pay/${SESSION}`)).toBe(SESSION);
    expect(checkoutSessionIdOf(`/pay/${SESSION}/`)).toBe(SESSION);
    expect(checkoutSessionIdOf(`/pay/${SESSION}/refund-address`)).toBeNull();
    expect(checkoutSessionIdOf('/pay/not-a-session')).toBeNull();
    expect(checkoutSessionIdOf('/dashboard')).toBeNull();
  });

  it("looks up only for iframe/frame loads; anything else (header missing too) gets 'self' (C29)", () => {
    expect(needsFrameLookup('iframe')).toBe(true);
    expect(needsFrameLookup('frame')).toBe(true);
    expect(needsFrameLookup(null)).toBe(false); // header not sent: no lookup, 'self' only
    expect(needsFrameLookup('document')).toBe(false);
    expect(needsFrameLookup('empty')).toBe(false);
  });
});
