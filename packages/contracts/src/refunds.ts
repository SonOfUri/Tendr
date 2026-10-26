import type { RefundReason } from './enums.js';
import type { PaymentStatus, SessionStatus } from './states.js';

/**
 * `partially_refunded`: the store refunded part of a settled payment (merchant refunds, reason
 * `merchant`); `refunded` once all of it went back.
 */
export type RefundStatus = 'none' | 'in_progress' | 'partially_refunded' | 'refunded';

export interface RefundPaymentInput {
  id: string;
  status: PaymentStatus;
  isLate: boolean;
}

export interface RefundInput {
  paymentId: string;
  reason: RefundReason;
  createdAt: Date;
}

function groupStatus(payments: RefundPaymentInput[]): RefundStatus {
  if (payments.some((p) => p.status === 'REFUNDING')) return 'in_progress';
  if (payments.some((p) => p.status === 'REFUNDED')) return 'refunded';
  if (payments.some((p) => p.status === 'PARTIALLY_REFUNDED')) return 'partially_refunded';
  return 'none';
}

export function deriveRefundStatus(
  sessionStatus: SessionStatus,
  payments: RefundPaymentInput[],
  refunds: RefundInput[],
): {
  refundStatus: RefundStatus;
  refundReason: RefundReason | null;
  lateRefundStatus: RefundStatus;
} {
  const isLateOnSettled = (p: RefundPaymentInput): boolean =>
    p.isLate && sessionStatus === 'SETTLED';
  const sessionPayments = payments.filter((p) => !isLateOnSettled(p));
  const latePayments = payments.filter(isLateOnSettled);
  const sessionIds = new Set(sessionPayments.map((p) => p.id));

  let latest: RefundInput | null = null;
  for (const r of refunds) {
    if (!sessionIds.has(r.paymentId)) continue;
    if (latest === null || r.createdAt.getTime() > latest.createdAt.getTime()) latest = r;
  }

  return {
    refundStatus: groupStatus(sessionPayments),
    refundReason: latest?.reason ?? null,
    lateRefundStatus: groupStatus(latePayments),
  };
}
