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
  const serverCounts =
    opts.depositSubmittedAt !== null && opts.depositSubmittedAt !== opts.dismissedSubmittedAt;
  if (opts.pending) {
    // A record the API acknowledged is tracked there: once the watcher has recorded that deposit
    // the server stops counting it (C33), and this tab follows, so a reopened session isn't stuck.
    // A record the API never acknowledged (refused, not reported yet, failed on chain) blocks.
    if (opts.pending.acknowledged && !serverCounts) return null;
    return opts.pending.state;
  }
  return serverCounts ? 'sent' : null;
}

/** Whether the page should fetch a new price on its own (once per expired quote, never blocked). */
export function autoRequoteDue(opts: {
  quote: { id: string; deadline: string };
  now: number;
  blocked: boolean;
  /** A wallet send is in flight: the quote it pays must not be replaced under it. */
  sending?: boolean;
  lastAutoId: string | null;
}): boolean {
  if (opts.blocked || opts.sending) return false;
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

/**
 * Whether the manual send details (deposit address, amount) are shown. While blocked and past
 * the quote's deadline the address is expired: only the notice and the confirm control remain.
 */
export function showManualSend(blocked: PaymentBlock, deadline: string, now: number): boolean {
  if (blocked === null) return true;
  const t = Date.parse(deadline);
  return Number.isFinite(t) && t > now;
}

/** A block from a poll waits until a wallet send in flight has settled before replacing it. */
export function showBlockNotice(blocked: PaymentBlock, sending: boolean): boolean {
  return blocked !== null && !sending;
}

/**
 * The session is taking payments but has no current quote (the watcher reopened it and superseded
 * the old one, C34): fetch a new price once, so the old deposit address is never shown again.
 */
export function freshQuoteDue(opts: {
  onPayStep: boolean;
  hasQuote: boolean;
  loading: boolean;
  failed: boolean;
  blocked: boolean;
  alreadyTried: boolean;
}): boolean {
  return (
    opts.onPayStep &&
    !opts.hasQuote &&
    !opts.loading &&
    !opts.failed &&
    !opts.blocked &&
    !opts.alreadyTried
  );
}
