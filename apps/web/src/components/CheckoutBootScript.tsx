'use client';

import { usePathname } from 'next/navigation';
import { CHECKOUT_BOOT_SCRIPT_PATH } from '@/lib/checkout/boot-secret';

/** `/<session id>` (the pay host's form; SSR may see either) or `/pay/<session id>`. */
const CHECKOUT_PAGE = /^(?:\/pay)?\/ses_[0-9A-HJKMNP-TV-Z]{26}\/?$/;

/**
 * On a checkout page only: the boot script that moves `#cs=` out of the URL, as a parser-blocking
 * <script src> in the root layout's <head>. It must run before the first RSC chunk is parsed, and
 * only the root layout is rendered ahead of those: the pay layout and page sit inside the root
 * `loading.tsx` Suspense boundary, which `next dev` streams after the RSC payload. Rendered during
 * SSR, where usePathname is the request path; it never runs on a client-side render (and a
 * checkout is only ever reached by a full page load).
 */
export function CheckoutBootScript() {
  const pathname = usePathname();
  if (!pathname || !CHECKOUT_PAGE.test(pathname)) return null;
  // Synchronous on purpose: it must run before the parser reaches the RSC payload.
  // eslint-disable-next-line @next/next/no-sync-scripts
  return <script src={CHECKOUT_BOOT_SCRIPT_PATH} />;
}
