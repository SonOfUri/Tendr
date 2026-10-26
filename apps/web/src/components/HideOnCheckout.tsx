'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Renders its children everywhere except the shopper checkout (`/pay/*`), which stands alone:
 * no site header, footer or service worker (it is also shown inside store pages' frames).
 */
export function HideOnCheckout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/pay/')) return null;
  return <>{children}</>;
}
