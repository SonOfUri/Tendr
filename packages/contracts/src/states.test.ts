import { describe, expect, it } from 'vitest';
import {
  PaymentStatusValues,
  SessionStatusValues,
  canTransitionPayment,
  canTransitionSession,
  isTerminalSession,
} from './states.js';
import type { PaymentStatus, SessionStatus } from './states.js';

describe('session transitions', () => {
  it.each([
    ['PENDING_DEPOSIT', 'PROCESSING'],
    ['PENDING_DEPOSIT', 'EXPIRED'],
    ['PROCESSING', 'SETTLED'],
    ['PROCESSING', 'REFUNDED'],
    ['PROCESSING', 'HELD'],
    ['PROCESSING', 'PENDING_DEPOSIT'],
    ['PROCESSING', 'SCREENING_PENDING'],
    ['SCREENING_PENDING', 'SETTLED'],
    ['SCREENING_PENDING', 'HELD'],
    ['SCREENING_PENDING', 'REFUNDED'],
    ['EXPIRED', 'LATE_DEPOSIT'],
    ['LATE_DEPOSIT', 'REFUNDED'],
    ['LATE_DEPOSIT', 'HELD'],
    ['HELD', 'REFUNDED'],
  ] as [SessionStatus, SessionStatus][])('allows %s → %s', (f, t) =>
    expect(canTransitionSession(f, t)).toBe(true),
  );

  it.each([
    ['SETTLED', 'REFUNDED'],
    ['SETTLED', 'LATE_DEPOSIT'],
    ['REFUNDED', 'PENDING_DEPOSIT'],
    ['EXPIRED', 'PENDING_DEPOSIT'],
    ['PENDING_DEPOSIT', 'SETTLED'],
    ['HELD', 'SETTLED'],
    ['HELD', 'PENDING_DEPOSIT'],
    ['SCREENING_PENDING', 'PENDING_DEPOSIT'],
    ['PENDING_DEPOSIT', 'HELD'],
    ['EXPIRED', 'HELD'],
  ] as [SessionStatus, SessionStatus][])('rejects %s → %s', (f, t) =>
    expect(canTransitionSession(f, t)).toBe(false),
  );

  it('SETTLED and REFUNDED reject every move', () => {
    for (const to of SessionStatusValues) {
      expect(canTransitionSession('SETTLED', to), `SETTLED → ${to}`).toBe(false);
      expect(canTransitionSession('REFUNDED', to), `REFUNDED → ${to}`).toBe(false);
    }
  });

  it('terminal states', () => {
    expect(isTerminalSession('SETTLED')).toBe(true);
    expect(isTerminalSession('REFUNDED')).toBe(true);
    expect(isTerminalSession('EXPIRED')).toBe(false);
    expect(isTerminalSession('HELD')).toBe(false);
    expect(isTerminalSession('SCREENING_PENDING')).toBe(false);
  });
});

describe('payment transitions', () => {
  it.each([
    ['DETECTED', 'PROCESSING'],
    ['DETECTED', 'REFUNDING'],
    ['PROCESSING', 'SETTLED'],
    ['PROCESSING', 'REFUNDING'],
    ['REFUNDING', 'REFUNDED'],
    ['DETECTED', 'HELD'],
    ['PROCESSING', 'HELD'],
    ['DETECTED', 'SCREENING_PENDING'],
    ['PROCESSING', 'SCREENING_PENDING'],
    ['SCREENING_PENDING', 'SETTLED'],
    ['SCREENING_PENDING', 'HELD'],
    ['HELD', 'REFUNDING'],
    ['SCREENING_PENDING', 'REFUNDING'],
  ] as [PaymentStatus, PaymentStatus][])('payment allows %s → %s', (f, t) =>
    expect(canTransitionPayment(f, t)).toBe(true),
  );

  it.each([
    ['HELD', 'SETTLED'],
    ['HELD', 'REFUNDED'],
    ['SCREENING_PENDING', 'REFUNDED'],
    ['SCREENING_PENDING', 'PROCESSING'],
    ['REFUNDING', 'HELD'],
  ] as [PaymentStatus, PaymentStatus][])('payment rejects %s → %s', (f, t) =>
    expect(canTransitionPayment(f, t)).toBe(false),
  );

  it('payment SETTLED and REFUNDED are terminal', () => {
    for (const to of PaymentStatusValues) {
      expect(canTransitionPayment('SETTLED', to), `SETTLED → ${to}`).toBe(false);
      expect(canTransitionPayment('REFUNDED', to), `REFUNDED → ${to}`).toBe(false);
    }
  });
});
