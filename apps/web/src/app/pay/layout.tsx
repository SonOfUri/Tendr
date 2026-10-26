import type { Metadata } from 'next';

// Rendered per request so the CSP nonce set by the middleware reaches Next's scripts, and so the
// per-session frame-ancestors policy is never cached.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Checkout · Tendr',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function PayLayout({ children }: { children: React.ReactNode }) {
  return <div className="pay">{children}</div>;
}
