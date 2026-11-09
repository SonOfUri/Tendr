import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RESERVED_LINK_SLUGS } from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import { KNOWN_TOP_LEVEL_PATHS, isShopperPath, routeForHost, type HostRoute } from './hosts';

const PAY = 'https://pay.usetendr.tech';
const APP = 'https://app.usetendr.tech';
const LANDING = 'https://usetendr.tech';

function route(
  host: string,
  url: string,
  opts: { payOrigin?: string | null; appOrigin?: string | null; dev?: boolean } = {},
): HostRoute {
  const u = new URL(url, 'http://x');
  return routeForHost({
    host,
    pathname: u.pathname,
    search: u.search,
    payOrigin: opts.payOrigin === undefined ? PAY : opts.payOrigin,
    appOrigin: opts.appOrigin === undefined ? APP : opts.appOrigin,
    landingUrl: LANDING,
    dev: opts.dev,
  });
}

const next = { kind: 'next' };
const notFound = { kind: 'notFound' };
const rewrite = (pathname: string) => ({ kind: 'rewrite', pathname });
const redirect = (url: string) => ({ kind: 'redirect', url, status: 308 });

describe('routeForHost: the pay host', () => {
  const pay = (url: string) => route('pay.usetendr.tech', url);

  it.each([
    ['/ses_1', '/pay/ses_1'],
    ['/ses_1/refund-address', '/pay/ses_1/refund-address'],
    ['/acme/coffee', '/pay/acme/coffee'],
    ['/acme/coffee/qr', '/pay/acme/coffee/qr'],
    ['/acme/coffee/opengraph-image', '/pay/acme/coffee/opengraph-image'],
    ['/acme/coffee/opengraph-image-1a2b', '/pay/acme/coffee/opengraph-image-1a2b'],
    ['/acme/coffee/twitter-image', '/pay/acme/coffee/twitter-image'],
  ])('rewrites the root form %s to %s', (from, to) => {
    expect(pay(from)).toEqual(rewrite(to));
  });

  it('redirects the old /pay/ form to the root form, keeping the query', () => {
    expect(pay('/pay/acme/coffee?x=1')).toEqual(redirect(`${PAY}/acme/coffee?x=1`));
    expect(pay('/pay/ses_1')).toEqual(redirect(`${PAY}/ses_1`));
    expect(pay('/pay/ses_1/refund-address?t=abc')).toEqual(
      redirect(`${PAY}/ses_1/refund-address?t=abc`),
    );
  });

  it.each([
    '/preview/theme/t1',
    '/v1/tendr.js',
    '/checkout-boot.js',
    '/v1/plugins/woocommerce/update.json',
    '/downloads/woocommerce',
    '/privacy',
    '/terms',
    '/_next/x',
    '/icons/icon-192.png',
    '/sw.js',
    '/manifest.webmanifest',
    '/fonts/inter.woff2',
  ])('serves %s as it is', (path) => {
    expect(pay(path)).toEqual(next);
  });

  it('sends merchant pages to the app host, keeping the query', () => {
    expect(pay('/dashboard/payments')).toEqual(redirect(`${APP}/dashboard/payments`));
    expect(pay('/dashboard')).toEqual(redirect(`${APP}/dashboard`));
    expect(pay('/connect?state=s')).toEqual(redirect(`${APP}/connect?state=s`));
    expect(pay('/login')).toEqual(redirect(`${APP}/login`));
    expect(pay('/invite/tok')).toEqual(redirect(`${APP}/invite/tok`));
    expect(pay('/settings/notification-email/verify?t=1')).toEqual(
      redirect(`${APP}/settings/notification-email/verify?t=1`),
    );
  });

  it('sends / to the landing page', () => {
    expect(pay('/')).toEqual(redirect(LANDING));
  });

  it.each(['/demo', '/demo/acme', '/api/demo/checkout', '/acme', '/acme/coffee/extra/x', '/pay'])(
    '404s %s',
    (path) => {
      expect(pay(path)).toEqual(notFound);
    },
  );

  it('matches the host case-insensitively and with an explicit default port', () => {
    expect(route('PAY.usetendr.tech', '/ses_1')).toEqual(rewrite('/pay/ses_1'));
    expect(route('pay.usetendr.tech:443', '/ses_1')).toEqual(rewrite('/pay/ses_1'));
    expect(route('pay.usetendr.tech:8443', '/ses_1')).toEqual(next);
  });
});

describe('routeForHost: the app host', () => {
  const app = (url: string) => route('app.usetendr.tech', url);

  it('sends / to the dashboard on the app host', () => {
    expect(app('/')).toEqual(redirect(`${APP}/dashboard`));
  });

  it('sends shopper paths to the pay host in their new form', () => {
    expect(app('/pay/ses_1')).toEqual(redirect(`${PAY}/ses_1`));
    expect(app('/pay/acme/coffee?mode=test')).toEqual(redirect(`${PAY}/acme/coffee?mode=test`));
    expect(app('/preview/theme/t1')).toEqual(redirect(`${PAY}/preview/theme/t1`));
  });

  it.each(['/demo', '/demo/acme', '/api/demo/checkout'])('404s %s', (path) => {
    expect(app(path)).toEqual(notFound);
  });

  it.each([
    '/login',
    '/signup',
    '/dashboard/payments',
    '/connect?state=s',
    '/settings/notification-email/verify',
    '/_next/x',
    '/privacy',
  ])('serves %s as it is', (path) => {
    expect(app(path)).toEqual(next);
  });
});

describe('routeForHost: any other host', () => {
  it.each(['localhost:3000', 'demo.usetendr.tech', 'x.up.railway.app'])(
    'leaves every path to Next on %s',
    (host) => {
      for (const path of ['/', '/ses_1', '/acme/coffee', '/pay/ses_1', '/demo', '/dashboard']) {
        expect(route(host, path)).toEqual(next);
      }
    },
  );

  it('rewrites the root forms on localhost in development, and nothing else', () => {
    const dev = (host: string, path: string) => route(host, path, { dev: true });
    expect(dev('localhost:3000', '/ses_1')).toEqual(rewrite('/pay/ses_1'));
    expect(dev('localhost:3000', '/ses_1/refund-address')).toEqual(
      rewrite('/pay/ses_1/refund-address'),
    );
    expect(dev('localhost:3000', '/acme/coffee')).toEqual(rewrite('/pay/acme/coffee'));
    expect(dev('localhost:3100', '/acme/coffee/qr')).toEqual(rewrite('/pay/acme/coffee/qr'));
    expect(dev('localhost:3000', '/pay/ses_1')).toEqual(next);
    expect(dev('localhost:3000', '/dashboard/payments')).toEqual(next);
    expect(dev('localhost:3000', '/demo')).toEqual(next);
    expect(dev('localhost:3000', '/')).toEqual(next);
    expect(dev('x.up.railway.app', '/ses_1')).toEqual(next);
    // Without the env origins (a dev server with no CHECKOUT_BASE_URL) localhost still does.
    expect(route('localhost:3000', '/ses_1', { dev: true, payOrigin: null })).toEqual(
      rewrite('/pay/ses_1'),
    );
  });

  it('is next everywhere when the pay origin is unknown', () => {
    for (const host of ['pay.usetendr.tech', 'app.usetendr.tech', 'localhost:3000']) {
      for (const path of ['/', '/ses_1', '/acme/coffee', '/pay/ses_1', '/demo']) {
        expect(route(host, path, { payOrigin: null })).toEqual(next);
      }
    }
  });

  it('is next for every other path when the pay and app origins are the same (one-origin dev)', () => {
    const same = { payOrigin: 'http://localhost:3000', appOrigin: 'http://localhost:3000' };
    for (const path of ['/', '/pay/ses_1', '/dashboard', '/demo']) {
      expect(route('localhost:3000', path, same)).toEqual(next);
    }
  });
});

describe('routeForHost: one origin for pay and app (the demo deployment)', () => {
  const DEMO = 'https://demo.usetendr.tech';
  const single = { payOrigin: DEMO, appOrigin: DEMO };

  it.each(['demo.usetendr.tech', 'x.up.railway.app'])(
    'rewrites the root forms on %s, outside development too',
    (host) => {
      expect(route(host, '/ses_1', single)).toEqual(rewrite('/pay/ses_1'));
      expect(route(host, '/ses_1/refund-address', single)).toEqual(
        rewrite('/pay/ses_1/refund-address'),
      );
      expect(route(host, '/acme/coffee', single)).toEqual(rewrite('/pay/acme/coffee'));
    },
  );

  it.each([
    '/dashboard',
    '/dashboard/payments',
    '/pay/ses_1',
    '/pay/acme/coffee',
    '/demo',
    '/',
    '/privacy/x',
  ])('leaves %s to Next (known paths never rewrite; the old /pay/ form still works)', (path) => {
    expect(route('demo.usetendr.tech', path, single)).toEqual(next);
  });
});

describe('KNOWN_TOP_LEVEL_PATHS', () => {
  const web = resolve(__dirname, '../..');

  /** Every top-level URL segment app/ serves (route groups opened, files skipped). */
  function appSegments(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('(')) out.push(...appSegments(resolve(dir, e.name)));
      else if (!e.name.startsWith('[') && !e.name.startsWith('_')) out.push(e.name);
    }
    return out;
  }

  it('covers every top-level entry of app/', () => {
    for (const name of appSegments(resolve(web, 'src/app'))) {
      expect(KNOWN_TOP_LEVEL_PATHS).toContain(name);
    }
  });

  it('covers every top-level entry of public/', () => {
    for (const name of readdirSync(resolve(web, 'public'))) {
      if (name.startsWith('.')) continue;
      expect(KNOWN_TOP_LEVEL_PATHS).toContain(name);
    }
  });

  it('none of them can be a merchant slug or a link slug', () => {
    for (const name of KNOWN_TOP_LEVEL_PATHS) {
      // Merchant slugs are [a-z0-9-]: anything else (a dot, an underscore) can never collide.
      if (!/^[a-z0-9-]+$/.test(name)) continue;
      expect(RESERVED_LINK_SLUGS).toContain(name);
    }
  });
});

describe('isShopperPath', () => {
  it.each([
    '/pay/ses_1',
    '/pay/acme/coffee',
    '/ses_1',
    '/ses_1/refund-address',
    '/acme/coffee',
    '/acme/coffee/qr',
    '/preview/theme/t1',
  ])('%s is a shopper page', (path) => {
    expect(isShopperPath(path)).toBe(true);
  });

  it.each(['/', '/dashboard', '/dashboard/payments', '/invite/tok', '/demo', '/acme', '/privacy'])(
    '%s is not',
    (path) => {
      expect(isShopperPath(path)).toBe(false);
    },
  );
});

describe('invoice host', () => {
  const invoice = (pathname: string, host = 'invoice.usetendr.tech') =>
    routeForHost({
      host,
      pathname,
      search: '',
      invoiceOrigin: 'https://invoice.usetendr.tech',
      payOrigin: PAY,
      appOrigin: APP,
      landingUrl: LANDING,
    });
  it('routes business slugs to the private invoice surface', () => {
    expect(invoice('/acme')).toEqual(rewrite('/invoice/acme'));
    expect(invoice('/acme/')).toEqual(rewrite('/invoice/acme/'));
    expect(invoice('/_next/static/chunk.js')).toEqual(next);
    expect(invoice('/tendr-appearance.js')).toEqual(next);
  });
  it('keeps dashboards on the app origin and blocks checkout/demo paths', () => {
    expect(invoice('/dashboard/invoices')).toEqual(redirect(`${APP}/dashboard/invoices`));
    expect(invoice('/demo')).toEqual(notFound);
    expect(invoice('/acme/coffee')).toEqual(notFound);
    expect(invoice('/invoice/acme')).toEqual(notFound);
    expect(invoice('/acme', 'unknown.example.com')).toEqual(next);
  });
});
