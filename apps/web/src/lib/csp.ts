// The Content-Security-Policy for the dashboard and sign-in pages.
//
// The signing-page policy is `default-src 'self'; script-src 'self'; object-src 'none';
// frame-ancestors 'none'; connect-src 'self' <API origin>`, plus what Next.js needs to render:
//
// - script-src adds a per-request nonce. The App Router streams its page data in inline
//   <script> tags; Next puts the nonce from this header on them (and only them). No host is
//   allowed, so no third-party script can load. Development adds 'unsafe-eval' (webpack's dev
//   source maps and React's dev tooling); production never does.
// - style-src allows inline styles (React `style` attributes). Fonts are self-hosted (`/fonts`,
//   copied from @fontsource by scripts/copy-fonts.mjs): no font or stylesheet host. Styles cannot
//   run code.
// - img-src allows data: and blob: for locally rendered QR codes.
// - Development adds ws: to connect-src for hot reload.

/** The origin of the API the dashboard talks to. */
export function apiOrigin(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return 'http://localhost:4000';
  }
}

export function contentSecurityPolicy(opts: {
  nonce: string;
  apiBaseUrl: string;
  dev: boolean;
}): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${opts.nonce}'${opts.dev ? " 'unsafe-eval'" : ''}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    `connect-src 'self' ${apiOrigin(opts.apiBaseUrl)}${opts.dev ? ' ws:' : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ];
  return directives.join('; ');
}

/**
 * The policy for the Connect popup (`/connect`, WooCommerce plugin spec §2): the signing-page
 * policy (nonce scripts only, never framed, forms post only to itself) plus `frame-src 'none'`,
 * since the page frames nothing. CSP cannot limit `window.location`, so the page itself only ever
 * navigates to the plugin's return URL, after checking the origin (lib/connect.ts).
 */
export function connectContentSecurityPolicy(opts: {
  nonce: string;
  apiBaseUrl: string;
  dev: boolean;
}): string {
  return `${contentSecurityPolicy(opts)}; frame-src 'none'`;
}

/**
 * Token logos the checkout may show (`Token.logo_url`, CoinGecko's image hosts). Listed one by
 * one: the checkout allows no `https:` wildcard for images.
 */
export const TOKEN_LOGO_HOSTS: readonly string[] = [
  'https://assets.coingecko.com',
  'https://coin-images.coingecko.com',
];

/** The only hosts a theme's video block may frame (privacy-enhanced YouTube, Vimeo). */
export const THEME_VIDEO_HOSTS: readonly string[] = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
];

/**
 * A plain origin (scheme, host, optional port), as the API stores checkout domains. Anything else
 * (paths, wildcards, quotes, spaces, `;`, line breaks) is dropped before it reaches a CSP header.
 */
const PLAIN_ORIGIN = /^(https|http):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/;
const WALLET_SOURCE = /^(https|wss):\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * The origin Tendr serves theme assets from (`TENDR_ASSET_ORIGIN`, which may carry a bucket
 * path), as a CSP source: its plain origin, or null when unset or malformed.
 */
export function assetSource(assetOrigin: string | null | undefined): string | null {
  if (!assetOrigin) return null;
  let origin: string;
  try {
    origin = new URL(assetOrigin).origin;
  } catch {
    return null;
  }
  return PLAIN_ORIGIN.test(origin) ? origin : null;
}

/** Keeps only plain origins (used for frame-ancestors). */
export function plainOrigins(list: readonly unknown[]): string[] {
  return list.filter((o): o is string => typeof o === 'string' && PLAIN_ORIGIN.test(o));
}

/**
 * The policy for the shopper checkout (`/pay/*`). Like the signing-page policy (nonce scripts, no
 * plugins), except:
 *
 * - frame-ancestors is `'self'` plus the merchant's checkout domains (the store pages allowed to
 *   frame the checkout). `null` means the lookup failed: `'self'` only, failing closed.
 * - connect-src adds the wallet providers' hosts, and frame-src is 'self' plus the frames a wallet
 *   provider needs (both from lib/checkout/wallet-hosts.ts, the one list). Never a script host.
 * - Theme assets (logos, images, uploaded fonts) load only from Tendr's asset origin; images
 *   also from the token-logo hosts. No `https:` wildcard.
 * - frame-src adds the two video hosts a theme's video block may embed.
 */
export function checkoutContentSecurityPolicy(opts: {
  nonce: string;
  apiBaseUrl: string;
  dev: boolean;
  /** The merchant's checkout domains, or null when they could not be looked up. */
  frameAncestors: readonly string[] | null;
  walletHosts: readonly string[];
  walletFrameHosts?: readonly string[];
  /** `TENDR_ASSET_ORIGIN`: where theme logos, images and uploaded fonts are served from. */
  assetOrigin?: string | null;
}): string {
  const assets = assetSource(opts.assetOrigin);
  const ancestors = ["'self'", ...plainOrigins(opts.frameAncestors ?? [])];
  const wallets = opts.walletHosts.filter((h) => WALLET_SOURCE.test(h));
  const walletFrames = (opts.walletFrameHosts ?? []).filter(
    (h) => h.startsWith('https://') && WALLET_SOURCE.test(h),
  );
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${opts.nonce}'${opts.dev ? " 'unsafe-eval'" : ''}`,
    "object-src 'none'",
    `frame-ancestors ${ancestors.join(' ')}`,
    [
      'connect-src',
      "'self'",
      apiOrigin(opts.apiBaseUrl),
      ...wallets,
      ...(opts.dev ? ['ws:'] : []),
    ].join(' '),
    ['frame-src', "'self'", ...walletFrames, ...THEME_VIDEO_HOSTS].join(' '),
    "style-src 'self' 'unsafe-inline'",
    ['font-src', "'self'", ...(assets ? [assets] : [])].join(' '),
    ['img-src', "'self'", 'data:', 'blob:', ...(assets ? [assets] : []), ...TOKEN_LOGO_HOSTS].join(
      ' ',
    ),
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ];
  return directives.join('; ');
}
