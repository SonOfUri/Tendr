// The connected-wallet payment's record, kept so it is never lost and never paid twice (C32).
//
// - Saved to sessionStorage (`tendr:tx:<sessionId>`) BEFORE the first POST /deposit, with the
//   quote it paid and its state:
//   - `sent`: the wallet returned a hash;
//   - `uncertain`: the wallet signed but we can't tell whether it went out (the hash or signed tx id
//     when there is one, else null);
//   - `failed`: it failed on chain (hash kept, never reported as a deposit).
//   While a record exists the page offers no wallet send and no automatic re-quote (block.ts).
// - POST /deposit always carries the record's OWN quote id, never the page's current one. It is
//   retried with backoff on network errors, 5xx and 429. A 4xx (QUOTE_MISMATCH: the quote was
//   superseded; a closed session; an expired quote) stops it for good; the record stays and keeps
//   blocking. A hash is never re-bound to another quote.
// - `dismiss()` is the shopper's confirmed "My payment didn't go through": the record is cleared
//   and the server's `deposit_submitted_at` it was looking at is remembered (`tendr:tx-dismissed:`)
//   so that one no longer blocks; a newer one would.
// - Blocked storage (private mode, sandboxed frames) falls back to memory.
import { CheckoutApiError } from '@/lib/checkout/api';

export type PendingState = 'sent' | 'uncertain' | 'failed';

export interface PendingTx {
  /** Null when the wallet signed but gave nothing we can report. */
  txHash: string | null;
  quoteId: string;
  /** Nothing more to POST: the API acknowledged or refused it, or there is nothing to report. */
  reported: boolean;
  /** The API accepted this hash: from then on the server's deposit_submitted_at tracks it. */
  acknowledged: boolean;
  state: PendingState;
}

type TxStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const pendingTxKey = (sessionId: string) => `tendr:tx:${sessionId}`;
const dismissedKey = (sessionId: string) => `tendr:tx-dismissed:${sessionId}`;

const HASH = /^[\x21-\x7e]{1,256}$/;
const STATES = new Set<unknown>(['sent', 'uncertain', 'failed']);

function parse(raw: string | null): PendingTx | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<PendingTx>;
    const hashOk = o.txHash === null || (typeof o.txHash === 'string' && HASH.test(o.txHash));
    if (!hashOk || typeof o.quoteId !== 'string' || !o.quoteId) return null;
    const state = STATES.has(o.state) ? (o.state as PendingState) : 'sent';
    return {
      txHash: o.txHash ?? null,
      quoteId: o.quoteId,
      reported: o.reported === true,
      state,
      acknowledged: o.acknowledged === true,
    };
  } catch {
    return null;
  }
}

/** The saved record for `sessionId`, or null. */
export function loadPendingTx(storage: TxStorage, sessionId: string): PendingTx | null {
  try {
    return parse(storage.getItem(pendingTxKey(sessionId)));
  } catch {
    return null;
  }
}

export type ReportOutcome = 'reported' | 'refused' | 'gave_up';

export interface DepositReporter {
  /** A sent payment: saves the hash for `quoteId`, then POSTs it (with retries). */
  report(txHash: string, quoteId: string): Promise<ReportOutcome>;
  /** Any state: saves it; POSTs it when there is a hash and it did not fail on chain. */
  record(r: {
    txHash: string | null;
    quoteId: string;
    state: PendingState;
    /** Save only; reported later (the tx id before its broadcast). A reload still resumes it. */
    persistOnly?: boolean;
    /** A gasless relay: Tendr reported the deposit itself, so it is kept (blocking) but never POSTed. */
    alreadyReported?: boolean;
  }): Promise<ReportOutcome>;
  /** After a reload: POSTs a saved hash that was not acknowledged yet (its own quote only). */
  resume(): Promise<ReportOutcome | null>;
  pending(): PendingTx | null;
  /** Forgets the record (the session is over). */
  clear(): void;
  /** "My payment didn't go through", confirmed: clears and remembers the dismissed server time. */
  dismiss(serverSubmittedAt: string | null): void;
  /** The server `deposit_submitted_at` the shopper dismissed, if any. */
  dismissed(): string | null;
}

/** 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s: about 3 minutes in all. */
const DEFAULT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

const retryable = (err: unknown) =>
  !(err instanceof CheckoutApiError) || err.status === 0 || err.status === 429 || err.status >= 500;

export function createDepositReporter(opts: {
  sessionId: string;
  /** Reading it may throw when storage is blocked. */
  storage: () => TxStorage | undefined;
  /** POST /deposit for exactly this quote. */
  deposit: (txHash: string, quoteId: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: number[];
  onChange?: (p: PendingTx | null) => void;
}): DepositReporter {
  const key = pendingTxKey(opts.sessionId);
  const dKey = dismissedKey(opts.sessionId);
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const withStorage = <T>(fn: (s: TxStorage) => T): T | null => {
    try {
      const s = opts.storage();
      return s ? fn(s) : null;
    } catch {
      return null;
    }
  };

  let current: PendingTx | null = withStorage((s) => parse(s.getItem(key)));
  let dismissedAt: string | null = withStorage((s) => s.getItem(dKey));
  let inflight: { hash: string; promise: Promise<ReportOutcome> } | null = null;

  const save = (p: PendingTx | null) => {
    current = p;
    withStorage((s) => (p ? s.setItem(key, JSON.stringify(p)) : s.removeItem(key)));
    opts.onChange?.(p);
  };
  const same = (p: PendingTx) =>
    current !== null && current.txHash === p.txHash && current.quoteId === p.quoteId;

  const post = async (p: PendingTx & { txHash: string }): Promise<ReportOutcome> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await opts.deposit(p.txHash, p.quoteId);
        if (same(p)) save({ ...current!, reported: true, acknowledged: true });
        return 'reported';
      } catch (err) {
        if (!retryable(err)) {
          // Refused for good (QUOTE_MISMATCH, closed, expired): stop, keep blocking.
          if (same(p)) save({ ...current!, reported: true });
          return 'refused';
        }
        const wait = delays[attempt];
        if (wait === undefined) return 'gave_up';
        await sleep(wait);
      }
    }
  };

  const run = (p: PendingTx): Promise<ReportOutcome> => {
    if (p.reported || p.txHash === null) return Promise.resolve('reported');
    if (inflight?.hash === p.txHash) return inflight.promise;
    const promise = post(p as PendingTx & { txHash: string }).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { hash: p.txHash, promise };
    return promise;
  };

  const record: DepositReporter['record'] = ({
    txHash,
    quoteId,
    state,
    persistOnly,
    alreadyReported,
  }) => {
    if (
      !current ||
      current.txHash !== txHash ||
      current.quoteId !== quoteId ||
      current.state !== state
    ) {
      // A failed-on-chain transaction is kept, never reported as a deposit.
      const reported = txHash === null || state === 'failed' || alreadyReported === true;
      const sameTx = current?.txHash === txHash && current?.quoteId === quoteId;
      save({
        txHash,
        quoteId,
        state,
        reported: sameTx && current!.reported ? true : reported,
        acknowledged: sameTx ? current!.acknowledged : false,
      });
    }
    if (persistOnly) return Promise.resolve('gave_up');
    return run(current!);
  };

  return {
    report: (txHash, quoteId) => record({ txHash, quoteId, state: 'sent' }),
    record,
    async resume() {
      if (!current) return null;
      return run(current);
    },
    pending: () => current,
    clear: () => save(null),
    dismiss(serverSubmittedAt) {
      dismissedAt = serverSubmittedAt;
      withStorage((s) =>
        serverSubmittedAt ? s.setItem(dKey, serverSubmittedAt) : s.removeItem(dKey),
      );
      save(null);
    },
    dismissed: () => dismissedAt,
  };
}
