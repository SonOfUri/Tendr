import { z } from 'zod';

export const SessionStatusValues = [
  'PENDING_DEPOSIT',
  'PROCESSING',
  'SETTLED',
  'REFUNDED',
  'EXPIRED',
  'LATE_DEPOSIT',
  'HELD',
  'SCREENING_PENDING',
] as const;
export type SessionStatus = (typeof SessionStatusValues)[number];
export const SessionStatusSchema = z.enum(SessionStatusValues);

/**
 * Session moves. `PROCESSING → PENDING_DEPOSIT` is only for an underpay retry while the session is
 * unexpired (the caller checks `expires_at`). `HELD` (sanctioned sender) leaves only through a
 * refund. `SCREENING_PENDING` waits for sanctions screening to become available; it ends REFUNDED
 * when 1Click refunds the deposit straight to the shopper's own address meanwhile.
 */
export const SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  PENDING_DEPOSIT: ['PROCESSING', 'EXPIRED'],
  PROCESSING: ['SETTLED', 'REFUNDED', 'HELD', 'PENDING_DEPOSIT', 'SCREENING_PENDING'],
  SCREENING_PENDING: ['SETTLED', 'HELD', 'REFUNDED'],
  EXPIRED: ['LATE_DEPOSIT'],
  LATE_DEPOSIT: ['REFUNDED', 'HELD'],
  HELD: ['REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export function isTerminalSession(s: SessionStatus): boolean {
  return s === 'SETTLED' || s === 'REFUNDED';
}

export const PaymentStatusValues = [
  'DETECTED',
  'PROCESSING',
  'SETTLED',
  'REFUNDING',
  'REFUNDED',
  'HELD',
  'SCREENING_PENDING',
] as const;
export type PaymentStatus = (typeof PaymentStatusValues)[number];
export const PaymentStatusSchema = z.enum(PaymentStatusValues);

/**
 * Payment moves. A `HELD` payment (sanctioned sender) is never settled; it leaves only through a
 * signer-approved refund proposal, or when 1Click refunds the deposit straight to the shopper's own
 * address. `SCREENING_PENDING` settles on `allow`, holds on `block`, or is refunded (REFUNDING)
 * when 1Click refunds it directly.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  DETECTED: ['PROCESSING', 'REFUNDING', 'HELD', 'SCREENING_PENDING'],
  PROCESSING: ['SETTLED', 'REFUNDING', 'HELD', 'SCREENING_PENDING'],
  SCREENING_PENDING: ['SETTLED', 'HELD', 'REFUNDING'],
  HELD: ['REFUNDING'],
  REFUNDING: ['REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}
