export interface InvoiceView {
  id: string;
  contractorName: string;
  email: string;
  reference: string;
  description: string;
  dueDate: string | null;
  destination: string;
  destinationAsset: string;
  destinationChain: string;
  amount: string;
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
    expiresAt: string;
    providerStatus: { swapDetails?: { destinationChainTxHashes?: { hash: string }[] } } | null;
  } | null;
}
export const INVOICE_STATUS: Record<InvoiceView['status'], string> = {
  awaiting_verification: 'Verify your email',
  open: 'Awaiting payment',
  processing: 'Payment in progress',
  paid: 'Paid',
  rejected: 'Declined',
  payment_review: 'Payment needs review',
};
