// Checkout payments in the dashboard: API shapes and formatting. Amounts are integer strings in the
// asset's smallest unit and USD values are decimal strings; nothing here ever goes through a
// JavaScript number (floats cannot hold 78-digit amounts, and rounding money through them is
// wrong). Token amounts use the dashboard's asset registry (assets.ts) — an unregistered asset is
// shown in raw smallest units with its full id.
import { formatAmount } from './assets';

export type PaymentStatus =
  'DETECTED' | 'PROCESSING' | 'SETTLED' | 'REFUNDING' | 'REFUNDED' | 'HELD' | 'SCREENING_PENDING';

export const PAYMENT_STATUSES: PaymentStatus[] = [
  'DETECTED',
  'PROCESSING',
  'SETTLED',
  'REFUNDING',
  'REFUNDED',
  'HELD',
  'SCREENING_PENDING',
];

export interface PaymentSummary {
  id: string;
  livemode: boolean;
  status: PaymentStatus;
  session_id: string;
  external_ref: string | null;
  order: { amount: string; currency: string };
  source: { asset: string; chain: string | null };
  received: { asset: string; amount: string };
  settlement: { asset: string; chain: string; amount_out: string | null };
  is_late: boolean;
  held_reason: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface PaymentList {
  payments: PaymentSummary[];
  has_more: boolean;
  next_cursor: string | null;
}

export type FeeKind = 'tendr_fee' | 'oneclick_fee' | 'network_fee' | 'gas_reimbursement' | 'other';

export interface FeeLine {
  kind: FeeKind;
  asset: string;
  amount: string;
  amount_usd: string | null;
  estimated: boolean;
}

export interface Refund {
  id: string;
  payment_id: string;
  reason: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  asset: string;
  amount: string;
  return_fee: string | null;
  destination: string | null;
  destination_chain: string | null;
  needs_address: boolean;
  review_reason: string | null;
  proposal_id: string | null;
  refund_tx_hash: string | null;
  acknowledged_legal_at: string | null;
  created_at: string;
}

export interface TxRef {
  chain: string | null;
  hash: string;
}

export interface PaymentDetail extends PaymentSummary {
  fee_payer: 'merchant' | 'shopper';
  gas_payer: 'merchant' | 'shopper';
  fee_bps: number;
  fees: FeeLine[];
  fees_recorded: boolean;
  quote: {
    amount_in: string;
    amount_out: string;
    amount_in_usd: string | null;
    amount_out_usd: string | null;
    refund_type: string | null;
  };
  sender_address: string | null;
  sender_addresses: string[];
  overpaid_amount: string | null;
  refunded_amount: string | null;
  kept_small_overpayment: boolean;
  oneclick_status: string | null;
  verified_by: string | null;
  legal_ack_at: string | null;
  screening_unresolved_at: string | null;
  transactions: { origin: TxRef | null; settlement: TxRef | null; payout: TxRef | null };
  refunds: Refund[];
}

export interface ReviewItem {
  payment_id: string;
  session_id: string;
  external_ref: string | null;
  status: PaymentStatus;
  held_reason: string | null;
  sender_address: string | null;
  sender_addresses: string[];
  sender_chain: string | null;
  source_asset: string;
  amount_received: string;
  created_at: string;
  legal_ack_at: string | null;
  legal_ack_by_user_id: string | null;
  screening_unresolved_at: string | null;
  /** Return reasons kept by the store because they were worth under $1. */
  kept_small_reasons: string[];
  refunds: Refund[];
  notice?: string;
}

export interface ReturnItem extends Refund {
  session_id: string;
  external_ref: string | null;
  payment_status: PaymentStatus;
}

export interface ReviewQueue {
  notice: string;
  held: ReviewItem[];
  screening_unresolved: ReviewItem[];
  returns: ReturnItem[];
  needs_address: ReturnItem[];
}

/**
 * The fee and gas payer defaults are one store-wide setting (M-6): a change made while viewing test
 * mode changes live checkouts too.
 */
export const CHECKOUT_DEFAULTS_SCOPE_NOTE =
  'Fee and gas defaults: applies to test and live. Changing them here changes both modes.';

export interface CheckoutSettings {
  checkout_domains: string[];
  default_fee_payer: 'merchant' | 'shopper';
  default_gas_payer: 'merchant' | 'shopper';
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  livemode: boolean;
  active: boolean;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  session_id: string | null;
  status: 'pending' | 'delivered' | 'failed' | 'superseded';
  attempts: number;
  status_code: number | null;
  last_error: string | null;
  next_retry_at: string | null;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * A USD decimal string as dollars and cents (`$1,234.57`), rounded half up with BigInt
 * arithmetic. Non-zero amounts under a cent show as `< $0.01`; null shows a dash; anything that is
 * not a plain decimal is returned as is.
 */
export function formatUsd(value: string | null): string {
  if (value === null) return '—';
  const m = DECIMAL.exec(value.trim());
  if (!m) return value;
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? '').padEnd(3, '0');
  let cents = whole * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  if (cents === 0n && /[1-9]/.test(m[2] ?? '')) return '< $0.01';
  const dollars = (cents / 100n).toString();
  const rest = (cents % 100n).toString().padStart(2, '0');
  return `$${group(dollars)}.${rest}`;
}

const FEE_LABEL: Record<FeeKind, string> = {
  tendr_fee: 'Tendr fee',
  oneclick_fee: '1Click fee and spread',
  network_fee: 'Network fee',
  gas_reimbursement: 'Gas reimbursement',
  other: 'Other fee',
};

export interface FormattedFeeLine {
  label: string;
  amount: string;
  usd: string;
  estimated: boolean;
}

/** The fee lines of a payment, labelled and formatted; estimates say so in their label. */
export function feeLines(fees: FeeLine[], livemode: boolean): FormattedFeeLine[] {
  return fees.map((f) => ({
    label: f.estimated
      ? `${FEE_LABEL[f.kind] ?? f.kind} (estimated)`
      : (FEE_LABEL[f.kind] ?? f.kind),
    amount: formatAmount(f.asset, f.amount, livemode),
    usd: formatUsd(f.amount_usd),
    estimated: f.estimated,
  }));
}

const EXPLORERS: Record<string, { live: string; test: string | null }> = {
  near: { live: 'https://nearblocks.io/txns/', test: 'https://testnet.nearblocks.io/txns/' },
  eth: { live: 'https://etherscan.io/tx/', test: null },
  base: { live: 'https://basescan.org/tx/', test: null },
  arb: { live: 'https://arbiscan.io/tx/', test: null },
  arbitrum: { live: 'https://arbiscan.io/tx/', test: null },
  pol: { live: 'https://polygonscan.com/tx/', test: null },
  polygon: { live: 'https://polygonscan.com/tx/', test: null },
  bsc: { live: 'https://bscscan.com/tx/', test: null },
  op: { live: 'https://optimistic.etherscan.io/tx/', test: null },
  optimism: { live: 'https://optimistic.etherscan.io/tx/', test: null },
  avax: { live: 'https://snowtrace.io/tx/', test: null },
  avalanche: { live: 'https://snowtrace.io/tx/', test: null },
  sol: { live: 'https://solscan.io/tx/', test: null },
  tron: { live: 'https://tronscan.org/#/transaction/', test: null },
  btc: { live: 'https://mempool.space/tx/', test: null },
};

/**
 * A block-explorer link for a transaction on `chain` (a 1Click `blockchain` id or contract chain
 * name), or null when there is none for that chain and mode (test mode has NEAR testnet only:
 * other test-mode chains are simulated).
 */
export function explorerTxUrl(
  chain: string | null,
  hash: string,
  livemode: boolean,
): string | null {
  if (!chain) return null;
  const e = Object.hasOwn(EXPLORERS, chain) ? EXPLORERS[chain]! : null;
  const base = e ? (livemode ? e.live : e.test) : null;
  return base ? `${base}${encodeURIComponent(hash)}` : null;
}

/** What a held payment's return is for, in the review card. */
export function returnLabel(reason: string): string {
  if (reason === 'sanctions') return 'Order amount';
  if (reason === 'overpaid') return 'Extra paid';
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/**
 * The destination forms a held payment's review card shows (C41): one per return still waiting
 * for a destination — not sent, not kept small, no proposal yet — each with its own `refund_id`.
 * While the payment is HELD and its order-amount (sanctions) return is not queued yet (nor kept
 * small), a first form without `refund_id` queues and drafts it.
 */
export function heldReturnForms(
  item: Pick<ReviewItem, 'status' | 'kept_small_reasons' | 'refunds'>,
): { refundId: string | null; label: string }[] {
  const forms: { refundId: string | null; label: string }[] = [];
  if (
    item.status === 'HELD' &&
    !item.refunds.some((r) => r.reason === 'sanctions') &&
    !item.kept_small_reasons.includes('sanctions')
  ) {
    forms.push({ refundId: null, label: returnLabel('sanctions') });
  }
  const order = (r: Refund) => (r.reason === 'sanctions' ? 0 : 1);
  for (const r of [...item.refunds].sort((a, b) => order(a) - order(b))) {
    if (r.status === 'confirmed' || r.proposal_id || r.review_reason === 'kept_small') continue;
    forms.push({ refundId: r.id, label: returnLabel(r.reason) });
  }
  return forms;
}

/** Words for a refund's state, as the merchant sees it. */
export function refundStateWords(r: Refund): string {
  if (r.status === 'confirmed') return 'Sent';
  if (r.needs_address) return 'Waiting for the shopper’s address';
  if (r.review_reason === 'kept_small') return 'Kept (worth less than $1)';
  if (r.review_reason) return `Needs review: ${r.review_reason.replace(/_/g, ' ')}`;
  if (r.proposal_id) return 'Waiting for signer approval';
  if (r.status === 'failed') return 'Failed';
  return 'Queued';
}
