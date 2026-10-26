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
  /** Anything else (including a request that does not match the quote). */
  | 'failed';

export class WalletError extends Error {
  readonly kind: WalletErrorKind;
  /** The network to switch to (chain_mismatch). */
  readonly network?: string;

  constructor(
    kind: WalletErrorKind,
    opts: { network?: string; cause?: unknown; detail?: string } = {},
  ) {
    super(opts.detail ?? kind);
    this.name = 'WalletError';
    this.kind = kind;
    if (opts.network) this.network = opts.network;
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
    default:
      return SEND_FAILED_COPY;
  }
}
