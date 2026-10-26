import { describe, expect, it } from 'vitest';
import { autoRequoteDue, mustRequoteBeforeSend, paymentBlock } from './block';
import type { PendingTx } from './tx-store';

const SENT_A: PendingTx = { txHash: '0xaa', quoteId: 'quo_A', reported: true, state: 'sent' };
const AT = '2026-10-26T12:01:00.000Z';

describe('paymentBlock: no second wallet payment while one may be on its way (C32)', () => {
  const base = {
    status: 'PENDING_DEPOSIT',
    pending: null as PendingTx | null,
    depositSubmittedAt: null as string | null,
    dismissedSubmittedAt: null as string | null,
  };

  it('nothing sent: no block', () => {
    expect(paymentBlock(base)).toBeNull();
  });

  it('a local record blocks, whatever the current quote is (a re-quote after a send)', () => {
    // The record is for quote A; the page now shows quote B. Still blocked.
    expect(paymentBlock({ ...base, pending: SENT_A })).toBe('sent');
    expect(
      paymentBlock({ ...base, pending: { ...SENT_A, state: 'uncertain', txHash: null } }),
    ).toBe('uncertain');
    expect(paymentBlock({ ...base, pending: { ...SENT_A, state: 'failed' } })).toBe('failed');
  });

  it("another tab's deposit (server deposit_submitted_at) blocks this tab", () => {
    expect(paymentBlock({ ...base, depositSubmittedAt: AT })).toBe('sent');
  });

  it('"My payment didn\'t go through" lifts that block, and a newer deposit blocks again', () => {
    expect(paymentBlock({ ...base, depositSubmittedAt: AT, dismissedSubmittedAt: AT })).toBeNull();
    expect(
      paymentBlock({
        ...base,
        depositSubmittedAt: '2026-10-26T12:05:00.000Z',
        dismissedSubmittedAt: AT,
      }),
    ).toBe('sent');
  });

  it('ends once the session leaves PENDING_DEPOSIT', () => {
    expect(
      paymentBlock({ ...base, status: 'PROCESSING', pending: SENT_A, depositSubmittedAt: AT }),
    ).toBeNull();
  });
});

describe('re-quoting around a send', () => {
  const NOW = Date.parse('2026-10-26T12:10:00Z');
  const expired = { id: 'quo_A', deadline: '2026-10-26T12:09:00Z' };
  const live = { id: 'quo_A', deadline: '2026-10-26T12:11:00Z' };

  it('the automatic re-quote never runs while a payment is blocked', () => {
    expect(autoRequoteDue({ quote: expired, now: NOW, blocked: true, lastAutoId: null })).toBe(
      false,
    );
    expect(autoRequoteDue({ quote: expired, now: NOW, blocked: false, lastAutoId: null })).toBe(
      true,
    );
    expect(autoRequoteDue({ quote: expired, now: NOW, blocked: false, lastAutoId: 'quo_A' })).toBe(
      false,
    );
    expect(autoRequoteDue({ quote: live, now: NOW, blocked: false, lastAutoId: null })).toBe(false);
  });

  it('the deadline is re-checked right before opening the wallet (15 s margin)', () => {
    expect(mustRequoteBeforeSend('2026-10-26T12:11:00Z', NOW)).toBe(false);
    expect(mustRequoteBeforeSend('2026-10-26T12:10:10Z', NOW)).toBe(true);
    expect(mustRequoteBeforeSend('2026-10-26T12:09:00Z', NOW)).toBe(true);
    expect(mustRequoteBeforeSend('not a date', NOW)).toBe(true);
  });
});
