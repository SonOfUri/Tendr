import { describe, expect, it, vi } from 'vitest';
import { CheckoutApiError } from '@/lib/checkout/api';
import { createDepositReporter, loadPendingTx, pendingTxKey } from './tx-store';

const SID = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const HASH = '0x' + 'ab'.repeat(32);

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

const network = () => new CheckoutApiError(0, 'NETWORK_ERROR', 'down');

describe('deposit reporting survives failures and reloads', () => {
  it('keeps the hash in sessionStorage before the first POST', async () => {
    const storage = memoryStorage();
    let seenAtPost: string | undefined;
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit: async () => {
        seenAtPost = storage.map.get(pendingTxKey(SID));
        return { submitted: true };
      },
      sleep: async () => {},
    });
    expect(await reporter.report(HASH, 'quo_1')).toBe('reported');
    expect(JSON.parse(seenAtPost!)).toMatchObject({ txHash: HASH, quoteId: 'quo_1' });
    expect(pendingTxKey(SID)).toBe(`tendr:tx:${SID}`);
    expect(loadPendingTx(storage, SID)).toEqual({
      txHash: HASH,
      quoteId: 'quo_1',
      reported: true,
      state: 'sent',
    });
  });

  it('retries a network failure with backoff, then succeeds', async () => {
    const storage = memoryStorage();
    const deposit = vi
      .fn()
      .mockRejectedValueOnce(network())
      .mockRejectedValueOnce(new CheckoutApiError(503, 'PROVIDER_UNAVAILABLE', 'x'))
      .mockResolvedValueOnce({ submitted: true });
    const sleep = vi.fn(async (_ms: number) => {});
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit,
      sleep,
    });
    expect(await reporter.report(HASH, 'quo_1')).toBe('reported');
    expect(deposit).toHaveBeenCalledTimes(3);
    expect(deposit).toHaveBeenCalledWith(HASH, 'quo_1');
    const waits = sleep.mock.calls.map((c) => c[0]);
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  it('a reload resubmits the saved hash instead of asking for a second payment', async () => {
    const storage = memoryStorage();
    // First page: every POST fails, then the shopper reloads.
    const first = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit: async () => {
        throw network();
      },
      sleep: async () => {},
      delaysMs: [1, 1],
    });
    expect(await first.report(HASH, 'quo_1')).toBe('gave_up');
    expect(loadPendingTx(storage, SID)).toEqual({
      txHash: HASH,
      quoteId: 'quo_1',
      reported: false,
      state: 'sent',
    });

    // Reloaded page: a new reporter finds the hash and posts it.
    const deposit = vi.fn(async () => ({ submitted: true }));
    const onChange = vi.fn();
    const second = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit,
      sleep: async () => {},
      onChange,
    });
    expect(second.pending()).toEqual({
      txHash: HASH,
      quoteId: 'quo_1',
      reported: false,
      state: 'sent',
    });
    expect(await second.resume()).toBe('reported');
    expect(deposit).toHaveBeenCalledWith(HASH, 'quo_1');
    expect(onChange).toHaveBeenLastCalledWith({
      txHash: HASH,
      quoteId: 'quo_1',
      reported: true,
      state: 'sent',
    });
    // Already reported: a later resume does not post again.
    expect(await second.resume()).toBe('reported');
    expect(deposit).toHaveBeenCalledTimes(1);
  });

  it('stops on a refusal (e.g. the quote expired) but keeps the record', async () => {
    const storage = memoryStorage();
    const deposit = vi.fn(async () => {
      throw new CheckoutApiError(409, 'CONFLICT', 'expired');
    });
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit,
      sleep: async () => {},
    });
    expect(await reporter.report(HASH, 'quo_1')).toBe('refused');
    expect(deposit).toHaveBeenCalledTimes(1);
    expect(loadPendingTx(storage, SID)?.txHash).toBe(HASH);
  });

  it('a stale record is only ever posted with its own quote; 409 QUOTE_MISMATCH stops it', async () => {
    const storage = memoryStorage();
    storage.setItem(
      pendingTxKey(SID),
      JSON.stringify({ txHash: HASH, quoteId: 'quo_A', reported: false, state: 'sent' }),
    );
    // The page now shows quote B; the API refuses to bind quote A's hash to it.
    const deposit = vi.fn(async (_h: string, _q: string) => {
      throw new CheckoutApiError(409, 'QUOTE_MISMATCH', 'different quote');
    });
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit,
      sleep: async () => {},
    });
    expect(await reporter.resume()).toBe('refused');
    expect(deposit).toHaveBeenCalledTimes(1);
    expect(deposit).toHaveBeenCalledWith(HASH, 'quo_A');
    // Kept (so it still blocks), never re-posted.
    expect(reporter.pending()).toMatchObject({ txHash: HASH, quoteId: 'quo_A' });
    expect(await reporter.resume()).toBe('reported');
    expect(deposit).toHaveBeenCalledTimes(1);
  });

  it('possibly sent: a signed tx id is posted like a hash; no id is kept as a block only', async () => {
    const storage = memoryStorage();
    const deposit = vi.fn(async (_h: string, _q: string) => ({ submitted: true }));
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit,
      sleep: async () => {},
    });
    await reporter.record({ txHash: 'c'.repeat(64), quoteId: 'quo_1', state: 'uncertain' });
    expect(deposit).toHaveBeenCalledWith('c'.repeat(64), 'quo_1');
    await reporter.record({ txHash: null, quoteId: 'quo_1', state: 'uncertain' });
    expect(loadPendingTx(storage, SID)).toMatchObject({ txHash: null, state: 'uncertain' });
    // A transaction that failed on chain is kept, never reported as a deposit.
    deposit.mockClear();
    await reporter.record({ txHash: 'd'.repeat(64), quoteId: 'quo_1', state: 'failed' });
    expect(deposit).not.toHaveBeenCalled();
    expect(loadPendingTx(storage, SID)).toMatchObject({ txHash: 'd'.repeat(64), state: 'failed' });
  });

  it("the didn't-go-through confirm clears the record and remembers the dismissed server time", async () => {
    const storage = memoryStorage();
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit: async () => ({ submitted: true }),
      sleep: async () => {},
    });
    await reporter.report(HASH, 'quo_1');
    reporter.dismiss('2026-10-26T12:01:00.000Z');
    expect(reporter.pending()).toBeNull();
    expect(loadPendingTx(storage, SID)).toBeNull();
    expect(reporter.dismissed()).toBe('2026-10-26T12:01:00.000Z');
    // Survives a reload.
    const again = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit: async () => ({ submitted: true }),
    });
    expect(again.dismissed()).toBe('2026-10-26T12:01:00.000Z');
  });

  it('works in memory when storage is blocked', async () => {
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => {
        throw new Error('SecurityError');
      },
      deposit: async () => ({ submitted: true }),
      sleep: async () => {},
    });
    expect(await reporter.report(HASH, 'quo_1')).toBe('reported');
    expect(reporter.pending()?.txHash).toBe(HASH);
  });

  it('ignores a malformed stored record', () => {
    const storage = memoryStorage();
    storage.setItem(pendingTxKey(SID), '{"txHash":1}');
    expect(loadPendingTx(storage, SID)).toBeNull();
    storage.setItem(pendingTxKey(SID), 'not json');
    expect(loadPendingTx(storage, SID)).toBeNull();
  });

  it('clear() forgets the hash', async () => {
    const storage = memoryStorage();
    const reporter = createDepositReporter({
      sessionId: SID,
      storage: () => storage,
      deposit: async () => ({ submitted: true }),
      sleep: async () => {},
    });
    await reporter.report(HASH, 'quo_1');
    reporter.clear();
    expect(loadPendingTx(storage, SID)).toBeNull();
    expect(reporter.pending()).toBeNull();
  });
});
