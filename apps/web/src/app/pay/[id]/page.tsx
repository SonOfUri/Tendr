import { notFound } from 'next/navigation';
import { Checkout } from './components/Checkout';

const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

// The shopper checkout: the hosted page, and the page tendr.js frames for the modal and the inline
// widget. The client secret is in the URL fragment (`#cs=…`), which never reaches this server: the
// page reads it in the browser (lib/checkout/secret.ts).
// No I/O-bound awaits (fetches, DB or API calls) here or in pay/layout.tsx: the checkout should
// render in the first HTML flush; the boot script that strips `#cs=` is in the root layout's head.
export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  if (!SESSION_ID.test(sessionId)) notFound();
  return <Checkout sessionId={sessionId} />;
}
