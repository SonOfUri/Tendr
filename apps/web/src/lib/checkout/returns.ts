// What the shopper is told about money going back to them on the "Payment complete" screen (C41).
// A payment can have more than one return (a late overpayment has the late amount and the extra);
// "it stays with the store" is said only when nothing of this payment is being returned at all.
import type { SessionPayment, SessionRefund } from './api';

export type ExtraPaidNotice = 'address' | 'returning' | 'contact' | 'sent' | 'kept' | null;

/**
 * - `contact`: a return of this payment is in review (blocked, or its proposal ended): the shopper
 *   is never told it is on its way (C42); they are asked to contact the store;
 * - `returning`: a return of this payment is queued or waiting on signers (or its overpayment is
 *   not kept and not queued yet);
 * - `sent`: every return of this payment has been sent;
 * - `kept`: part of it was worth under $1 and stays with the store, and nothing else is returned;
 * - null: nothing to say.
 */
export function extraPaidNotice(
  payment: Pick<SessionPayment, 'id' | 'overpaid_amount' | 'kept_small_overpayment' | 'kept_extra'>,
  refunds: (Pick<SessionRefund, 'payment_id' | 'state'> & { needs_address?: boolean })[],
): ExtraPaidNotice {
  const mine = refunds.filter((r) => r.payment_id === payment.id && r.state !== 'kept');
  if (mine.some((r) => r.needs_address)) return 'address';
  if (mine.some((r) => r.state === 'review')) return 'contact';
  if (mine.some((r) => r.state !== 'sent')) return 'returning';
  if (mine.length > 0) return 'sent';
  const overpaid = !!payment.overpaid_amount && /[1-9]/.test(payment.overpaid_amount);
  if (overpaid && !payment.kept_extra) return 'returning';
  return payment.kept_small_overpayment ? 'kept' : null;
}
