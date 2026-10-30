// One wallet payment, start to finish, without UI (WalletPanel.tsx renders the outcome):
//
// 1. The quote id is bound before anything else: a re-quote while the wallet is open never
//    changes what is recorded.
// 2. A price within 15 s of its deadline (or past it) is renewed first; the wallet is not opened.
// 3. The session is re-fetched (`checkBeforeSend`): another tab's deposit aborts into the block.
// 4. The wallet signs and sends. An adapter that learns the tx id before broadcasting (Tron)
//    calls `onSigned`, which records the payment as possibly sent (persisted, not yet reported)
//    so a reload during the broadcast still blocks a second payment.
// 5. Success records it as sent (and reports it). After the wallet signed, a failure is recorded
//    as possibly sent or failed on chain (C32/C33), never offered as a plain retry.
import { CheckoutApiError } from '@/lib/checkout/api';
import { toWalletError } from './errors';
import type { PendingState } from './tx-store';
import { mustRequoteBeforeSend } from './block';
import type { WalletAdapter } from './index';
import {
  GaslessExpiredError,
  GaslessMismatchError,
  assertPrepareMatches,
  type GaslessApi,
  type GaslessExpectation,
  type GaslessSigner,
  type PreparePayload,
  type SignResult,
  type SubmissionView,
} from './gasless/index';

/** What a wallet send produced: a hash, or "possibly sent" / "failed" after the wallet signed. */
export interface WalletSendResult {
  txHash: string | null;
  /** The quote this payment was for (bound before the wallet opened). */
  quoteId: string;
  state: PendingState;
  /** Save it, but don't report it yet (the tx id before its broadcast). */
  persistOnly?: boolean;
  /** A gasless relay: Tendr itself already reported this deposit; never POST it again. */
  alreadyReported?: boolean;
}

export type PayStep =
  | { kind: 'sent' }
  | { kind: 'recorded' }
  | { kind: 'requote' }
  | { kind: 'blocked' }
  | { kind: 'check_failed' }
  | { kind: 'account_changed'; address: string }
  | { kind: 'error'; error: unknown };

export async function runWalletPay(o: {
  quote: {
    id: string;
    deadline: string;
    deposit_address: string;
    amount_in: string;
    origin_asset: string;
  };
  decimals: number;
  now: () => number;
  adapter: WalletAdapter;
  /** Re-fetches the session: 'blocked' when a deposit was reported meanwhile (another tab). */
  checkBeforeSend?: () => Promise<'ok' | 'blocked' | 'error'>;
  record: (r: WalletSendResult) => void;
}): Promise<PayStep> {
  const quoteId = o.quote.id;
  if (mustRequoteBeforeSend(o.quote.deadline, o.now())) return { kind: 'requote' };
  if (o.checkBeforeSend) {
    let check: 'ok' | 'blocked' | 'error';
    try {
      check = await o.checkBeforeSend();
    } catch {
      check = 'error';
    }
    if (check === 'blocked') return { kind: 'blocked' };
    if (check === 'error') return { kind: 'check_failed' };
    // The check took time: the price may have run out meanwhile.
    if (mustRequoteBeforeSend(o.quote.deadline, o.now())) return { kind: 'requote' };
  }
  try {
    const { txHash } = await o.adapter.sendDeposit(
      {
        depositAddress: o.quote.deposit_address,
        assetId: o.quote.origin_asset,
        amount: o.quote.amount_in,
        decimals: o.decimals,
      },
      {
        onSigned: (txId) =>
          o.record({ txHash: txId, quoteId, state: 'uncertain', persistOnly: true }),
      },
    );
    o.record({ txHash, quoteId, state: 'sent' });
    return { kind: 'sent' };
  } catch (err) {
    const e = toWalletError(err);
    if (e.kind === 'uncertain' || e.kind === 'onchain_failed') {
      o.record({
        txHash: e.txHash ?? null,
        quoteId,
        state: e.kind === 'uncertain' ? 'uncertain' : 'failed',
      });
      return { kind: 'recorded' };
    }
    if (e.kind === 'account_changed' && e.address) {
      return { kind: 'account_changed', address: e.address };
    }
    return { kind: 'error', error: err };
  }
}

// ---------------------------------------------------------------------------------------------
// Gasless (project 5a): the wallet signs, Tendr relays. Payment is still only ever confirmed by
// the session status (the watcher); a relay outcome only decides what the shopper sees now.
//
// 1. Same guards as a wallet send: a price near its deadline is renewed, the session re-checked.
// 2. `gasless/prepare` → the payload is checked against the quote (here and in the family signer)
//    BEFORE the wallet is asked; a mismatch is never signed.
// 3. The signed payload goes to `gasless/submit`, then `gasless/submissions/:id` is polled until
//    the API reports confirmed or failed (Tron: the approve first, then the payment).
// 4. Confirmed → recorded as sent (Tendr already reported the deposit: never POSTed again).
//    Failed → nothing recorded, nothing moved; the shopper may try again. Still unresolved after
//    the wait → recorded as possibly sent (C32), never a plain retry.
// API codes (ruling T10-d): QUOTE_EXPIRED / QUOTE_PRICE_MOVED / SPONSORSHIP_RELEASED → re-quote;
// GASLESS_NOT_AVAILABLE → re-quote without gasless; GASLESS_EXPIRED → prepare and sign again;
// CONFLICT (an earlier attempt may still land) → poll that attempt, never sign a second one;
// 503 / no connection → a retry button.
// ---------------------------------------------------------------------------------------------

export type GaslessPayStep =
  | { kind: 'sent' }
  | { kind: 'recorded' }
  /** Get a new price; `gasless: false` → this wallet pays the fee in the chain's coin. */
  | { kind: 'requote'; gasless: boolean }
  /** The signature's window ran out twice: ask the shopper to sign again. */
  | { kind: 'sign_again' }
  /** The payload did not match the quote: nothing was signed (or relayed). */
  | { kind: 'mismatch' }
  /** The API refused the signed payload as not matching the quote: nothing was relayed. */
  | { kind: 'refused_signed' }
  /** The relay failed or was refused: nothing moved. */
  | { kind: 'relay_failed'; reason: string | null }
  | { kind: 'retry' }
  | { kind: 'rate_limited' }
  /** An earlier attempt is still being confirmed. */
  | { kind: 'still_confirming' }
  | { kind: 'blocked' }
  | { kind: 'check_failed' }
  | { kind: 'account_changed'; address: string }
  | { kind: 'error'; error: unknown };

export type GaslessProgress = 'preparing' | 'signing' | 'confirming' | 'previous_attempt';

const REQUOTE_CODES = new Set(['QUOTE_EXPIRED', 'QUOTE_PRICE_MOVED', 'SPONSORSHIP_RELEASED']);

function apiStep(err: unknown): GaslessPayStep {
  if (!(err instanceof CheckoutApiError)) return { kind: 'error', error: err };
  if (REQUOTE_CODES.has(err.code)) return { kind: 'requote', gasless: true };
  switch (err.code) {
    case 'GASLESS_NOT_AVAILABLE':
      return { kind: 'requote', gasless: false };
    case 'GASLESS_EXPIRED':
      return { kind: 'sign_again' };
    case 'GASLESS_PAYLOAD_MISMATCH':
      // Tendr refused what the wallet signed (m5): nothing was relayed.
      return { kind: 'refused_signed' };
    case 'GASLESS_SUBMIT_FAILED': {
      const reason = (err.details as { reason?: unknown } | undefined)?.reason;
      return { kind: 'relay_failed', reason: typeof reason === 'string' ? reason : null };
    }
    case 'CONFLICT':
      return { kind: 'still_confirming' };
  }
  if (err.code === 'RATE_LIMITED' || err.status === 429) return { kind: 'rate_limited' };
  if (err.status === 0 || err.status >= 500) return { kind: 'retry' };
  return { kind: 'error', error: err };
}

export async function runGaslessPay(o: {
  quote: { id: string; deadline: string };
  /** What every payload must bind (gasless/index.ts `expectationFor`). */
  expect: GaslessExpectation;
  api: GaslessApi;
  signer: GaslessSigner;
  now: () => number;
  checkBeforeSend?: () => Promise<'ok' | 'blocked' | 'error'>;
  record: (r: WalletSendResult) => void;
  onProgress?: (p: GaslessProgress) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How often a submission is polled (default 2 s) and for how long (default 2 min). */
  pollMs?: number;
  pollTimeoutMs?: number;
}): Promise<GaslessPayStep> {
  const quoteId = o.quote.id;
  if (mustRequoteBeforeSend(o.quote.deadline, o.now())) return { kind: 'requote', gasless: true };
  if (o.checkBeforeSend) {
    let check: 'ok' | 'blocked' | 'error';
    try {
      check = await o.checkBeforeSend();
    } catch {
      check = 'error';
    }
    if (check === 'blocked') return { kind: 'blocked' };
    if (check === 'error') return { kind: 'check_failed' };
    if (mustRequoteBeforeSend(o.quote.deadline, o.now())) return { kind: 'requote', gasless: true };
  }
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 2000;
  const pollTimeoutMs = o.pollTimeoutMs ?? 120_000;
  const record = (txHash: string | null, state: PendingState): GaslessPayStep => {
    o.record({ txHash, quoteId, state, alreadyReported: true });
    return { kind: state === 'sent' ? 'sent' : 'recorded' };
  };

  /** Polls a submission until the API reports its outcome, or the wait runs out. */
  const poll = async (id: string): Promise<SubmissionView | null> => {
    const until = o.now() + pollTimeoutMs;
    let last: SubmissionView | null = null;
    for (;;) {
      try {
        last = await o.api.gaslessSubmission(id);
        if (last.status === 'confirmed' || last.status === 'failed') return last;
      } catch (err) {
        // A dropped connection keeps waiting; anything else ends the wait.
        if (!(err instanceof CheckoutApiError) || (err.status !== 0 && err.status < 500)) {
          return last;
        }
      }
      if (o.now() >= until) return last;
      await sleep(pollMs);
    }
  };

  /** A payment submission's outcome as the step the shopper sees. */
  const outcome = (v: SubmissionView | null, fallbackHash: string | null): GaslessPayStep => {
    if (v?.status === 'confirmed') return record(v.tx_hash ?? fallbackHash, 'sent');
    if (v?.status === 'failed') return { kind: 'relay_failed', reason: null };
    return record(v?.tx_hash ?? fallbackHash, 'uncertain');
  };

  let localExpired = 0;
  let serverExpired = 0;
  // Each round prepares once; Tron's approve and a re-prepare after expiry take extra rounds.
  for (let round = 0; round < 6; round++) {
    o.onProgress?.('preparing');
    let p: PreparePayload;
    try {
      p = await o.api.gaslessPrepare({ quote_id: quoteId });
    } catch (err) {
      if (!(err instanceof CheckoutApiError) || err.code !== 'CONFLICT') return apiStep(err);
      // An earlier attempt for this quote can still land: wait for it, never sign a second one.
      o.onProgress?.('previous_attempt');
      const d = (err.details ?? {}) as { submission_id?: unknown; step?: unknown };
      if (typeof d.submission_id !== 'string') return { kind: 'still_confirming' };
      const v = await poll(d.submission_id);
      if (d.step === 'approve' || d.submission_id.startsWith('tap_')) {
        // Tron: the approve is not the payment. Confirmed (or failed) → prepare what comes next.
        if (v?.status === 'confirmed' || v?.status === 'failed') continue;
        return { kind: 'still_confirming' };
      }
      if (v?.status === 'failed') continue;
      return outcome(v, null);
    }
    try {
      assertPrepareMatches(p, o.expect);
    } catch (err) {
      if (err instanceof GaslessMismatchError) return { kind: 'mismatch' };
      throw err;
    }

    o.onProgress?.('signing');
    let r: SignResult;
    try {
      r = await o.signer.sign(p, o.expect);
    } catch (err) {
      if (err instanceof GaslessMismatchError) return { kind: 'mismatch' };
      if (err instanceof GaslessExpiredError) {
        if (localExpired++ < 2) continue;
        return { kind: 'sign_again' };
      }
      const e = toWalletError(err);
      if (e.kind === 'account_changed' && e.address) {
        return { kind: 'account_changed', address: e.address };
      }
      // A smart wallet's batch that reverted moved nothing (it is atomic).
      if (e.kind === 'onchain_failed') return { kind: 'relay_failed', reason: null };
      if (e.kind === 'uncertain') return record(e.txHash ?? null, 'uncertain');
      return { kind: 'error', error: err };
    }
    if (r.kind === 'wallet_sent') return record(r.txHash, r.state);

    let s;
    try {
      s = await o.api.gaslessSubmit({ quote_id: quoteId, ...r.body });
    } catch (err) {
      if (
        err instanceof CheckoutApiError &&
        err.code === 'GASLESS_EXPIRED' &&
        serverExpired++ < 1
      ) {
        continue;
      }
      return apiStep(err);
    }
    o.onProgress?.('confirming');
    const v: SubmissionView | null =
      s.status === 'confirmed' || s.status === 'failed'
        ? { id: s.submission_id, quote_id: quoteId, status: s.status, tx_hash: s.tx_hash }
        : await poll(s.submission_id);
    if (p.step === 'approve') {
      if (v?.status === 'confirmed') continue;
      if (v?.status === 'failed') return { kind: 'relay_failed', reason: null };
      return { kind: 'still_confirming' };
    }
    return outcome(v, s.tx_hash);
  }
  return { kind: 'still_confirming' };
}
