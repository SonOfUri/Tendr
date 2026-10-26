import type { Metadata } from 'next';
import { ConnectFlow } from './ConnectFlow';

// Rendered per request so the CSP nonce set by the middleware reaches Next's scripts. The page's
// own policy (no frames, forms only to itself) is in lib/csp.ts `connectContentSecurityPolicy`.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect your site · Tendr',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ConnectPage() {
  return (
    <div className="auth-shell">
      <ConnectFlow />
    </div>
  );
}
