import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ThemePreview } from './ThemePreview';

// Rendered per request so the CSP nonce set by the middleware reaches Next's scripts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Theme preview · Tendr',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** A preview token: 32 random bytes, base64url (the API accepts 16–128 characters). */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

// A merchant's draft theme as a shopper would see it (`/preview/theme/<token>`, spec §10). The
// page fetches the preview from the browser, like the checkout, so the API's read limit counts
// the viewer's own address. Nothing here can pay: the Pay button is inert and a ribbon says so.
export default async function ThemePreviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN.test(token)) notFound();
  return (
    <div className="pay">
      <ThemePreview token={token} />
    </div>
  );
}
