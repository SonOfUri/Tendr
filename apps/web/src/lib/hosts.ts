// Which host serves which paths (deploy spec §1). One Next app answers on two hosts:
//
// - the pay host (CHECKOUT_BASE_URL's): what shoppers see. Checkouts are `/<session>` and payment
//   links `/<merchant>/<link>`, rewritten internally to the existing `app/pay/…` pages; the old
//   `/pay/…` form redirects to the root form; merchant pages go to the app host.
// - the app host (WEB_URL's): sign-in, the dashboard, settings and the Connect screen. Shopper
//   paths go to the pay host in their new form.
// - one origin for both (CHECKOUT_BASE_URL and WEB_URL the same, as on the demo deployment): the
//   root forms are rewritten on every host; everything else, the old `/pay/…` form included, as before.
// - any other host (Railway's own name, localhost): everything as before. On localhost in
//   development the root forms work too, so both URL shapes can be tried on one origin.
//
// `/demo…` and `/api/demo/…` are 404 on the pay and app hosts: production has no demo merchant.
// Hosts come from env, never from hard-coded names. Pure: the middleware passes everything in.

export type HostRoute =
  | { kind: 'next' }
  | { kind: 'rewrite'; pathname: string }
  | { kind: 'redirect'; url: string; status: 308 }
  | { kind: 'notFound' };

/** Top-level paths the pay host serves as they are (its own pages, scripts and files). */
const PAY_SERVED = [
  'preview',
  'checkout-boot.js',
  'v1',
  'downloads',
  'privacy',
  'terms',
  '_next',
  // public/
  'icons',
  'fonts',
  'manifest.webmanifest',
  'offline.html',
  'sw.js',
  'tendr-logo.png',
  'logo-white.png',
  'favicon.png',
  'favicon.ico',
  'apple-icon.png',
  'robots.txt',
] as const;

/** Top-level paths of merchant pages: the app host's. */
const APP_PATHS = [
  'dashboard',
  'login',
  'signup',
  'verify',
  'invite',
  'recover',
  'connect',
  'settings',
] as const;

/**
 * Every top-level path segment the web app serves (app/ and public/). On the pay host none of them
 * is ever read as a merchant slug; the reserved merchant and link slug lists include each of them.
 */
export const KNOWN_TOP_LEVEL_PATHS: readonly string[] = [
  ...PAY_SERVED,
  ...APP_PATHS,
  'pay',
  'demo',
  'api',
];

const KNOWN = new Set(KNOWN_TOP_LEVEL_PATHS);
const APP = new Set<string>(APP_PATHS);

/** `/<session id>` and its refund-address page. */
const ROOT_SESSION = /^\/ses_[A-Za-z0-9]+(?:\/refund-address)?\/?$/;
/** `/<merchant>/<link>` and its QR code and preview images. */
const ROOT_LINK =
  /^\/([^/]+)\/[^/]+(?:\/(?:qr|opengraph-image(?:-[A-Za-z0-9]+)?|twitter-image(?:-[A-Za-z0-9]+)?))?\/?$/;

function firstSegment(pathname: string): string {
  return pathname.split('/')[1] ?? '';
}

/** A root-form checkout or payment-link path (`/ses_…[/refund-address]`, `/<merchant>/<link>…`). */
function isRootForm(pathname: string): boolean {
  if (ROOT_SESSION.test(pathname)) return true;
  const merchant = ROOT_LINK.exec(pathname)?.[1];
  return merchant !== undefined && !KNOWN.has(merchant) && !merchant.startsWith('ses_');
}

/** A page shoppers see, in either form: the checkout, a payment link, a theme preview. */
export function isShopperPath(pathname: string): boolean {
  return (
    pathname.startsWith('/pay/') || pathname.startsWith('/preview/theme/') || isRootForm(pathname)
  );
}

function isDemo(pathname: string): boolean {
  return (
    pathname === '/demo' ||
    pathname.startsWith('/demo/') ||
    pathname === '/api/demo' ||
    pathname.startsWith('/api/demo/')
  );
}

/** `host` (a Host header) as `URL.host` normalises it for `origin`'s scheme, or null. */
function sameHost(host: string, origin: URL): boolean {
  try {
    return new URL(`${origin.protocol}//${host}`).host === origin.host;
  } catch {
    return false;
  }
}

function parseOrigin(origin: string | null): URL | null {
  if (!origin) return null;
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

/**
 * Where the middleware sends a `notFound` route: no route serves it (`_`-prefixed app folders are
 * private), so Next renders app/not-found.tsx with a 404.
 */
export const NOT_FOUND_PATH = '/_tendr/not-found';

const NEXT: HostRoute = { kind: 'next' };
const NOT_FOUND: HostRoute = { kind: 'notFound' };
const redirect = (url: string): HostRoute => ({ kind: 'redirect', url, status: 308 });

export function routeForHost(input: {
  host: string;
  pathname: string;
  search: string;
  payOrigin: string | null;
  appOrigin: string | null;
  landingUrl: string;
  /** NODE_ENV=development: the root forms also work on localhost. */
  dev?: boolean;
}): HostRoute {
  const { host, pathname, search } = input;
  const pay = parseOrigin(input.payOrigin);
  const app = parseOrigin(input.appOrigin);
  // Unknown hosts: behave as before.
  if (!pay || !app) return otherHost(input);
  // One origin for both (the demo deployment, one-origin dev): the API hands out root-form URLs on
  // that origin, so they work on every host; everything else, the old /pay/ form included, as before.
  if (pay.host === app.host) return rootFormOrNext(input.pathname);

  if (sameHost(host, pay)) {
    if (pathname === '/') return redirect(input.landingUrl);
    const seg = firstSegment(pathname);
    if (seg === 'pay') {
      const rest = pathname.slice('/pay'.length);
      return rest.length > 1 ? redirect(`${pay.origin}${rest}${search}`) : NOT_FOUND;
    }
    if (APP.has(seg)) return redirect(`${app.origin}${pathname}${search}`);
    if (isDemo(pathname)) return NOT_FOUND;
    if (KNOWN.has(seg)) return NEXT;
    if (isRootForm(pathname)) return { kind: 'rewrite', pathname: `/pay${pathname}` };
    return NOT_FOUND;
  }

  if (sameHost(host, app)) {
    if (pathname === '/') return redirect(`${app.origin}/dashboard`);
    if (pathname.startsWith('/pay/') && pathname.length > '/pay/'.length) {
      return redirect(`${pay.origin}${pathname.slice('/pay'.length)}${search}`);
    }
    if (pathname.startsWith('/preview/')) return redirect(`${pay.origin}${pathname}${search}`);
    if (isDemo(pathname)) return NOT_FOUND;
    return NEXT;
  }

  return otherHost(input);
}

function otherHost(input: { host: string; pathname: string; dev?: boolean }): HostRoute {
  if (!input.dev) return NEXT;
  const hostname = input.host.replace(/:\d+$/, '').toLowerCase();
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return NEXT;
  return rootFormOrNext(input.pathname);
}

function rootFormOrNext(pathname: string): HostRoute {
  return isRootForm(pathname) ? { kind: 'rewrite', pathname: `/pay${pathname}` } : NEXT;
}
