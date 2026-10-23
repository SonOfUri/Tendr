import { describe, expect, it } from 'vitest';
import { assertTransition } from './state-machine.js';
import { AppError } from '../lib/errors.js';

describe('assertTransition', () => {
  it('allows valid transitions', () => {
    expect(() => assertTransition('CREATED', 'AWAITING_PAYMENT')).not.toThrow();
    expect(() => assertTransition('PROCESSING', 'SETTLED')).not.toThrow();
  });

  it('rejects invalid settlement from CREATED', () => {
    expect(() => assertTransition('CREATED', 'SETTLED')).toThrow(AppError);
  });
});
