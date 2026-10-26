// The connected-wallet deposit's transaction hash, kept so it is never lost and never paid twice.
//
// - Saved to sessionStorage (`tendr:tx:<sessionId>`) BEFORE the first POST /deposit, with the
//   quote it paid. A reload finds it, resubmits it, and the page keeps the pay button hidden for
//   that quote instead of asking for a second payment.
// - POST /deposit is retried with backoff on network errors, 5xx and 429. A 4xx refusal (closed
//   session, expired quote) stops the retries; the record stays (the payment may still arrive and
//   the watcher finds it by its deposit address).
// - Blocked storage (private mode, sandboxed frames) falls back to memory: only the reload
//   convenience is lost.
import { CheckoutApiError } from '@/lib/checkout/api';

export interface PendingTx {
  txHash: string;
  quoteId: string;
  /** The API acknowledged it (or refused it for good). */
  reported: boolean;
}

type TxStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const pendingTxKey = (sessionId: string) => `tendr:tx:${sessionId}`;

const HASH = /^[\x21-\x7e]{1,256}$/;

function parse(raw: string | null): PendingTx | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<PendingTx>;
    if (typeof o.txHash !== 'string' || !HASH.test(o.txHash) || typeof o.quoteId !== 'string')
      return null;
    return { txHash: o.txHash, quoteId: o.quoteId, reported: o.reported === true };
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
  /** Saves the hash, then POSTs it (with retries). */
  report(txHash: string, quoteId: string): Promise<ReportOutcome>;
  /** After a reload: POSTs a saved hash that was not acknowledged yet. */
  resume(): Promise<ReportOutcome | null>;
  pending(): PendingTx | null;
  clear(): void;
}

/** 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s: about 3 minutes in all. */
const DEFAULT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

const retryable = (err: unknown) =>
  !(err instanceof CheckoutApiError) || err.status === 0 || err.status === 429 || err.status >= 500;

export function createDepositReporter(opts: {
  sessionId: string;
  /** Reading it may throw when storage is blocked. */
  storage: () => TxStorage | undefined;
  deposit: (txHash: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: number[];
  onChange?: (p: PendingTx | null) => void;
}): DepositReporter {
  const key = pendingTxKey(opts.sessionId);
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
  let inflight: { hash: string; promise: Promise<ReportOutcome> } | null = null;

  const save = (p: PendingTx | null) => {
    current = p;
    withStorage((s) => (p ? s.setItem(key, JSON.stringify(p)) : s.removeItem(key)));
    opts.onChange?.(p);
  };

  const post = async (p: PendingTx): Promise<ReportOutcome> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await opts.deposit(p.txHash);
        if (current?.txHash === p.txHash) save({ ...p, reported: true });
        return 'reported';
      } catch (err) {
        if (!retryable(err)) {
          if (current?.txHash === p.txHash) save({ ...p, reported: true });
          return 'refused';
        }
        const wait = delays[attempt];
        if (wait === undefined) return 'gave_up';
        await sleep(wait);
      }
    }
  };

  const run = (p: PendingTx) => {
    if (inflight?.hash === p.txHash) return inflight.promise;
    const promise = post(p).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { hash: p.txHash, promise };
    return promise;
  };

  return {
    report(txHash, quoteId) {
      if (current?.txHash !== txHash) save({ txHash, quoteId, reported: false });
      if (current!.reported) return Promise.resolve('reported');
      return run(current!);
    },
    async resume() {
      if (!current) return null;
      if (current.reported) return 'reported';
      return run(current);
    },
    pending: () => current,
    clear: () => save(null),
  };
}
