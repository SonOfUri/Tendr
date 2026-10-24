import { describe, expect, it } from 'vitest';
import { canTransitionPayment, canTransitionSession, isTerminalSession } from './states.js';
import type { SessionStatus } from './states.js';

describe('session transitions', () => {
  it.each([
    ['PENDING_DEPOSIT', 'PROCESSING'],
    ['PENDING_DEPOSIT', 'EXPIRED'],
    ['PROCESSING', 'SETTLED'],
    ['PROCESSING', 'REFUNDED'],
    ['EXPIRED', 'LATE_DEPOSIT'],
    ['LATE_DEPOSIT', 'REFUNDED'],
  ] as [SessionStatus, SessionStatus][])('allows %s → %s', (f, t) =>
    expect(canTransitionSession(f, t)).toBe(true),
  );

  it.each([
    ['SETTLED', 'REFUNDED'],
    ['SETTLED', 'LATE_DEPOSIT'],
    ['REFUNDED', 'PENDING_DEPOSIT'],
    ['EXPIRED', 'PENDING_DEPOSIT'],
    ['PENDING_DEPOSIT', 'SETTLED'],
  ] as [SessionStatus, SessionStatus][])('rejects %s → %s', (f, t) =>
    expect(canTransitionSession(f, t)).toBe(false),
  );

  it('terminal states', () => {
    expect(isTerminalSession('SETTLED')).toBe(true);
    expect(isTerminalSession('REFUNDED')).toBe(true);
    expect(isTerminalSession('EXPIRED')).toBe(false);
  });
});

describe('payment transitions', () => {
  it.each([
    ['DETECTED', 'PROCESSING'],
    ['DETECTED', 'REFUNDING'],
    ['PROCESSING', 'SETTLED'],
    ['PROCESSING', 'REFUNDING'],
    ['REFUNDING', 'REFUNDED'],
  ] as const)('payment allows %s → %s', (f, t) => expect(canTransitionPayment(f, t)).toBe(true));

  it('payment SETTLED is terminal', () =>
    expect(canTransitionPayment('SETTLED', 'REFUNDING')).toBe(false));
});
