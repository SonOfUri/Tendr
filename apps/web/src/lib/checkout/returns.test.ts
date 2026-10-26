import { describe, expect, it } from 'vitest';
import { extraPaidNotice } from './returns';

const payment = (
  over: { overpaid?: string | null; keptExtra?: boolean; keptAny?: boolean } = {},
) => ({
  id: 'pay_1',
  overpaid_amount: over.overpaid ?? null,
  kept_small_overpayment: over.keptAny ?? over.keptExtra ?? false,
  kept_extra: over.keptExtra ?? false,
});
const ret = (state: string, paymentId = 'pay_1') => ({ id: 'ref_1', payment_id: paymentId, state });

describe('extraPaidNotice (C41, C42)', () => {
  it('a return still being sent wins over a kept part', () => {
    expect(extraPaidNotice(payment({ keptAny: true }), [ret('processing')])).toBe('returning');
  });

  it('a blocked return (in review) is never "being sent back": contact the store (C42)', () => {
    expect(extraPaidNotice(payment({ overpaid: '5' }), [ret('review')])).toBe('contact');
    expect(extraPaidNotice(payment({ overpaid: '5' }), [ret('review'), ret('processing')])).toBe(
      'contact',
    );
  });

  it('a sent return says it was sent back', () => {
    expect(extraPaidNotice(payment({ keptAny: true }), [ret('sent')])).toBe('sent');
  });

  it('kept only when nothing else is being returned', () => {
    expect(extraPaidNotice(payment({ overpaid: '5', keptExtra: true }), [])).toBe('kept');
    // Kept rows themselves never count as being returned.
    expect(extraPaidNotice(payment({ overpaid: '5', keptExtra: true }), [ret('kept')])).toBe(
      'kept',
    );
  });

  it('an overpayment not kept and not queued yet is on its way back; nothing → null', () => {
    expect(extraPaidNotice(payment({ overpaid: '5' }), [])).toBe('returning');
    expect(extraPaidNotice(payment(), [])).toBeNull();
    // Another payment's return is not this one's.
    expect(extraPaidNotice(payment(), [ret('processing', 'pay_2')])).toBeNull();
  });
});
