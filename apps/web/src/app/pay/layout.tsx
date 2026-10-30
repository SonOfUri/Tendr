import type { Metadata } from 'next';

// Rendered per request so the CSP nonce set by the middleware reaches Next's scripts, and so the
// per-session frame-ancestors policy is never cached.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Checkout · Tendr',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// No I/O-bound awaits here or in pay/[id]/page.tsx, and never the boot script that strips
// `#cs=`: this layout is inside the root loading.tsx Suspense boundary, which can stream after
// the RSC payload, so the boot script lives in the root layout's <head> (CheckoutBootScript).
export default function PayLayout({ children }: { children: React.ReactNode }) {
  return <div className="pay">{children}</div>;
}
