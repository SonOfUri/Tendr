// When the checkout must not take another wallet payment (C32), and the re-quote rules around it.
//
// Blocked while the session is PENDING_DEPOSIT and any of these is true:
// - this tab has a payment record (sent, possibly sent, or failed on chain: tx-store.ts), which
//   also covers a hash a wallet popup reported;
// - the server reports `deposit_submitted_at` (a deposit reported from another tab or window),
//   unless the shopper confirmed "My payment didn't go through" for exactly that time.
// While blocked: no wallet send and no automatic re-quote. It ends when the session moves on, or
// when the shopper confirms the payment didn't go through.
import type { PendingState, PendingTx } from './tx-store';

export type PaymentBlock = PendingState | null;

export function paymentBlock(opts: {
  status: string;
  pending: PendingTx | null;
  depositSubmittedAt: string | null;
  dismissedSubmittedAt: string | null;
}): PaymentBlock {
  if (opts.status !== 'PENDING_DEPOSIT') return null;
  if (opts.pending) return opts.pending.state;
  if (opts.depositSubmittedAt && opts.depositSubmittedAt !== opts.dismissedSubmittedAt) {
    return 'sent';
  }
  return null;
}

/** Whether the page should fetch a new price on its own (once per expired quote, never blocked). */
export function autoRequoteDue(opts: {
  quote: { id: string; deadline: string };
  now: number;
  blocked: boolean;
  lastAutoId: string | null;
}): boolean {
  if (opts.blocked) return false;
  if (Date.parse(opts.quote.deadline) > opts.now) return false;
  return opts.lastAutoId !== opts.quote.id;
}

/** Margin before the deadline under which the wallet is not opened (the price is renewed first). */
export const SEND_DEADLINE_MARGIN_MS = 15_000;

/** Checked immediately before opening the wallet: true means re-quote instead of sending. */
export function mustRequoteBeforeSend(deadline: string, now: number): boolean {
  const t = Date.parse(deadline);
  return !Number.isFinite(t) || t - now <= SEND_DEADLINE_MARGIN_MS;
}
