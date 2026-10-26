// Wallet failures, and what the shopper reads about them. A wallet's own error text (RPC errors,
// revert reasons, SDK messages) is never shown: a rejection reads "You cancelled in your wallet",
// a wrong network names the network to switch to, and everything else gets one plain message.

export type WalletErrorKind =
  /** The shopper refused in the wallet (or closed its window). */
  | 'rejected'
  /** The wallet is on another network than the quote, and did not switch. */
  | 'chain_mismatch'
  /** No wallet could be reached here (not installed, or not reachable inside a frame). */
  | 'unavailable'
  /** Anything else BEFORE the wallet signed (including a request that doesn't match the quote). */
  | 'failed'
  /**
   * The wallet signed (returned a signature, tx id or outcome) but we can't tell whether the
   * payment went out: treated as possibly sent, never retried from the pay button (C32).
   */
  | 'uncertain'
  /** The transaction was sent and failed on chain (or the network refused it). Hash kept. */
  | 'onchain_failed'
  /** EVM: the wallet switched accounts since connecting; re-quote for `address`, don't send. */
  | 'account_changed';

export class WalletError extends Error {
  readonly kind: WalletErrorKind;
  /** The network to switch to (chain_mismatch). */
  readonly network?: string;
  /** The transaction's hash or id when the wallet gave one (uncertain, onchain_failed). */
  readonly txHash?: string;
  /** The wallet's current account (account_changed). */
  readonly address?: string;

  constructor(
    kind: WalletErrorKind,
    opts: {
      network?: string;
      txHash?: string;
      address?: string;
      cause?: unknown;
      detail?: string;
    } = {},
  ) {
    super(opts.detail ?? kind);
    this.name = 'WalletError';
    this.kind = kind;
    if (opts.network) this.network = opts.network;
    if (opts.txHash) this.txHash = opts.txHash;
    if (opts.address) this.address = opts.address;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

const REJECTED_CODES = new Set<unknown>([4001, 'ACTION_REJECTED', 'USER_REJECTED', 5000]);
const REJECTED_TEXT = /\b(rejected|denied|declined|cancel+ed)\b|closed the (window|modal|popup)/i;

/** Normalises anything a wallet throws. */
export function toWalletError(err: unknown): WalletError {
  if (err instanceof WalletError) return err;
  const o = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const text = typeof err === 'string' ? err : typeof o.message === 'string' ? o.message : '';
  if (REJECTED_CODES.has(o.code) || REJECTED_TEXT.test(text)) {
    return new WalletError('rejected', { cause: err });
  }
  if (o.cause !== undefined && o.cause !== err) {
    const inner = toWalletError(o.cause);
    if (inner.kind === 'rejected') return inner;
  }
  return new WalletError('failed', { cause: err });
}

/**
 * A throw during or after the wallet's sign-and-send step (C33): a refusal in the wallet is a
 * cancel; anything else may have happened after the transaction went out, so it is "possibly
 * sent", never a plain failure the pay button could retry.
 */
export function afterSignError(err: unknown, txHash?: string): WalletError {
  const e = toWalletError(err);
  if (e.kind === 'rejected') return e;
  if (e.kind === 'uncertain' || e.kind === 'onchain_failed') return e;
  return new WalletError('uncertain', { cause: err, ...(txHash ? { txHash } : {}) });
}

export const CHECK_WALLET_COPY = 'Check your wallet before paying again.';
export const PAYMENT_FAILED_COPY = "Your payment didn't go through in your wallet.";

export const SEND_FAILED_COPY =
  "Your wallet couldn't send this payment. Try again or pay by sending manually.";

/** The one line the shopper reads for a wallet failure. */
export function walletErrorCopy(err: unknown): string {
  const e = toWalletError(err);
  switch (e.kind) {
    case 'rejected':
      return 'You cancelled in your wallet.';
    case 'chain_mismatch':
      return `Switch your wallet to ${e.network ?? 'the right network'} to pay.`;
    case 'uncertain':
      return CHECK_WALLET_COPY;
    case 'onchain_failed':
      return PAYMENT_FAILED_COPY;
    default:
      return SEND_FAILED_COPY;
  }
}
