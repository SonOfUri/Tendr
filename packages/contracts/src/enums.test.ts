import { describe, expect, it } from 'vitest';
import { canTransition } from './enums.js';

describe('canTransition', () => {
  it('allows CREATED → AWAITING_PAYMENT', () => {
    expect(canTransition('CREATED', 'AWAITING_PAYMENT')).toBe(true);
  });

  it('rejects browser-style CREATED → SETTLED', () => {
    expect(canTransition('CREATED', 'SETTLED')).toBe(false);
  });

  it('allows PROCESSING → SETTLED', () => {
    expect(canTransition('PROCESSING', 'SETTLED')).toBe(true);
  });
});
