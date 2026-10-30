import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(config.matcher).toEqual(
      expect.arrayContaining(['/connect', '/settings/notification-email/verify']),
    );
  });

  it('gives the notification-email verify page the strict, uncached policy', async () => {
    const res = await middleware(
      new NextRequest('http://localhost:3000/settings/notification-email/verify?t=abc'),
    );
    expect(ancestors(res)).toBe("'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
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
    expect(config.matcher).toEqual(expect.arrayContaining(['/preview/theme/:path*']));
  });
});
