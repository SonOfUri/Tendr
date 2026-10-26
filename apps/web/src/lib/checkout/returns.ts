// What the shopper is told about money going back to them on the "Payment complete" screen (C41).
// A payment can have more than one return (a late overpayment has the late amount and the extra);
// "it stays with the store" is said only when nothing of this payment is being returned at all.
import type { SessionPayment, SessionRefund } from './api';

export type ExtraPaidNotice = 'returning' | 'sent' | 'kept' | null;

/**
 * - `returning`: a return of this payment is queued, waiting on signers or in review (or its
 *   overpayment is not kept and not queued yet);
 * - `sent`: every return of this payment has been sent;
 * - `kept`: part of it was worth under $1 and stays with the store, and nothing else is returned;
 * - null: nothing to say.
 */
export function extraPaidNotice(
  payment: Pick<SessionPayment, 'id' | 'overpaid_amount' | 'kept_small_reasons'>,
  refunds: Pick<SessionRefund, 'payment_id' | 'state'>[],
): ExtraPaidNotice {
  const mine = refunds.filter((r) => r.payment_id === payment.id && r.state !== 'kept');
  if (mine.some((r) => r.state !== 'sent')) return 'returning';
  if (mine.length > 0) return 'sent';
  const kept = payment.kept_small_reasons ?? [];
  const overpaid = !!payment.overpaid_amount && /[1-9]/.test(payment.overpaid_amount);
  if (overpaid && !kept.includes('overpaid')) return 'returning';
  return kept.length > 0 ? 'kept' : null;
}
