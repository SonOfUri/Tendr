import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

function loadRootEnv() {
  const path = resolve(__dirname, '../../.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  transpilePackages: ['@tendr/ui', '@tendr/contracts', '@tendr/sdk'],
  // The strict CSP for the dashboard and sign-in pages needs a per-request nonce, so it is set in
  // src/middleware.ts (see src/lib/csp.ts). Framing is refused here for every dashboard route.
  headers: async () => [
    ...[
      '/dashboard',
      '/dashboard/:path*',
      '/signup',
      '/login',
      '/verify',
      '/invite/:path*',
      '/recover',
      '/recover/:path*',
      '/connect',
      '/settings/:path*',
    ].map((source) => ({
      source,
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    })),
    // The shopper checkout. Framing is governed by CSP frame-ancestors (the merchant's checkout
    // domains, set in src/middleware.ts), so no X-Frame-Options here: it would refuse every frame.
    {
      source: '/pay/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    },
    {
      source: '/sw.js',
      headers: [
        { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        { key: 'Service-Worker-Allowed', value: '/' },
      ],
    },
  ],
};

export default nextConfig;
