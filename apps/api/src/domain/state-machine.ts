import { canTransition, type PaymentStatus } from '@tendr/contracts';
import { invalidState } from '../lib/errors.js';

export function assertTransition(from: string, to: string): void {
  if (!canTransition(from as PaymentStatus, to as PaymentStatus)) {
    throw invalidState(`Cannot transition from ${from} to ${to}`);
  }
}
