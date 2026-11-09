// Host routing first (lib/hosts.ts, deploy spec §1): on the pay host the root forms (`/<session>`,
// `/<merchant>/<link>…`) are rewritten to the `/pay/…` pages, the old `/pay/…` form and merchant
// pages are redirected, and the demo is 404; the app host sends shopper paths to the pay host. The
// hosts are CHECKOUT_BASE_URL's and WEB_URL's; when either is unset or not a URL, every host
// behaves as before.
//
// Then a strict CSP (with a per-request script nonce) on every dashboard page and the sign-in
// pages, where passkeys are created and used, and the checkout policy on the shopper pages
// (`/pay/*`, after the rewrite) and the theme preview page (`/preview/theme/*`, never framed by a
// store). Policies follow the page that is served, whichever host serves it.
// The Connect popup (`/connect`) gets its own policy (no frames at all; lib/csp.ts), and it and the
// notification-email verify page are never cached.
// See lib/csp.ts. X-Frame-Options for the dashboard is in next.config.ts (never set for /pay).
//
// The checkout may be framed only by the merchant's checkout domains: for a request that could be
// framed, the middleware asks the API's public frame-origins route (1.5 s cap, cached ≤ 60 s) and
// puts those origins in `frame-ancestors`. If the lookup fails, only 'self' may frame it.
import { NextResponse, type NextRequest } from 'next/server';
import {
  checkoutSessionIdOf,
  createFrameOriginsLookup,
  needsFrameLookup,
} from './lib/checkout/frame-origins';
import { WALLET_CONNECT_HOSTS, WALLET_FRAME_HOSTS } from './lib/checkout/wallet-hosts';
import { NOT_FOUND_PATH, routeForHost } from './lib/hosts';
import {
  checkoutContentSecurityPolicy,
  connectContentSecurityPolicy,
  contentSecurityPolicy,
} from './lib/csp';

const publicApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

const frameOrigins = createFrameOriginsLookup({
  // The middleware runs on the server: prefer the internal API address when one is set.
  apiBaseUrl: process.env.API_BASE_URL || publicApiBaseUrl,
  ttlMs: 60_000,
  timeoutMs: 1500,
});

/** Where `/` on the pay host goes: the landing page (not this app). */
const LANDING_URL = 'https://usetendr.tech';

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function checkoutPolicy(request: NextRequest, pathname: string, nonce: string, dev: boolean) {
  const sessionId = checkoutSessionIdOf(pathname);
  const frameable = sessionId !== null && needsFrameLookup(request.headers.get('sec-fetch-dest'));
  return checkoutContentSecurityPolicy({
    nonce,
    apiBaseUrl: publicApiBaseUrl,
    dev,
    frameAncestors: frameable ? await frameOrigins(sessionId) : [],
    walletHosts: WALLET_CONNECT_HOSTS,
    walletFrameHosts: WALLET_FRAME_HOSTS,
    assetOrigin: process.env.TENDR_ASSET_ORIGIN ?? null,
  });
}

/**
 * A payment link's QR code and preview images (`[/pay]/<merchant>/<link>/qr`,
 * `…/opengraph-image…`, `…/twitter-image…`): public and cacheable, so they set their own
 * Cache-Control. The link page itself stays no-store (availability and rates are live). Only
 * consulted for shopper paths.
 */
const LINK_ASSET =
  /^(?:\/pay)?\/[^/]+\/[^/]+\/(?:qr|opengraph-image|twitter-image)(?:-[A-Za-z0-9]+)?\/?$/;

/**
 * The pages that get a policy here (the served path): the dashboard, the sign-in pages, the
 * shopper pages, Connect and the verify page. Everything else the widened matcher now reaches (the
 * demo, legal pages, route handlers) is passed through untouched, as before.
 */
const POLICY_PATH =
  /^\/(?:dashboard(?:\/.*)?|signup|login|verify|invite(?:\/.*)?|recover(?:\/.*)?|pay(?:\/.*)?|invoice(?:\/.*)?|preview\/theme(?:\/.*)?|connect|settings\/notification-email\/verify)$/;

/** Pages whose responses carry one-time parameters (connect state, a verify token): never cached. */
const NO_STORE_PATHS = ['/connect', '/settings/notification-email/verify'];

export async function middleware(request: NextRequest) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const dev = process.env.NODE_ENV === 'development';
  const route = routeForHost({
    host: request.headers.get('host') ?? request.nextUrl.host,
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    invoiceOrigin: originOf(process.env.INVOICE_BASE_URL),
    payOrigin: originOf(process.env.CHECKOUT_BASE_URL),
    appOrigin: originOf(process.env.WEB_URL),
    landingUrl: LANDING_URL,
    dev,
  });
  if (route.kind === 'redirect') return NextResponse.redirect(route.url, route.status);
  // The path the page is served from: the policies below follow it, not the public URL.
  const pathname =
    route.kind === 'rewrite'
      ? route.pathname
      : route.kind === 'notFound'
        ? NOT_FOUND_PATH
        : request.nextUrl.pathname;
  if (!POLICY_PATH.test(pathname)) {
    if (route.kind === 'next') return NextResponse.next();
    const target = request.nextUrl.clone();
    target.pathname = pathname;
    return NextResponse.rewrite(target);
  }
  const checkout = pathname.startsWith('/pay/') || pathname.startsWith('/preview/theme/');
  const csp = checkout
    ? await checkoutPolicy(request, pathname, nonce, dev)
    : pathname === '/connect'
      ? connectContentSecurityPolicy({ nonce, apiBaseUrl: publicApiBaseUrl, dev })
      : contentSecurityPolicy({ nonce, apiBaseUrl: publicApiBaseUrl, dev });

  // Next reads the nonce from the request's CSP header and applies it to its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  let response: NextResponse;
  if (route.kind === 'next') {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    const target = request.nextUrl.clone();
    target.pathname = pathname;
    response = NextResponse.rewrite(target, { request: { headers: requestHeaders } });
  }
  response.headers.set('Content-Security-Policy', csp);
  if (pathname.startsWith('/invoice/')) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  if (checkout) {
    // next.config.ts sets these for `/pay/*` by the public path; a root-form URL doesn't match it.
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
  }
  if ((checkout && !LINK_ASSET.test(pathname)) || NO_STORE_PATHS.includes(pathname)) {
    // The checkout policy depends on the session and on whether the request can be framed; the
    // others carry one-time parameters. Never cache them.
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
}

export const config = {
  // Every path except Next's own assets and static files (anything with an extension: public/,
  // tendr.js, the boot script). Merchant slugs, link slugs and session ids never contain a dot.
  matcher: ['/((?!_next/|.*\\.[A-Za-z0-9]+$).*)'],
};
