import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CHECKOUT_BOOT_SCRIPT } from '@/lib/checkout/boot-secret';

// Rendered per request so the CSP nonce set by the middleware reaches Next's scripts, and so the
// per-session frame-ancestors policy is never cached.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Checkout · Tendr',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function PayLayout({ children }: { children: React.ReactNode }) {
  // The middleware's per-request nonce (it also sets the CSP that allows it).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <div className="pay">
      {/*
        Runs as the document is parsed, ahead of the page content and of the RSC payload Next
        hydrates from, so `#cs=` is out of the URL before Next's router reads `location`
        (lib/checkout/boot-secret.ts). The browser hides the nonce attribute after use, hence
        suppressHydrationWarning.
      */}
      <script
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: CHECKOUT_BOOT_SCRIPT }}
      />
      {children}
    </div>
  );
}
