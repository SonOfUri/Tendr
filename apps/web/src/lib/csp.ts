// The Content-Security-Policy for the dashboard and sign-in pages.
//
// The signing-page policy is `default-src 'self'; script-src 'self'; object-src 'none';
// frame-ancestors 'none'; connect-src 'self' <API origin>`, plus what Next.js needs to render:
//
// - script-src adds a per-request nonce. The App Router streams its page data in inline
//   <script> tags; Next puts the nonce from this header on them (and only them). No host is
//   allowed, so no third-party script can load. Development adds 'unsafe-eval' (webpack's dev
//   source maps and React's dev tooling); production never does.
// - style-src allows inline styles (React `style` attributes) and the Google Fonts stylesheet
//   that globals.css imports; font-src allows the font files. Styles cannot run code.
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
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ];
  return directives.join('; ');
}
