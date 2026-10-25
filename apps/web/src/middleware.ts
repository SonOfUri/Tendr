// Strict CSP (with a per-request script nonce) on every dashboard page and the sign-in pages,
// where passkeys are created and used. See lib/csp.ts. X-Frame-Options is in next.config.ts.
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from './lib/csp';

export function middleware(request: NextRequest) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = contentSecurityPolicy({
    nonce,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000',
    dev: process.env.NODE_ENV === 'development',
  });

  // Next reads the nonce from the request's CSP header and applies it to its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/signup', '/login', '/verify', '/invite/:path*'],
};
