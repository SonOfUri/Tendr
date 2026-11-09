import type { Event } from '@prisma/client';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { oneLine, ownerEmails, sendOncePerEvent } from '../merchants/store-notices.js';
import { handlerNamesFor, registerEventHandler } from './handlers.js';

export async function onInvoiceNotice(event: Event) {
  if (!event.merchantId || event.livemode !== true) return;
  const row = await prisma.invoice.findFirst({
    where: { id: event.aggregateId, merchantId: event.merchantId, livemode: true },
    include: { merchant: { select: { name: true, status: true } } },
  });
  if (!row?.verifiedAt || row.merchant.status !== 'active') return;
  const label = `Invoice ${oneLine(row.reference)} for ${oneLine(row.merchant.name)}`;
  if (event.type === 'invoice.submitted' || event.type === 'invoice.payment_review') {
    await sendOncePerEvent(event.id, 'invoice_notice', await ownerEmails(row.merchantId), {
      data: {},
      subject:
        event.type === 'invoice.submitted'
          ? 'New contractor invoice'
          : 'Invoice payment needs review',
      text: `${label} ${event.type === 'invoice.submitted' ? 'is awaiting your review' : 'needs a payment receipt review'}.\n\nOpen your Tendr dashboard and select this business:\n${new URL('/dashboard/invoices', env().WEB_URL).toString()}\n\nOnly your wallet passkey can approve a payment.`,
    });
  } else if (
    (event.type === 'invoice.paid' && row.status === 'paid') ||
    (event.type === 'invoice.rejected' && row.status === 'rejected')
  ) {
    await sendOncePerEvent(event.id, 'invoice_notice', [row.email], {
      data: {},
      subject: row.status === 'paid' ? 'Your invoice has been paid' : 'Your invoice was declined',
      text: `${label} ${row.status === 'paid' ? 'has been paid to the wallet you specified' : 'was declined by the business'}.\n\nUse the private link in your verification email to review the details.`,
    });
  }
}
export function registerInvoiceNotices() {
  for (const type of [
    'submitted',
    'paid',
    'rejected',
    'payment_review',
    'processing',
    'open',
    'settings_updated',
  ]) {
    const event = `invoice.${type}`;
    if (!handlerNamesFor(event).includes('invoice-notice'))
      registerEventHandler(event, 'invoice-notice', onInvoiceNotice);
  }
}
