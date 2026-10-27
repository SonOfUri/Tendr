'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Renders its children everywhere except surfaces that stand alone:
 * - shopper checkout (`/pay/*`) — also framed inside store embeds
 * - demo playground (`/` and `/demo`) — Chainrails-style canvas, no marketing chrome
 */
export function HideOnCheckout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/pay/')) return null;
  if (pathname === '/' || pathname === '/demo' || pathname?.startsWith('/demo/')) return null;
  return <>{children}</>;
}
