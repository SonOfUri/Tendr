import { z } from 'zod';

export const SessionStatusValues = [
  'PENDING_DEPOSIT',
  'PROCESSING',
  'SETTLED',
  'REFUNDED',
  'EXPIRED',
  'LATE_DEPOSIT',
] as const;
export type SessionStatus = (typeof SessionStatusValues)[number];
export const SessionStatusSchema = z.enum(SessionStatusValues);

export const SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  PENDING_DEPOSIT: ['PROCESSING', 'EXPIRED'],
  PROCESSING: ['SETTLED', 'REFUNDED'],
  EXPIRED: ['LATE_DEPOSIT'],
  LATE_DEPOSIT: ['REFUNDED'],
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
] as const;
export type PaymentStatus = (typeof PaymentStatusValues)[number];
export const PaymentStatusSchema = z.enum(PaymentStatusValues);

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  DETECTED: ['PROCESSING', 'REFUNDING'],
  PROCESSING: ['SETTLED', 'REFUNDING'],
  REFUNDING: ['REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}
