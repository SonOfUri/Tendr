import type { Metadata } from 'next';
import { InvoicingDemo } from '@/components/invoicing-demo/InvoicingDemo';

export const metadata: Metadata = {
  title: 'Tendr invoicing demo',
  description: 'A scripted walkthrough of Tendr contractor invoicing — bill, confirm, quote, and pay.',
};

/** Local rehearsal for invoicing.demo.usetendr.tech. Production root switches on host. */
export default function InvoicingDemoPage() {
  return <InvoicingDemo />;
}