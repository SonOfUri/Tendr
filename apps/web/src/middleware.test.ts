import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleware } from './middleware';

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
