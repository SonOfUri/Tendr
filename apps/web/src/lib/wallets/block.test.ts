import { describe, expect, it } from 'vitest';
import {
  autoRequoteDue,
  chooseQuotes,
  freshQuoteDue,
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

describe('round 3 (C34)', () => {
  it('after a reopen superseded the quote, a new price is fetched once (never the old address)', () => {
    const base = {
      onPayStep: true,
      tokenAsset: 'nep141:eth',
      quoteAsset: null as string | null,
      loading: false,
      failed: false,
      blocked: false,
      alreadyTried: false,
    };
    expect(freshQuoteDue(base)).toBe(true);
    expect(freshQuoteDue({ ...base, quoteAsset: 'nep141:eth' })).toBe(false);
    expect(freshQuoteDue({ ...base, alreadyTried: true })).toBe(false);
    expect(freshQuoteDue({ ...base, loading: true })).toBe(false);
    expect(freshQuoteDue({ ...base, failed: true })).toBe(false);
    expect(freshQuoteDue({ ...base, blocked: true })).toBe(false);
    expect(freshQuoteDue({ ...base, onPayStep: false })).toBe(false);
  });

  it('an acknowledged record stays blocked while the server counts its deposit', () => {
    const acked: PendingTx = { ...SENT_A, acknowledged: true };
    expect(
      paymentBlock({
        status: 'PENDING_DEPOSIT',
        pending: acked,
        depositSubmittedAt: AT,
        dismissedSubmittedAt: null,
      }),
    ).toBe('sent');
  });
});

describe('round 4 (C35): a blocked tab without a quote', () => {
  const fresh = {
    onPayStep: true,
    tokenAsset: 'nep141:usdc',
    quoteAsset: null as string | null,
    loading: false,
    failed: false,
    blocked: true,
    alreadyTried: false,
  };

  it('confirming "didn\'t go through" lets exactly one fresh quote run', () => {
    // Blocked by another tab's report, and the session was reopened (no current quote).
    const before = paymentBlock({
      status: 'PENDING_DEPOSIT',
      pending: null,
      depositSubmittedAt: AT,
      dismissedSubmittedAt: null,
    });
    expect(before).toBe('sent');
    expect(freshQuoteDue({ ...fresh, blocked: before !== null })).toBe(false);
    // The shopper confirms: that server time is dismissed, the block lifts, one quote is fetched.
    const after = paymentBlock({
      status: 'PENDING_DEPOSIT',
      pending: null,
      depositSubmittedAt: AT,
      dismissedSubmittedAt: AT,
    });
    expect(after).toBeNull();
    expect(freshQuoteDue({ ...fresh, blocked: false })).toBe(true);
    expect(freshQuoteDue({ ...fresh, blocked: false, alreadyTried: true })).toBe(false);
  });

  it('a token chosen while blocked has no quote of its own: confirming fetches one for it', () => {
    // The session still holds a quote for another token; the chosen token has none.
    expect(freshQuoteDue({ ...fresh, blocked: false, quoteAsset: 'nep141:eth' })).toBe(true);
    expect(freshQuoteDue({ ...fresh, blocked: false, quoteAsset: 'nep141:usdc' })).toBe(false);
  });

  it('choosing a token never fetches a price while blocked', () => {
    expect(chooseQuotes({ live: false, blocked: true })).toBe(false);
    expect(chooseQuotes({ live: false, blocked: false })).toBe(true);
    expect(chooseQuotes({ live: true, blocked: false })).toBe(false);
  });
});
