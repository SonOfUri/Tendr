import { notFound } from 'next/navigation';
import { Checkout } from './components/Checkout';

const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

// The shopper checkout: the hosted page, and the page tendr.js frames for the modal and the inline
// widget. The client secret is in the URL fragment (`#cs=…`), which never reaches this server: the
// page reads it in the browser (lib/checkout/secret.ts).
export default async function PayPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  if (!SESSION_ID.test(sessionId)) notFound();
  return <Checkout sessionId={sessionId} />;
}
