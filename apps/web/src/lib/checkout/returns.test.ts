import { describe, expect, it } from 'vitest';
import { extraPaidNotice } from './returns';

const payment = (over: { overpaid?: string | null; kept?: string[] } = {}) => ({
  id: 'pay_1',
  overpaid_amount: over.overpaid ?? null,
  kept_small_overpayment: (over.kept ?? []).length > 0,
  kept_small_reasons: over.kept ?? [],
});
const ret = (state: string, reason = 'overpaid', paymentId = 'pay_1') => ({
  id: `ref_${reason}`,
  payment_id: paymentId,
  reason,
  state,
});

describe('extraPaidNotice (C41)', () => {
  it('a return still being sent wins over a kept part', () => {
    expect(extraPaidNotice(payment({ kept: ['late'] }), [ret('processing', 'overpaid')])).toBe(
      'returning',
    );
    expect(extraPaidNotice(payment({ kept: ['overpaid'] }), [ret('review', 'late')])).toBe(
      'returning',
    );
  });

  it('a sent return says it was sent back', () => {
    expect(extraPaidNotice(payment({ kept: ['late'] }), [ret('sent', 'overpaid')])).toBe('sent');
  });

  it('kept only when nothing else is being returned', () => {
    expect(extraPaidNotice(payment({ overpaid: '5', kept: ['overpaid'] }), [])).toBe('kept');
    // Kept rows themselves never count as being returned.
    expect(extraPaidNotice(payment({ overpaid: '5', kept: ['overpaid'] }), [ret('kept')])).toBe(
      'kept',
    );
  });

  it('an overpayment not kept and not queued yet is on its way back; nothing → null', () => {
    expect(extraPaidNotice(payment({ overpaid: '5' }), [])).toBe('returning');
    expect(extraPaidNotice(payment(), [])).toBeNull();
    // Another payment's return is not this one's.
    expect(extraPaidNotice(payment(), [ret('processing', 'overpaid', 'pay_2')])).toBeNull();
  });
});
