import { headers } from 'next/headers';
import { DemoPlayground } from '@/components/demo/DemoPlayground';
import { InvoicingDemo } from '@/components/invoicing-demo/InvoicingDemo';
import { isInvoicingDemoRequest } from '@/lib/invoicing-demo-host';

/** demo.usetendr.tech opens the checkout playground. invoicing.demo opens the invoice film. */
export default async function HomePage() {
  const h = await headers();
  if (isInvoicingDemoRequest((name) => h.get(name))) return <InvoicingDemo />;
  return <DemoPlayground />;
}
