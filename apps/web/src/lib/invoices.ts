import { formatUnits } from './assets';

export interface InvoiceView {
  id: string;
  contractorName: string;
  email: string;
  reference: string;
  description: string;
  /** Integer USD cents for USD invoices, token units for legacy TOKEN invoices. */
  items?: { description: string; amount: string }[];
  dueDate: string | null;
  destination: string;
  destinationAsset: string;
  destinationChain: string;
  amount: string;
  amountCurrency?: 'USD' | 'TOKEN';
  amountDecimals?: number;
  decimals: number;
  symbol: string;
  status: 'awaiting_verification' | 'open' | 'processing' | 'paid' | 'rejected' | 'payment_review';
  verifiedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  payout: {
    id: string;
    status: string;
    asset: string;
    amount: string;
    destinationAmount?: string | null;
    expiresAt: string;
    providerStatus: { swapDetails?: { destinationChainTxHashes?: { hash: string }[] } } | null;
  } | null;
}

export function formatInvoiceUsd(cents: string): string {
  if (!/^\d+$/.test(cents)) return cents;
  const padded = cents.padStart(3, '0');
  return `$${padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${padded.slice(-2)}`;
}

export function formatInvoiceAmount(
  invoice: Pick<InvoiceView, 'amount' | 'amountCurrency' | 'decimals' | 'symbol'>,
  amount = invoice.amount,
): string {
  return invoice.amountCurrency === 'USD'
    ? formatInvoiceUsd(amount)
    : `${formatUnits(amount, invoice.decimals)} ${invoice.symbol}`;
}
export const INVOICE_STATUS: Record<InvoiceView['status'], string> = {
  awaiting_verification: 'Verify your email',
  open: 'Awaiting payment',
  processing: 'Payment in progress',
  paid: 'Paid',
  rejected: 'Declined',
  payment_review: 'Payment needs review',
};
