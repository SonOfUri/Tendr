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
import { toWalletError } from './errors';
import type { PendingState } from './tx-store';
import { mustRequoteBeforeSend } from './block';
import type { WalletAdapter } from './index';

/** What a wallet send produced: a hash, or "possibly sent" / "failed" after the wallet signed. */
export interface WalletSendResult {
  txHash: string | null;
  /** The quote this payment was for (bound before the wallet opened). */
  quoteId: string;
  state: PendingState;
  /** Save it, but don't report it yet (the tx id before its broadcast). */
  persistOnly?: boolean;
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
