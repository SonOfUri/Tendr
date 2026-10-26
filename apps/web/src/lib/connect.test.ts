import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DETAIL,
  approvalCopy,
  authorizeBody,
  cancelRedirect,
  checkedRedirect,
  clearConnectParams,
  CONNECT_STORAGE_KEY,
  domainsUsedByConnections,
  eligibleStores,
  loadConnectParams,
  markConnectWaiting,
  parseConnectParams,
  saveConnectParams,
  siteLabel,
  takeConnectWaiting,
  type ConnectParams,
} from './connect';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function query(over: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string | null> = {
    site_url: 'https://shop.example.com',
    return_url: 'https://shop.example.com/wp-json/tendr/v1/connect/return',
    state: 'st_abc123',
    code_challenge: CHALLENGE,
    platform: 'woocommerce',
    plugin_version: '1.0.0',
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== null) q.set(k, v);
  return q;
}

function params(): ConnectParams {
  const r = parseConnectParams(query());
  if (!r.ok) throw new Error(r.error);
  return r.params;
}

/** A Storage backed by a Map, as a tab's sessionStorage / localStorage. */
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

describe('parseConnectParams', () => {
  it('accepts the plugin parameters and defaults the method to S256', () => {
    const r = parseConnectParams(query());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.code_challenge_method).toBe('S256');
      expect(r.params.site_url).toBe('https://shop.example.com');
    }
  });

  it('parseConnectParams rejects return_url on another origin', () => {
    for (const return_url of [
      'https://evil.example/wp-json/tendr/v1/connect/return',
      'http://shop.example.com/wp-json/tendr/v1/connect/return',
      'https://shop.example.com:8443/return',
      'https://sub.shop.example.com/return',
    ]) {
      const r = parseConnectParams(query({ return_url }));
      expect(r.ok, return_url).toBe(false);
    }
  });

  it('rejects a return_url with a fragment, credentials or a non-http scheme', () => {
    for (const return_url of [
      'https://shop.example.com/return#x',
      'https://shop.example.com/return#',
      'https://user:pw@shop.example.com/return',
      'javascript:alert(1)',
      'ftp://shop.example.com/return',
    ]) {
      expect(parseConnectParams(query({ return_url })).ok, return_url).toBe(false);
    }
  });

  it('rejects missing, repeated or malformed parameters', () => {
    expect(parseConnectParams(query({ state: null })).ok).toBe(false);
    expect(parseConnectParams(query({ code_challenge: 'short' })).ok).toBe(false);
    expect(parseConnectParams(query({ code_challenge_method: 'plain' })).ok).toBe(false);
    expect(parseConnectParams(query({ platform: 'shopify' })).ok).toBe(false);
    expect(parseConnectParams(query({ plugin_version: '1.0 beta' })).ok).toBe(false);
    expect(parseConnectParams(query({ site_url: 'not a url' })).ok).toBe(false);
    const twice = query();
    twice.append('state', 'other');
    expect(parseConnectParams(twice).ok).toBe(false);
  });
});

describe('connect params in sessionStorage', () => {
  it('connect params survive the magic-link round trip', () => {
    const tab = memoryStorage();
    const p = params();
    saveConnectParams(p, tab);
    // Sign-up sends the email link; the person comes back to /connect (no query) in this tab.
    expect(loadConnectParams(tab)).toEqual(p);
    expect(tab.getItem(CONNECT_STORAGE_KEY)).not.toBeNull();
    clearConnectParams(tab);
    expect(loadConnectParams(tab)).toBeNull();
  });

  it('drops stored params that are stale or tampered with', () => {
    const tab = memoryStorage();
    saveConnectParams(params(), tab);
    expect(loadConnectParams(tab, Date.now() + 2 * 60 * 60_000)).toBeNull();
    tab.setItem(
      CONNECT_STORAGE_KEY,
      JSON.stringify({
        at: Date.now(),
        params: { ...params(), return_url: 'https://evil.example/' },
      }),
    );
    expect(loadConnectParams(tab)).toBeNull();
  });

  it('the email-link tab learns only that a connect is waiting, never the parameters', () => {
    const shared = memoryStorage();
    markConnectWaiting(shared);
    const raw = [...Array(shared.length).keys()].map((i) => shared.getItem(shared.key(i)!)).join();
    expect(raw).not.toContain('shop.example.com');
    expect(raw).not.toContain(CHALLENGE);
    expect(takeConnectWaiting(shared)).toBe(true);
    expect(takeConnectWaiting(shared)).toBe(false);
  });
});

describe('store picker', () => {
  it('store picker lists only owner/admin stores', () => {
    const stores = [
      { id: 'mer_1', role: 'owner' as const },
      { id: 'mer_2', role: 'admin' as const },
      { id: 'mer_3', role: 'finance' as const },
      { id: 'mer_4', role: 'viewer' as const },
    ];
    expect(eligibleStores(stores).map((s) => s.id)).toEqual(['mer_1', 'mer_2']);
  });
});

describe('approval screen', () => {
  it('approval copy matches spec', () => {
    expect(approvalCopy(siteLabel(params()), 'Acme Coffee')).toBe(
      "Connect shop.example.com to Acme Coffee? This lets the site create checkouts, receive payment updates and request refunds. Refunds still need your signers' approval.",
    );
    expect(APPROVAL_DETAIL).toBe(
      "This lets the site create checkouts, receive payment updates and request refunds. Refunds still need your signers' approval.",
    );
  });

  it('labels a site in a subdirectory with its path', () => {
    const r = parseConnectParams(
      query({
        site_url: 'https://example.com/shop/',
        return_url: 'https://example.com/shop/wp-json/tendr/v1/connect/return',
      }),
    );
    expect(r.ok && siteLabel(r.params)).toBe('example.com/shop');
  });

  it('sends the authorize body the API expects', () => {
    expect(authorizeBody(params())).toEqual({
      site_url: 'https://shop.example.com',
      return_url: 'https://shop.example.com/wp-json/tendr/v1/connect/return',
      state: 'st_abc123',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      platform: 'woocommerce',
      plugin_version: '1.0.0',
    });
  });
});

describe('redirects', () => {
  it('only follows a redirect back to the return_url', () => {
    const p = params();
    const good = `${p.return_url}?code=abc&state=st_abc123`;
    expect(checkedRedirect(good, p.return_url)).toBe(good);
    expect(checkedRedirect('https://evil.example/?code=abc', p.return_url)).toBeNull();
    expect(checkedRedirect('https://shop.example.com/elsewhere?code=abc', p.return_url)).toBeNull();
    expect(checkedRedirect('javascript:alert(1)', p.return_url)).toBeNull();
    expect(checkedRedirect('not a url', p.return_url)).toBeNull();
  });

  it('Cancel builds the access_denied URL', () => {
    const r = parseConnectParams(
      query({ return_url: 'https://shop.example.com/?rest_route=/tendr/v1/connect/return' }),
    );
    if (!r.ok) throw new Error(r.error);
    const u = new URL(cancelRedirect(r.params));
    expect(u.origin).toBe('https://shop.example.com');
    expect(u.searchParams.get('rest_route')).toBe('/tendr/v1/connect/return');
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('state')).toBe('st_abc123');
    expect(u.searchParams.has('code')).toBe(false);
  });
});

describe('domainsUsedByConnections', () => {
  const site = (id: string, site_url: string, status: 'active' | 'revoked' = 'active') => ({
    id,
    site_url,
    status,
  });

  it('names the live connections whose domain a save would remove', () => {
    const before = ['https://shop.example.com', 'https://other.example', 'https://hand.example'];
    const after = ['https://hand.example'];
    const hits = domainsUsedByConnections(before, after, [
      site('con_1', 'https://shop.example.com'),
      site('con_2', 'https://other.example', 'revoked'),
      site('con_3', 'https://hand.example'),
    ]);
    expect(hits).toEqual([
      { origin: 'https://shop.example.com', site_url: 'https://shop.example.com' },
    ]);
  });

  it('ignores case and trailing slashes', () => {
    expect(
      domainsUsedByConnections(
        ['https://Shop.Example.com'],
        ['https://shop.example.com/'],
        [site('con_1', 'https://shop.example.com/store')],
      ),
    ).toEqual([]);
  });
});
