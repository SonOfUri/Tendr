import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_FOUND_PATH } from './lib/hosts';
import { config, middleware } from './middleware';

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';

function fetchStub() {
  const fetchFn = vi.fn(
    async () =>
      new Response(JSON.stringify({ origins: ['https://shop.example'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

const ancestors = (res: Response) =>
  /frame-ancestors ([^;]*)/.exec(res.headers.get('content-security-policy') ?? '')?.[1];

afterEach(() => vi.unstubAllGlobals());

/** Whether the middleware runs for `path` (the matcher read as the regex Next compiles it to). */
function matches(path: string): boolean {
  return config.matcher.some((m) => new RegExp(`^${m}$`).test(path));
}

describe('middleware /pay/* frame-ancestors (C29)', () => {
  it("serves 'self' without asking the API when Sec-Fetch-Dest is missing", async () => {
    const fetchFn = fetchStub();
    const res = await middleware(new NextRequest(`http://localhost:3000/pay/${SESSION}`));
    expect(ancestors(res)).toBe("'self'");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it("serves 'self' without asking the API for a top-level load", async () => {
    const fetchFn = fetchStub();
    const res = await middleware(
      new NextRequest(`http://localhost:3000/pay/${SESSION}`, {
        headers: { 'sec-fetch-dest': 'document' },
      }),
    );
    expect(ancestors(res)).toBe("'self'");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('looks up the checkout domains for an iframe load', async () => {
    const fetchFn = fetchStub();
    const res = await middleware(
      new NextRequest(`http://localhost:3000/pay/${SESSION}`, {
        headers: { 'sec-fetch-dest': 'iframe' },
      }),
    );
    expect(ancestors(res)).toBe("'self' https://shop.example");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps the dashboard policy unframeable', async () => {
    const res = await middleware(new NextRequest('http://localhost:3000/dashboard'));
    expect(ancestors(res)).toBe("'none'");
  });
});

describe('middleware /connect', () => {
  const directive = (res: Response, name: string) =>
    new RegExp(`(?:^|; )${name} ([^;]*)`).exec(
      res.headers.get('content-security-policy') ?? '',
    )?.[1];

  it('serves its own unframeable nonce policy that posts forms only to itself', async () => {
    const fetchFn = fetchStub();
    const res = await middleware(
      new NextRequest('http://localhost:3000/connect?site_url=https%3A%2F%2Fshop.example&state=x', {
        headers: { 'sec-fetch-dest': 'iframe' },
      }),
    );
    expect(directive(res, 'frame-ancestors')).toBe("'none'");
    expect(directive(res, 'frame-src')).toBe("'none'");
    expect(directive(res, 'form-action')).toBe("'self'");
    expect(directive(res, 'script-src')).toMatch(/^'self' 'nonce-[A-Za-z0-9+/=]+'$/);
    expect(directive(res, 'default-src')).toBe("'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Nothing from the query reaches the policy, and no frame lookup is made.
    expect(res.headers.get('content-security-policy')).not.toContain('shop.example');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('runs on /connect and the verify page', () => {
    expect(matches('/connect')).toBe(true);
    expect(matches('/settings/notification-email/verify')).toBe(true);
  });

  it('gives the notification-email verify page the strict, uncached policy', async () => {
    const res = await middleware(
      new NextRequest('http://localhost:3000/settings/notification-email/verify?t=abc'),
    );
    expect(ancestors(res)).toBe("'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Personal settings and recovery isolation', () => {
  it.each([
    '/settings/api-console',
    '/settings/local-mail',
    '/settings/login-recovery',
    '/recover/login',
  ])('uses the signing-page CSP and never caches %s', async (path) => {
    const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(ancestors(res)).toBe("'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
  });
});

describe('middleware payment link pages', () => {
  it('qr route not forced no-store; link page is', async () => {
    const fetchFn = fetchStub();
    const page = await middleware(new NextRequest('http://localhost:3000/pay/acme/tip-jar'));
    expect(page.headers.get('cache-control')).toBe('no-store');
    const test = await middleware(
      new NextRequest('http://localhost:3000/pay/acme/tip-jar?mode=test'),
    );
    expect(test.headers.get('cache-control')).toBe('no-store');
    for (const sub of ['qr', 'opengraph-image', 'twitter-image', 'opengraph-image-1x2y3z']) {
      const res = await middleware(
        new NextRequest(`http://localhost:3000/pay/acme/tip-jar/${sub}`),
      );
      expect(res.headers.get('cache-control'), sub).toBeNull();
    }
    // A session's sub-page keeps no-store, and link pages never ask for frame origins.
    const refund = await middleware(
      new NextRequest(`http://localhost:3000/pay/${SESSION}/refund-address?t=x`),
    );
    expect(refund.headers.get('cache-control')).toBe('no-store');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('middleware theme preview (/preview/theme/*)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('gets the checkout policy, uncached and framed by Tendr only', async () => {
    vi.stubEnv('TENDR_ASSET_ORIGIN', 'https://assets.usetendr.tech/tendr-assets');
    const fetchFn = fetchStub();
    const res = await middleware(
      new NextRequest('http://localhost:3000/preview/theme/abcdefghijklmnopqrstuvwxyz012345', {
        headers: { 'sec-fetch-dest': 'iframe' },
      }),
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(ancestors(res)).toBe("'self'");
    expect(csp).toMatch(/frame-src [^;]*https:\/\/www\.youtube-nocookie\.com/);
    expect(csp).toMatch(/img-src [^;]*https:\/\/assets\.usetendr\.tech/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(matches('/preview/theme/abc')).toBe(true);
  });
});

describe('middleware matcher', () => {
  it('runs on every page, including the root forms, and skips Next internals and static files', () => {
    for (const path of ['/', `/${SESSION}`, '/acme/coffee', '/acme/coffee/qr', '/pay/x', '/demo']) {
      expect(matches(path), path).toBe(true);
    }
    for (const path of ['/_next/static/x.js', '/_next/image', '/icons/icon-192.png', '/sw.js']) {
      expect(matches(path), path).toBe(false);
    }
  });
});

describe('middleware pages without a policy', () => {
  it('passes the demo, legal pages and route handlers through untouched, as before', async () => {
    for (const path of [
      '/',
      '/demo',
      '/privacy',
      '/api/demo/checkout',
      '/v1/plugins/woocommerce',
    ]) {
      const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
      expect(res.headers.get('content-security-policy'), path).toBeNull();
      expect(res.headers.get('cache-control'), path).toBeNull();
    }
  });
});

describe('middleware hosts (deploy §1)', () => {
  afterEach(() => vi.unstubAllEnvs());

  function hosts() {
    vi.stubEnv('CHECKOUT_BASE_URL', 'https://pay.usetendr.tech');
    vi.stubEnv('WEB_URL', 'https://app.usetendr.tech');
  }

  it('rewrites a root-form checkout on the pay host and gives it the checkout policy', async () => {
    hosts();
    // Not SESSION: the lookup cache would answer for it without a fetch.
    const id = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ9';
    const fetchFn = fetchStub();
    const res = await middleware(
      new NextRequest(`https://pay.usetendr.tech/${id}?embed=modal`, {
        headers: { 'sec-fetch-dest': 'iframe' },
      }),
    );
    expect(new URL(res.headers.get('x-middleware-rewrite')!).pathname).toBe(`/pay/${id}`);
    expect(new URL(res.headers.get('x-middleware-rewrite')!).search).toBe('?embed=modal');
    expect(ancestors(res)).toBe("'self' https://shop.example");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('keeps a root-form link asset cacheable', async () => {
    hosts();
    const res = await middleware(new NextRequest('https://pay.usetendr.tech/acme/coffee/qr'));
    expect(new URL(res.headers.get('x-middleware-rewrite')!).pathname).toBe('/pay/acme/coffee/qr');
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('redirects the old form and merchant pages, and 404s the demo', async () => {
    hosts();
    const old = await middleware(new NextRequest('https://pay.usetendr.tech/pay/acme/coffee?x=1'));
    expect(old.status).toBe(308);
    expect(old.headers.get('location')).toBe('https://pay.usetendr.tech/acme/coffee?x=1');
    const dash = await middleware(new NextRequest('https://pay.usetendr.tech/dashboard'));
    expect(dash.status).toBe(308);
    expect(dash.headers.get('location')).toBe('https://app.usetendr.tech/dashboard');
    const root = await middleware(new NextRequest('https://app.usetendr.tech/'));
    expect(root.headers.get('location')).toBe('https://app.usetendr.tech/dashboard');
    // A path no route serves: Next renders the not-found page with a 404.
    const demo = await middleware(new NextRequest('https://app.usetendr.tech/demo'));
    expect(new URL(demo.headers.get('x-middleware-rewrite')!).pathname).toBe(NOT_FOUND_PATH);
  });

  it('serves merchant pages on the app host with the strict policy', async () => {
    hosts();
    const res = await middleware(new NextRequest('https://app.usetendr.tech/dashboard'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(ancestors(res)).toBe("'none'");
  });

  it('fails open (as before) when the env origins are missing or broken', async () => {
    vi.stubEnv('CHECKOUT_BASE_URL', 'not a url');
    vi.stubEnv('WEB_URL', '');
    const res = await middleware(new NextRequest('https://pay.usetendr.tech/dashboard'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(ancestors(res)).toBe("'none'");
  });
});
