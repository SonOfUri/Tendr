import type { Metadata, Viewport } from 'next';
import { CheckoutBootScript } from '@/components/CheckoutBootScript';
import { HideOnCheckout } from '@/components/HideOnCheckout';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { Toaster } from '@/components/toast';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tendr — One checkout. Every way to pay.',
  description:
    'Tendr is a universal checkout layer for digital commerce. Checkout is coming soon; test mode never moves real funds.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/favicon.png', type: 'image/png' }],
    apple: [{ url: '/apple-icon.png', type: 'image/png' }],
  },
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <CheckoutBootScript />
        {/* Parser-blocking and same-origin so the device theme is set before first paint. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/tendr-appearance.js" />
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
        <Toaster />
      </body>
    </html>
  );
}
