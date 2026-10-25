import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setStoreContext } from './api';

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const headersOf = (c: Call) => new Headers(c.init.headers);

describe('api', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { cookie: 'other=1; tendr_csrf=csrf-value-123; x=y' });
    vi.stubGlobal('sessionStorage', memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('api_sends_csrf_and_merchant_headers', async () => {
    setStoreContext({ merchantId: 'mer_01ABC', livemode: true });
    const calls = stubFetch(201, { ok: true });
    const res = await api<{ ok: boolean }>('/v1/team/invites', {
      method: 'POST',
      json: { email: 'a@b.co', role: 'finance' },
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://localhost:4000/v1/team/invites');
    expect(call.init.credentials).toBe('include');
    const h = headersOf(call);
    expect(h.get('Tendr-CSRF')).toBe('csrf-value-123');
    expect(h.get('Tendr-Merchant')).toBe('mer_01ABC');
    expect(h.get('Tendr-Livemode')).toBe('true');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(call.init.body).toBe(JSON.stringify({ email: 'a@b.co', role: 'finance' }));
  });

  it('omits store headers for person routes and overrides the mode per call', async () => {
    setStoreContext({ merchantId: 'mer_01ABC', livemode: false });
    const calls = stubFetch(200, {});
    await api('/v1/me', { store: false });
    expect(headersOf(calls[0]!).get('Tendr-Merchant')).toBeNull();
    expect(headersOf(calls[0]!).get('Tendr-Livemode')).toBeNull();
    await api('/v1/account/balances', { livemode: true });
    expect(headersOf(calls[1]!).get('Tendr-Merchant')).toBe('mer_01ABC');
    expect(headersOf(calls[1]!).get('Tendr-Livemode')).toBe('true');
    // A GET carries no CSRF header and no body.
    expect(headersOf(calls[1]!).get('Tendr-CSRF')).toBeNull();
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it('throws a typed error from the error envelope', async () => {
    stubFetch(401, {
      error: { code: 'STEP_UP_REQUIRED', message: 'Confirm with your passkey', requestId: 'req_1' },
    });
    const err = await api('/v1/account/go-live', { method: 'POST', json: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'STEP_UP_REQUIRED', requestId: 'req_1' });
  });

  it('returns undefined for 204', async () => {
    stubFetch(204, undefined);
    await expect(api('/v1/auth/logout', { method: 'POST', json: {} })).resolves.toBeUndefined();
  });
});
