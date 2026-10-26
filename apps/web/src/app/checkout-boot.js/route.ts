// The checkout boot script (lib/checkout/boot-secret.ts) as a same-origin file, so the root layout
// can load it from <head> on checkout pages without a nonce (CSP `script-src 'self'`). Static.
import { CHECKOUT_BOOT_SCRIPT } from '@/lib/checkout/boot-secret';

export const dynamic = 'force-static';

export function GET() {
  return new Response(CHECKOUT_BOOT_SCRIPT, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
