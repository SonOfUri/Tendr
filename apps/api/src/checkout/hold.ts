// Sanctions holds. A hold is a non-custodial notice (spec "Changes after external plan review"
// #3): Tendr cannot freeze money already swapped into a merchant account. The order stays unpaid,
// `payment.held` replaces the paid webhook, and every signer is told, in exactly these words, that
// the funds are theirs to keep untouched.
import type { Prisma } from '@prisma/client';
import { HOLD_NOTICE } from '@tendr/contracts';
import type { ScopeContext } from '../db/scoped.js';
import { recordEvent } from '../events/record.js';
import { transitionPayment, transitionSession } from '../events/transitions.js';
import { notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { sessionRefs } from './session-refs.js';

/** The non-custodial notice to all signers, verbatim (spec "Changes" #3; in @tendr/contracts). */
export { HOLD_NOTICE };

/** Payment statuses a hold applies to (from the state machine: → HELD). */
const HOLDABLE_PAYMENT = new Set(['DETECTED', 'PROCESSING', 'SCREENING_PENDING']);

/** Session statuses a held payment also holds (the session is waiting on this payment). */
const SESSION_HOLDABLE = new Set(['PROCESSING', 'SCREENING_PENDING', 'LATE_DEPOSIT']);

/**
 * Holds a payment from a sanctioned sender inside the caller's `tenantTransaction` (same `ctx`):
 * payment → HELD (`held_reason = sanctions`), the session → HELD when it is waiting on this
 * payment, and `payment.held` carrying the notice for all signers. A payment already HELD is a
 * no-op. Never settles and never refunds.
 */
export async function holdPaymentInTx(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  paymentId: string,
): Promise<boolean> {
  const tenant = { merchantId: ctx.merchantId, livemode: ctx.livemode };
  // Serialise with the watcher's other payment writes (settle, refund) on this row.
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
  const p = await tx.payment.findFirst({
    where: { id: paymentId, ...tenant },
    select: { id: true, status: true, sessionId: true, isLate: true, senderAddress: true },
  });
  if (!p) throw notFound('Payment not found');
  if (p.status === 'HELD') return false;
  if (!HOLDABLE_PAYMENT.has(p.status)) {
    // Already settled, refunding or refunded: a hold cannot apply; ops must look at it.
    log('error', 'hold skipped: payment is no longer holdable', { paymentId, status: p.status });
    return false;
  }
  await transitionPayment(tx, ctx, p.id, 'HELD', { reason: 'sanctions' });
  await tx.payment.updateMany({
    where: { id: p.id, ...tenant },
    data: { heldReason: 'sanctions' },
  });
  const s = await tx.session.findFirst({
    where: { id: p.sessionId, ...tenant },
    select: { status: true, externalRef: true, paymentLinkId: true, payerNote: true },
  });
  // A PROCESSING session waits on this payment unless the payment is a late extra one.
  if (s && SESSION_HOLDABLE.has(s.status) && !(s.status === 'PROCESSING' && p.isLate)) {
    await transitionSession(tx, ctx, p.sessionId, 'HELD', { reason: 'sanctions' });
  }
  await recordEvent(tx, ctx, {
    aggregateType: 'payment',
    aggregateId: p.id,
    type: 'payment.held',
    payload: {
      payment_id: p.id,
      session_id: p.sessionId,
      ...sessionRefs(s ?? { externalRef: null, paymentLinkId: null, payerNote: null }),
      held_reason: 'sanctions',
      sender_address: p.senderAddress,
      notify: 'all_signers',
      notice: HOLD_NOTICE,
    },
  });
  return true;
}
