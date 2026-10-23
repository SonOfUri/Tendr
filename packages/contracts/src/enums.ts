export const CheckoutModes = ['sandbox', 'live'] as const;
export type CheckoutMode = (typeof CheckoutModes)[number];

export const CheckoutSessionStatuses = [
  'CREATED',
  'AWAITING_PAYMENT',
  'PROCESSING',
  'SETTLED',
  'EXPIRED',
  'FAILED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export type CheckoutSessionStatus = (typeof CheckoutSessionStatuses)[number];

export const PaymentStatuses = [
  'CREATED',
  'AWAITING_PAYMENT',
  'PROCESSING',
  'SETTLED',
  'EXPIRED',
  'FAILED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PaymentStatuses)[number];

export const WebhookEventTypes = [
  'checkout.session.created',
  'payment.pending',
  'payment.processing',
  'payment.settled',
  'payment.failed',
  'payment.expired',
  'payment.refunded',
] as const;
export type WebhookEventType = (typeof WebhookEventTypes)[number];

/** Allowed payment/session transitions. Browser cannot settle. */
export const ALLOWED_STATUS_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ['AWAITING_PAYMENT', 'EXPIRED', 'FAILED'],
  AWAITING_PAYMENT: ['PROCESSING', 'EXPIRED', 'FAILED'],
  PROCESSING: ['SETTLED', 'FAILED', 'REFUND_PENDING'],
  SETTLED: [],
  EXPIRED: [],
  FAILED: [],
  REFUND_PENDING: ['REFUNDED', 'FAILED'],
  REFUNDED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}
