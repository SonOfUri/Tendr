'use client';

import type { PaymentLinkAvailability, PublicPaymentLinkView } from '@tendr/contracts';
import { PAYER_NOTE_MAX } from '@tendr/contracts';
import { useEffect, useMemo, useState } from 'react';
import { BlockCanvas } from '@/components/theme/BlockCanvas';
import { payButtonLabel } from '@/components/theme/pay-label';
import { WithPayBar } from '@/components/theme/PayBar';
import { ThemedPage } from '@/components/theme/ThemedPage';
import { safeHttpUrl } from '@/lib/checkout/format';
import { parseShopperTheme } from '@/lib/theme/parse';
import { PayeeLine } from '../components/CheckoutHeader';
import {
  decimalLess,
  formatLinkAmount,
  parseLinkAmount,
  startLinkPayment,
  usdEquivalent,
  type LinkPayError,
} from '@/lib/payment-links-client';

const UNAVAILABLE: Record<PaymentLinkAvailability, string> = {
  available: '',
  inactive: "This link isn't taking payments right now",
  archived: "This link isn't taking payments right now",
  used_up: "This link isn't taking payments right now",
  expired: 'This link has expired',
  merchant_not_ready: "This link isn't taking payments yet",
};

const RESERVED = 'Someone is paying this link right now, try again shortly.';
const BUSY = 'Too many people are paying right now. Try again in a minute.';
const NO_PRICES = "Prices can't be loaded right now. Try again in a minute.";
const TOO_SMALL = 'This amount is too small to pay in crypto right now.';
const FAILED = "We couldn't start the payment. Try again.";

/** A payment this tab started from the link: its hosted checkout and when the session expires. */
export interface PendingPayment {
  url: string;
  expires_at: string;
}

/** The sessionStorage key of a link's pending payment: one per store, link and mode. */
export const pendingPaymentKey = (merchant: string, link: string, test: boolean) =>
  `tendr:link-pay:${test ? 'test' : 'live'}:${merchant}/${link}`;

/** This tab's sessionStorage, or null where the browser refuses it (the page works without). */
function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Remembers the session "Pay" created, so a payer who comes back can continue it. */
export function savePendingPayment(
  storage: Storage | null,
  key: string,
  entry: PendingPayment,
): void {
  try {
    storage?.setItem(key, JSON.stringify(entry));
  } catch {
    // Full or blocked storage: no "Continue" action, nothing else changes.
  }
}

/** The tab's unexpired pending payment for this link, or null (an expired one is dropped). */
export function readPendingPayment(
  storage: Storage | null,
  key: string,
  now: number,
): PendingPayment | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingPayment> | null;
    const url = safeHttpUrl(typeof v?.url === 'string' ? v.url : null);
    const expires = typeof v?.expires_at === 'string' ? Date.parse(v.expires_at) : NaN;
    if (url && expires > now) return { url, expires_at: v!.expires_at! };
    storage?.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

/**
 * The page came back from the browser's back/forward cache (`pageshow` with `persisted`), where it
 * was frozen mid-"Pay": `onRestore` re-enables the button. Returns the unsubscribe.
 */
export function onPageRestored(target: EventTarget, onRestore: () => void): () => void {
  const listener = (e: Event) => {
    if ((e as Event & { persisted?: boolean }).persisted) onRestore();
  };
  target.addEventListener('pageshow', listener);
  return () => target.removeEventListener('pageshow', listener);
}

export interface PayState {
  availability: PaymentLinkAvailability;
  amount: string;
  note: string;
  busy: boolean;
  /** Under the amount box (open links). */
  fieldError: string | null;
  /** Above the button. */
  message: string | null;
  /** A fixed price now worth less than the floor: no button. */
  tooSmall: boolean;
}

export function initialPayState(view: PublicPaymentLinkView): PayState {
  return {
    availability: view.availability,
    amount: '',
    note: '',
    busy: false,
    fieldError: null,
    message: null,
    tooSmall: false,
  };
}

/** An amount in the link's currency, with exactly its minor units (from the API). */
const money = (amount: string, view: PublicPaymentLinkView) =>
  formatLinkAmount(amount, view.currency, view.minor_units);

const minimumLine = (min: string, view: PublicPaymentLinkView) =>
  `The minimum is ${money(min, view)}.`;

/** The page after the API refused "Pay". */
export function applyPayError(
  state: PayState,
  view: PublicPaymentLinkView,
  error: LinkPayError,
): PayState {
  const next: PayState = { ...state, busy: false, fieldError: null, message: null };
  const details = (error.details ?? {}) as { availability?: unknown; min_amount?: unknown };
  switch (error.code) {
    case 'LINK_UNAVAILABLE': {
      const a = details.availability;
      const known = typeof a === 'string' && a in UNAVAILABLE && a !== 'available';
      return { ...next, availability: known ? (a as PaymentLinkAvailability) : 'inactive' };
    }
    case 'NOT_FOUND':
      return { ...next, availability: 'inactive' };
    case 'LINK_RESERVED':
      return { ...next, message: RESERVED };
    case 'LINK_BUSY':
    case 'RATE_LIMITED':
      return { ...next, message: BUSY };
    case 'FX_RATE_UNAVAILABLE':
      return { ...next, message: NO_PRICES };
    case 'AMOUNT_TOO_LOW': {
      if (view.amount_type === 'fixed') return { ...next, tooSmall: true };
      const min =
        typeof details.min_amount === 'string' ? details.min_amount : (view.min_amount ?? null);
      return {
        ...next,
        fieldError: min ? minimumLine(min, view) : 'This amount is too small.',
      };
    }
    case 'VALIDATION_ERROR':
      return view.amount_type === 'open'
        ? { ...next, fieldError: 'Enter a valid amount.' }
        : { ...next, message: FAILED };
    default:
      return { ...next, message: FAILED };
  }
}

interface BodyProps {
  view: PublicPaymentLinkView;
  state: PayState;
  /** The hosted checkout of a payment this tab already started from the link, still open. */
  continueUrl?: string | null;
  onAmount: (v: string) => void;
  onNote: (v: string) => void;
  onSubmit: () => void;
}

/**
 * The page itself, from its state (LinkPay owns the state and the request), on the theme's canvas:
 * the link's title and description fill the order summary block, and the sealed payment block
 * holds the payee, the amount (or amount box), the note and the Pay button.
 */
export function LinkPayBody({
  view,
  state,
  continueUrl = null,
  onAmount,
  onNote,
  onSubmit,
}: BodyProps) {
  // A theme that doesn't parse is the Tendr default look; the link still takes payments.
  const theme = useMemo(() => parseShopperTheme(view.theme, view.merchant.name), [view]);
  const payee = view.merchant.name;
  const open = view.amount_type === 'open';
  const typed = open ? parseLinkAmount(state.amount, view.minor_units) : null;
  const usd = open
    ? typed?.ok
      ? usdEquivalent(typed.amount, view.currency, view.usd_rate)
      : null
    : view.amount
      ? usdEquivalent(view.amount, view.currency, view.usd_rate)
      : null;
  const available = state.availability === 'available';
  // The amount as the page shows it: the fixed price, or a valid typed amount (else none yet).
  const amountText = open
    ? typed?.ok
      ? money(typed.amount, view)
      : null
    : view.amount
      ? money(view.amount, view)
      : null;
  // The theme's button words (R22), `{amount}` filled with Tendr's formatted amount.
  const payLabel = payButtonLabel(
    theme.document.settings.button_label,
    amountText,
    'Pay with crypto',
  );

  const summary = (
    <div className="pay-section">
      <h1 id="link-title" className="pay-title">
        {view.title}
      </h1>
      {view.description ? <p className="pay-link-description">{view.description}</p> : null}
    </div>
  );

  const sealed = (
    <>
      <header className="pay-header">
        <PayeeLine payee={payee} tradingAs={theme.trading_as} />
        {!view.livemode ? (
          <p className="pay-test-banner small" role="note">
            Test mode — no real money moves
          </p>
        ) : null}
      </header>

      <section className="pay-section" aria-label="Payment">
        {continueUrl ? (
          <div className="pay-link-continue" role="status">
            <p className="small">You already started paying this link.</p>
            <a className="pay-button" href={continueUrl}>
              Continue your payment
            </a>
          </div>
        ) : null}

        {!available ? (
          <p className="pay-alert" role="status">
            {UNAVAILABLE[state.availability]}
          </p>
        ) : (
          <form
            className="form pay-link-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {open ? (
              <div className="pay-link-amount">
                <label className="field">
                  <span>Amount ({view.currency})</span>
                  <input
                    name="amount"
                    inputMode={view.minor_units === 0 ? 'numeric' : 'decimal'}
                    autoComplete="off"
                    placeholder="0"
                    value={state.amount}
                    onChange={(e) => onAmount(e.target.value)}
                    aria-invalid={state.fieldError ? true : undefined}
                    aria-describedby="link-amount-help"
                  />
                </label>
                <div id="link-amount-help">
                  {state.fieldError ? (
                    <p className="pay-error small" role="alert">
                      {state.fieldError}
                    </p>
                  ) : null}
                  {view.min_amount ? (
                    <p className="muted small">Minimum {money(view.min_amount, view)}</p>
                  ) : null}
                  {usd ? (
                    <p className="muted small" aria-live="polite">
                      ≈ {usd}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="pay-link-price">
                <strong className="pay-total">
                  {view.amount ? money(view.amount, view) : null}
                </strong>
                {usd ? <span className="muted"> ≈ {usd}</span> : null}
              </p>
            )}
            {view.fee_payer === 'shopper' ? (
              <p className="muted small">plus fees, shown before you pay</p>
            ) : null}

            {view.note === 'optional' ? (
              <label className="field">
                <span>Note to {payee} (optional)</span>
                <input
                  name="note"
                  maxLength={PAYER_NOTE_MAX}
                  autoComplete="off"
                  value={state.note}
                  onChange={(e) => onNote(e.target.value)}
                />
              </label>
            ) : null}

            {state.tooSmall ? (
              <p className="pay-error small" role="alert">
                {TOO_SMALL}
              </p>
            ) : (
              <>
                {state.message ? (
                  <p className="pay-error small" role="alert">
                    {state.message}
                  </p>
                ) : null}
                <button type="submit" className="pay-button" disabled={state.busy}>
                  <span className="pay-button-label">
                    {state.busy ? <span className="pay-button-spinner" aria-hidden /> : null}
                    {payLabel}
                  </span>
                </button>
              </>
            )}
          </form>
        )}
      </section>
    </>
  );

  return (
    <ThemedPage theme={theme}>
      <div className="pay-card">
        <WithPayBar
          amount={amountText ?? 'Choose an amount'}
          payee={payee}
          enabled={available && !state.tooSmall}
        >
          <BlockCanvas
            blocks={theme.document.blocks}
            theme={theme}
            slots={{ payment: sealed, orderSummary: summary }}
          />
        </WithPayBar>
      </div>
    </ThemedPage>
  );
}

/**
 * The payer's link page (client part). Nothing is created until "Pay": then a checkout session,
 * and the browser goes to the hosted checkout (`/pay/<session>#cs=…`).
 */
export function LinkPay({
  view,
  merchant,
  link,
  test,
}: {
  view: PublicPaymentLinkView;
  merchant: string;
  link: string;
  test: boolean;
}) {
  const [state, setState] = useState<PayState>(() => initialPayState(view));
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const key = pendingPaymentKey(merchant, link, test);

  useEffect(() => {
    // After mount only: the server render has no sessionStorage.
    const load = () => setPending(readPendingPayment(tabStorage(), key, Date.now()));
    load();
    // Back from the checkout through the back/forward cache: the page was frozen with "Pay" busy.
    return onPageRestored(window, () => {
      setState((s) => ({ ...s, busy: false }));
      load();
    });
  }, [key]);

  const submit = async () => {
    if (state.busy) return;
    const body: { amount?: string; note?: string } = {};
    if (view.amount_type === 'open') {
      const parsed = parseLinkAmount(state.amount, view.minor_units);
      if (!parsed.ok) {
        setState((s) => ({ ...s, fieldError: parsed.error, message: null }));
        return;
      }
      if (view.min_amount && decimalLess(parsed.amount, view.min_amount)) {
        setState((s) => ({
          ...s,
          fieldError: minimumLine(view.min_amount!, view),
          message: null,
        }));
        return;
      }
      body.amount = parsed.amount;
    }
    if (view.note === 'optional' && state.note.trim()) body.note = state.note;
    setState((s) => ({ ...s, busy: true, fieldError: null, message: null }));
    const out = await startLinkPayment(merchant, link, test, body);
    if ('url' in out) {
      if (out.expires_at) {
        savePendingPayment(tabStorage(), key, { url: out.url, expires_at: out.expires_at });
      }
      window.location.assign(out.url);
      return;
    }
    setState((s) => applyPayError(s, view, out.error));
  };

  return (
    <LinkPayBody
      view={view}
      state={state}
      continueUrl={pending?.url ?? null}
      onAmount={(amount) => setState((s) => ({ ...s, amount, fieldError: null }))}
      onNote={(note) => setState((s) => ({ ...s, note }))}
      onSubmit={() => void submit()}
    />
  );
}
