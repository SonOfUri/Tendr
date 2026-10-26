import { describe, expect, it } from 'vitest';
import { checkoutContentSecurityPolicy, contentSecurityPolicy } from './csp';
import { WALLET_CONNECT_HOSTS, WALLET_FRAME_HOSTS } from './checkout/wallet-hosts';

const directives = (csp: string) =>
  Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  ) as Record<string, string[]>;

describe('contentSecurityPolicy', () => {
  it('is the strict signing-page policy in production', () => {
    const d = directives(
      contentSecurityPolicy({ nonce: 'abc', apiBaseUrl: 'https://api.usetendr.tech/', dev: false }),
    );
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['script-src']).toEqual(["'self'", "'nonce-abc'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['connect-src']).toEqual(["'self'", 'https://api.usetendr.tech']);
    // No script host, no eval, no inline script without the nonce.
    expect(d['script-src']).not.toContain("'unsafe-eval'");
    expect(d['script-src']).not.toContain("'unsafe-inline'");
  });

  it('allows eval and hot reload only in development', () => {
    const d = directives(
      contentSecurityPolicy({ nonce: 'n', apiBaseUrl: 'http://localhost:4000', dev: true }),
    );
    expect(d['script-src']).toContain("'unsafe-eval'");
    expect(d['connect-src']).toEqual(["'self'", 'http://localhost:4000', 'ws:']);
  });
});

describe('checkoutContentSecurityPolicy (/pay/*)', () => {
  const base = {
    nonce: 'n1',
    apiBaseUrl: 'https://api.usetendr.tech',
    dev: false,
    walletHosts: ['https://rpc.wallet.example', 'wss://relay.wallet.example'],
    walletFrameHosts: ['https://verify.wallet.example'],
  };

  it("frames only from 'self' and the merchant's checkout domains", () => {
    const d = directives(
      checkoutContentSecurityPolicy({
        ...base,
        frameAncestors: ['https://shop.example', 'https://www.shop.example'],
      }),
    );
    expect(d['frame-ancestors']).toEqual([
      "'self'",
      'https://shop.example',
      'https://www.shop.example',
    ]);
    expect(d['script-src']).toEqual(["'self'", "'nonce-n1'"]);
    expect(d['object-src']).toEqual(["'none'"]);
  });

  it("excludes the merchant's domains when the session has none", () => {
    const d = directives(checkoutContentSecurityPolicy({ ...base, frameAncestors: [] }));
    expect(d['frame-ancestors']).toEqual(["'self'"]);
  });

  it("fails closed to 'self' when the lookup failed (null)", () => {
    const d = directives(checkoutContentSecurityPolicy({ ...base, frameAncestors: null }));
    expect(d['frame-ancestors']).toEqual(["'self'"]);
  });

  it('drops anything that is not a plain origin (no header injection, no wildcards)', () => {
    const csp = checkoutContentSecurityPolicy({
      ...base,
      frameAncestors: [
        'https://ok.example',
        "https://a.example; script-src 'unsafe-inline'",
        'https://*.example',
        '*',
        "'unsafe-inline'",
        'javascript:alert(1)',
        'https://b.example/path',
        'https://c.example\r\nSet-Cookie: x=1',
        'http://localhost:5173',
      ],
    });
    expect(csp).not.toMatch(/[\r\n]/);
    const d = directives(csp);
    expect(d['frame-ancestors']).toEqual(["'self'", 'https://ok.example', 'http://localhost:5173']);
    expect(d['script-src']).toEqual(["'self'", "'nonce-n1'"]);
  });

  it('connect-src is the API plus the wallet hosts', () => {
    const d = directives(checkoutContentSecurityPolicy({ ...base, frameAncestors: [] }));
    expect(d['connect-src']).toEqual([
      "'self'",
      'https://api.usetendr.tech',
      'https://rpc.wallet.example',
      'wss://relay.wallet.example',
    ]);
  });

  it("frame-src is 'self' plus the wallet frame hosts, filtered like connect-src", () => {
    const d = directives(
      checkoutContentSecurityPolicy({
        ...base,
        frameAncestors: [],
        walletFrameHosts: [
          'https://verify.wallet.example',
          "https://x.example; script-src 'unsafe-eval'",
          'javascript:alert(1)',
          '*',
        ],
      }),
    );
    expect(d['frame-src']).toEqual(["'self'", 'https://verify.wallet.example']);
    expect(d['script-src']).toEqual(["'self'", "'nonce-n1'"]);
  });

  it('uses the wallet-hosts lists: no remote script, no eval, no inline script', () => {
    const csp = checkoutContentSecurityPolicy({
      nonce: 'n1',
      apiBaseUrl: 'https://api.usetendr.tech',
      dev: false,
      frameAncestors: [],
      walletHosts: WALLET_CONNECT_HOSTS,
      walletFrameHosts: WALLET_FRAME_HOSTS,
    });
    const d = directives(csp);
    expect(d['connect-src']).toEqual([
      "'self'",
      'https://api.usetendr.tech',
      ...WALLET_CONNECT_HOSTS,
    ]);
    expect(d['frame-src']).toEqual(["'self'", ...WALLET_FRAME_HOSTS]);
    // The wallet providers this checkout talks to.
    expect(WALLET_CONNECT_HOSTS).toEqual(
      expect.arrayContaining([
        'wss://relay.walletconnect.org',
        'https://rpc.walletconnect.org',
        'https://api.web3modal.org',
        'https://api.trongrid.io',
        'https://free.rpc.fastnear.com',
      ]),
    );
    expect(WALLET_FRAME_HOSTS).toEqual([
      'https://verify.walletconnect.org',
      'https://verify.walletconnect.com',
    ]);
    expect(d['script-src']).toEqual(["'self'", "'nonce-n1'"]);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline'[^;]*script/);
  });

  it('allows https images (the store logo) and no eval outside development', () => {
    const d = directives(checkoutContentSecurityPolicy({ ...base, frameAncestors: [] }));
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    expect(d['script-src']).not.toContain("'unsafe-eval'");
  });
});
