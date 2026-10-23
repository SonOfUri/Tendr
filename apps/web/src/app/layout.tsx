import type { Metadata, Viewport } from 'next';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tendr — One checkout. Every way to pay.',
  description:
    'Tendr is a universal checkout layer for digital commerce. Sandbox demos do not move real funds.',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>
          <SiteHeader />
          {children}
          <SiteFooter />
        </main>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
