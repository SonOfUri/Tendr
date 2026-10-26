import type { Metadata, Viewport } from 'next';
import { CheckoutBootScript } from '@/components/CheckoutBootScript';
import { HideOnCheckout } from '@/components/HideOnCheckout';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tendr — One checkout. Every way to pay.',
  description:
    'Tendr is a universal checkout layer for digital commerce. Checkout is coming soon; test mode never moves real funds.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Tendr',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#080D1B',
  width: 'device-width',
  initialScale: 1,
};

// Keep this layout synchronous, with no I/O-bound awaits: the checkout boot script in <head> must
// be in the initial HTML shell, ahead of the first RSC chunk (e2e/checkout.spec.ts checks it).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <CheckoutBootScript />
      </head>
      <body>
        <main>
          <HideOnCheckout>
            <SiteHeader />
          </HideOnCheckout>
          {children}
          <HideOnCheckout>
            <SiteFooter />
          </HideOnCheckout>
        </main>
        <HideOnCheckout>
          <ServiceWorkerRegister />
        </HideOnCheckout>
      </body>
    </html>
  );
}
