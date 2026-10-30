'use client';

import type { PaymentLinkAvailability, PublicPaymentLinkView } from '@tendr/contracts';
import { PAYER_NOTE_MAX } from '@tendr/contracts';
import { useState } from 'react';
import { safeHttpUrl } from '@/lib/checkout/format';
import {
  decimalLess,
  formatLinkAmount,
  fractionDigits,
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

const minimumLine = (min: string, currency: string) =>
  `The minimum is ${formatLinkAmount(min, currency)}.`;

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
        fieldError: min ? minimumLine(min, view.currency) : 'This amount is too small.',
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
  onAmount: (v: string) => void;
  onNote: (v: string) => void;
  onSubmit: () => void;
}

/** The page itself, from its state (LinkPay owns the state and the request). */
export function LinkPayBody({ view, state, onAmount, onNote, onSubmit }: BodyProps) {
  const logo = view.merchant.logo_url?.startsWith('https://')
    ? safeHttpUrl(view.merchant.logo_url)
    : null;
  const open = view.amount_type === 'open';
  const typed = open ? parseLinkAmount(state.amount, view.currency) : null;
  const usd = open
    ? typed?.ok
      ? usdEquivalent(typed.amount, view.currency, view.usd_rate)
      : null
    : view.amount
      ? usdEquivalent(view.amount, view.currency, view.usd_rate)
      : null;
  const available = state.availability === 'available';

  return (
    <div className="pay-card">
      <header className="pay-header">
        <div className="pay-store">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- the store's own logo, any host
            <img src={logo} alt="" width={28} height={28} className="pay-logo" />
          ) : null}
          <span className="pay-store-name">{view.merchant.name}</span>
        </div>
        {!view.livemode ? (
          <p className="pay-test-banner small" role="note">
            Test mode — no real money moves
          </p>
        ) : null}
      </header>

      <section className="pay-section" aria-labelledby="link-title">
        <h1 id="link-title" className="pay-title">
          {view.title}
        </h1>
        {view.description ? <p className="pay-link-description">{view.description}</p> : null}

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
                    inputMode={fractionDigits(view.currency) === 0 ? 'numeric' : 'decimal'}
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
                    <p className="muted small">
                      Minimum {formatLinkAmount(view.min_amount, view.currency)}
                    </p>
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
                  {view.amount ? formatLinkAmount(view.amount, view.currency) : null}
                </strong>
                {usd ? <span className="muted"> ≈ {usd}</span> : null}
              </p>
            )}
            {view.fee_payer === 'shopper' ? (
              <p className="muted small">plus fees, shown before you pay</p>
            ) : null}

            {view.note === 'optional' ? (
              <label className="field">
                <span>Note to {view.merchant.name} (optional)</span>
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
                  {state.busy ? (
                    <span className="pay-button-label">
                      <span className="pay-button-spinner" aria-hidden />
                      Pay with crypto
                    </span>
                  ) : (
                    'Pay with crypto'
                  )}
                </button>
              </>
            )}
          </form>
        )}
      </section>
    </div>
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

  const submit = async () => {
    if (state.busy) return;
    const body: { amount?: string; note?: string } = {};
    if (view.amount_type === 'open') {
      const parsed = parseLinkAmount(state.amount, view.currency);
      if (!parsed.ok) {
        setState((s) => ({ ...s, fieldError: parsed.error, message: null }));
        return;
      }
      if (view.min_amount && decimalLess(parsed.amount, view.min_amount)) {
        setState((s) => ({
          ...s,
          fieldError: minimumLine(view.min_amount!, view.currency),
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
      window.location.assign(out.url);
      return;
    }
    setState((s) => applyPayError(s, view, out.error));
  };

  return (
    <LinkPayBody
      view={view}
      state={state}
      onAmount={(amount) => setState((s) => ({ ...s, amount, fieldError: null }))}
      onNote={(note) => setState((s) => ({ ...s, note }))}
      onSubmit={() => void submit()}
    />
  );
}
