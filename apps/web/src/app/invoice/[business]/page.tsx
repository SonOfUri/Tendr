import type { Metadata } from 'next';
import { InvoicePortal } from './portal';
export const metadata: Metadata = {
  title: 'Invoice a business · Tendr',
  description: 'Send an invoice and receive crypto directly in your wallet.',
  robots: { index: false, follow: false },
};
export default async function Page({ params }: { params: Promise<{ business: string }> }) {
  const { business } = await params;
  return <InvoicePortal business={business} />;
}
