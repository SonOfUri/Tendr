'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { isShopperPath } from '@/lib/hosts';

/**
 * Renders its children everywhere except surfaces that stand alone:
 * - shopper checkout and payment links (`/pay/*`, or `/<session>` and `/<merchant>/<link>` on the
 *   pay host) — also framed inside store embeds
 * - theme preview (`/preview/theme/*`) — the checkout as a shopper sees it
 * - demo playground (`/` and `/demo`) — Chainrails-style canvas, no marketing chrome
 * - invoicing film (`/invoicing-demo`, or invoicing.demo.usetendr.tech)
 * - merchant dashboard (`/dashboard`) — owns its sidebar / top bar chrome
 */
export function HideOnCheckout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [invoiceHost, setInvoiceHost] = useState(false);
  const [invoicingDemoHost, setInvoicingDemoHost] = useState(false);
  useEffect(() => {
    const host = window.location.hostname;
    setInvoiceHost(host.startsWith('invoice.'));
    setInvoicingDemoHost(host.startsWith('invoicing.demo.') || host.startsWith('demo.invoicing.'));
  }, []);
  if (pathname && isShopperPath(pathname)) return null;
  if (pathname === '/' || pathname === '/demo' || pathname?.startsWith('/demo/')) return null;
  if (pathname?.startsWith('/invoicing-demo')) return null;
  // Merchant dashboard has its own app chrome (sidebar + top bar).
  if (pathname?.startsWith('/invoice/')) return null;
  if (invoiceHost || invoicingDemoHost) return null;
  if (pathname?.startsWith('/dashboard')) return null;
  return <>{children}</>;
}
