import type { Metadata } from 'next';
import { VerifyNotificationEmail } from './VerifyNotificationEmail';

// The link in the "confirm your notification email" message. Rendered per request so the CSP
// nonce set by the middleware reaches Next's scripts; never cached (the token is in the URL).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Confirm your notification email · Tendr',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function VerifyNotificationEmailPage() {
  return (
    <div className="auth-shell">
      <VerifyNotificationEmail />
    </div>
  );
}
