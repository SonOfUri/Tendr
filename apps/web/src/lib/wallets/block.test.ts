import { describe, expect, it } from 'vitest';
import {
  autoRequoteDue,
  mustRequoteBeforeSend,
  paymentBlock,
  showBlockNotice,
  showManualSend,
} from './block';
import type { PendingTx } from './tx-store';

const SENT_A: PendingTx = {
  txHash: '0xaa',
  quoteId: 'quo_A',
  reported: true,
  state: 'sent',
  acknowledged: false,
};
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

describe('round 2 (C33)', () => {
  const base = {
    status: 'PENDING_DEPOSIT',
    pending: null as PendingTx | null,
    depositSubmittedAt: null as string | null,
    dismissedSubmittedAt: null as string | null,
  };
  const ACKED: PendingTx = { ...SENT_A, acknowledged: true };

  it('a fresh tab after the watcher reopened the session is not blocked', () => {
    // The API no longer counts a deposit the watcher recorded: deposit_submitted_at is null.
    expect(paymentBlock({ ...base, depositSubmittedAt: null })).toBeNull();
  });

  it('a record the API acknowledged follows the server: blocked while counted, free once resolved', () => {
    expect(paymentBlock({ ...base, pending: ACKED, depositSubmittedAt: AT })).toBe('sent');
    // This tab missed the PROCESSING window; the server says the deposit was recorded.
    expect(paymentBlock({ ...base, pending: ACKED, depositSubmittedAt: null })).toBeNull();
    // Never acknowledged (refused, not reported yet, failed on chain): stays blocked.
    expect(paymentBlock({ ...base, pending: SENT_A, depositSubmittedAt: null })).toBe('sent');
    expect(
      paymentBlock({
        ...base,
        pending: { ...ACKED, state: 'uncertain' },
        depositSubmittedAt: null,
      }),
    ).toBeNull();
  });

  it('no automatic re-quote while a wallet send is in flight', () => {
    const expired = { id: 'quo_A', deadline: '2026-10-26T12:09:00Z' };
    const now = Date.parse('2026-10-26T12:10:00Z');
    expect(
      autoRequoteDue({ quote: expired, now, blocked: false, sending: true, lastAutoId: null }),
    ).toBe(false);
  });

  it('past the deadline while blocked the expired deposit address is hidden; before it, shown', () => {
    const now = Date.parse('2026-10-26T12:10:00Z');
    expect(showManualSend('sent', '2026-10-26T12:09:00Z', now)).toBe(false);
    expect(showManualSend('uncertain', '2026-10-26T12:09:59Z', now)).toBe(false);
    expect(showManualSend('sent', '2026-10-26T12:11:00Z', now)).toBe(true);
    expect(showManualSend(null, '2026-10-26T12:09:00Z', now)).toBe(true);
  });

  it('a block from a poll waits for a wallet send in flight to settle', () => {
    expect(showBlockNotice('sent', true)).toBe(false);
    expect(showBlockNotice('sent', false)).toBe(true);
    expect(showBlockNotice(null, false)).toBe(false);
  });
});
