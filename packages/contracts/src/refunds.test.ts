import { describe, expect, it } from 'vitest';
import { deriveRefundStatus } from './refunds.js';
import type { PaymentStatus } from './states.js';

const p = (id: string, status: PaymentStatus, isLate = false) => ({ id, status, isLate });

describe('deriveRefundStatus', () => {
  it('none when no refunding/refunded payments', () =>
    expect(deriveRefundStatus('SETTLED', [p('a', 'SETTLED')], [])).toEqual({
      refundStatus: 'none',
      refundReason: null,
      lateRefundStatus: 'none',
    }));

  it('in_progress wins over refunded; reason from latest refund', () =>
    expect(
      deriveRefundStatus(
        'PROCESSING',
        [p('a', 'REFUNDED'), p('b', 'REFUNDING')],
        [
          { paymentId: 'a', reason: 'failed', createdAt: new Date(1) },
          { paymentId: 'b', reason: 'underpaid', createdAt: new Date(2) },
        ],
      ),
    ).toMatchObject({ refundStatus: 'in_progress', refundReason: 'underpaid' }));

  it('late refund on a SETTLED session goes only to lateRefundStatus', () =>
    expect(
      deriveRefundStatus(
        'SETTLED',
        [p('a', 'SETTLED'), p('b', 'REFUNDED', true)],
        [{ paymentId: 'b', reason: 'late', createdAt: new Date(1) }],
      ),
    ).toEqual({ refundStatus: 'none', refundReason: null, lateRefundStatus: 'refunded' }));

  it('late deposit on an expired session counts as the session refund', () =>
    expect(
      deriveRefundStatus(
        'LATE_DEPOSIT',
        [p('a', 'REFUNDING', true)],
        [{ paymentId: 'a', reason: 'expired', createdAt: new Date(1) }],
      ),
    ).toMatchObject({
      refundStatus: 'in_progress',
      refundReason: 'expired',
      lateRefundStatus: 'none',
    }));

  it('held and screening-pending payments are not refunds yet', () =>
    expect(deriveRefundStatus('HELD', [p('a', 'HELD'), p('b', 'SCREENING_PENDING')], [])).toEqual({
      refundStatus: 'none',
      refundReason: null,
      lateRefundStatus: 'none',
    }));

  it('a held payment being refunded with the sanctions reason is in progress', () =>
    expect(
      deriveRefundStatus(
        'HELD',
        [p('a', 'REFUNDING')],
        [{ paymentId: 'a', reason: 'sanctions', createdAt: new Date(1) }],
      ),
    ).toMatchObject({ refundStatus: 'in_progress', refundReason: 'sanctions' }));

  it('a store refund of part of a settled payment is partially_refunded, then refunded', () => {
    const refunds = [{ paymentId: 'a', reason: 'merchant' as const, createdAt: new Date(1) }];
    expect(deriveRefundStatus('SETTLED', [p('a', 'PARTIALLY_REFUNDED')], refunds)).toEqual({
      refundStatus: 'partially_refunded',
      refundReason: 'merchant',
      lateRefundStatus: 'none',
    });
    expect(deriveRefundStatus('SETTLED', [p('a', 'REFUNDED')], refunds)).toMatchObject({
      refundStatus: 'refunded',
      refundReason: 'merchant',
    });
  });
});
