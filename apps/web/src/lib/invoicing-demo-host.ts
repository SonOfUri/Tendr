/** invoicing.demo.usetendr.tech — scripted invoicing stage, not the checkout playground. */
export function isInvoicingDemoHost(host: string | null | undefined): boolean {
  const name = (host ?? '').split(',')[0]?.trim().split(':')[0]?.toLowerCase() ?? '';
  return (
    name === 'invoicing.demo.usetendr.tech' ||
    name === 'demo.invoicing.usetendr.tech' ||
    name.startsWith('invoicing.demo.') ||
    name.startsWith('demo.invoicing.')
  );
}

export function isInvoicingDemoRequest(get: (name: string) => string | null): boolean {
  return isInvoicingDemoHost(get('x-forwarded-host')) || isInvoicingDemoHost(get('host'));
}
