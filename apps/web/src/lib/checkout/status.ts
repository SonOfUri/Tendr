// Maps the API's session view to the screen the shopper sees. Session status leads; the latest
// payment's shopper-facing state refines PROCESSING. Anything unknown (a new status, a missing
// field) maps to the safe "Checking your payment…" screen and never throws.
import type { SessionPayment, SessionRefund, SessionView } from './api';
import type { BridgeStatus } from './embed-bridge';

export type ScreenKind =
  /** Choose a token, see the quote, send. */
  | 'pay'
  /** Underpaid while the quote is live: "Send the remaining X to the same address". */
  | 'topup'
  /** Underpaid, being returned. */
  | 'underpaid'
  | 'detected'
  | 'converting'
  | 'complete'
  /** Arrived after the checkout expired; being returned. */
  | 'late'
  | 'refunded'
  /** "We couldn't complete this payment." */
  | 'held'
  | 'expired'
  /** Unknown state: "Checking your payment…". */
  | 'checking';

/** Something the shopper must do, shown with the screen. */
export type ScreenAction = 'email' | 'needs_address' | null;

export interface ScreenState {
  kind: ScreenKind;
  /** Stop polling: nothing more will change that the shopper is waiting on. */
  terminal: boolean;
  /** What the embed bridge reports (null: nothing). */
  bridgeStatus: BridgeStatus | null;
  action: ScreenAction;
  /** A pay screen after an earlier attempt was returned. */
  notice: 'previous_returned' | null;
  /** The latest payment, if any. */
  payment: SessionPayment | null;
  /** The return waiting for the shopper's address, if any. */
  refundNeedingAddress: SessionRefund | null;
}

const BRIDGE: Record<ScreenKind, BridgeStatus | null> = {
  pay: 'pending',
  topup: 'detected',
  underpaid: 'refunded',
  detected: 'detected',
  converting: 'converting',
  complete: 'settled',
  late: 'expired',
  refunded: 'refunded',
  held: 'held',
  expired: 'expired',
  checking: null,
};

const TERMINAL_KINDS: ReadonlySet<ScreenKind> = new Set([
  'complete',
  'refunded',
  'held',
  'expired',
]);

/** Terminal session statuses: a refunding payment inside PROCESSING is still moving. */
const TERMINAL_SESSION = new Set(['SETTLED', 'REFUNDED', 'HELD', 'EXPIRED']);

function processingKind(p: SessionPayment | null, hasTopup: boolean): ScreenKind {
  switch (p?.state) {
    case 'detected':
      return 'detected';
    case 'converting':
    case 'processing':
      return 'converting';
    case 'underpaid':
      return hasTopup ? 'topup' : 'underpaid';
    case 'refunding':
    case 'refunded':
      return 'refunded';
    case 'held':
      return 'held';
    case 'late':
      return 'late';
    case 'settled':
      return 'complete';
    default:
      return 'checking';
  }
}

function kindOf(v: SessionView, latest: SessionPayment | null, now: Date): ScreenKind {
  switch (v.status) {
    case 'PENDING_DEPOSIT': {
      const expires = Date.parse(v.expires_at);
      if (!latest && Number.isFinite(expires) && expires <= now.getTime()) return 'expired';
      return 'pay';
    }
    case 'PROCESSING':
    case 'SCREENING_PENDING':
      return processingKind(latest, !!v.topup);
    case 'SETTLED':
      return 'complete';
    case 'REFUNDED':
      return 'refunded';
    case 'EXPIRED':
      return 'expired';
    case 'LATE_DEPOSIT':
      return 'late';
    case 'HELD':
      return 'held';
    default:
      return 'checking';
  }
}

export function screenFor(v: SessionView, now: Date): ScreenState {
  const payments = Array.isArray(v?.payments) ? v.payments : [];
  const refunds = Array.isArray(v?.refunds) ? v.refunds : [];
  const latest = payments.at(-1) ?? null;
  let kind: ScreenKind;
  try {
    kind = kindOf(v, latest, now);
  } catch {
    kind = 'checking';
  }
  const refundNeedingAddress = refunds.find((r) => r?.needs_address === true) ?? null;
  // An email first (the address link is mailed to it), then the address itself.
  const action: ScreenAction =
    v?.needs_email === true ? 'email' : refundNeedingAddress ? 'needs_address' : null;
  const notice =
    kind === 'pay' && (latest?.state === 'refunded' || latest?.state === 'refunding')
      ? 'previous_returned'
      : null;
  const terminal =
    TERMINAL_KINDS.has(kind) &&
    (kind === 'expired' || TERMINAL_SESSION.has(v.status)) &&
    action === null;
  return {
    kind,
    terminal,
    bridgeStatus: BRIDGE[kind],
    action,
    notice,
    payment: latest,
    refundNeedingAddress,
  };
}
