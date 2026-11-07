'use client';

import type { PaymentLinkAvailability, PublicPaymentLinkView } from '@tendr/contracts';
import { PAYER_NOTE_MAX } from '@tendr/contracts';
import { useEffect, useMemo, useState } from 'react';
import { TendrLogo } from '@/components/TendrLogo';
import { toast } from '@/components/toast';
import { payButtonLabel } from '@/components/theme/pay-label';
import { ThemedPage } from '@/components/theme/ThemedPage';
import { themeDisplayName, themeLogoUrl } from '@/lib/checkout/brand';
import { safeHttpUrl } from '@/lib/checkout/format';
import { parseShopperTheme } from '@/lib/theme/parse';
import { themeDataScheme, themeScheme } from '@/lib/theme/vars';
import { useScheme } from '@/lib/theme/use-scheme';
import {
  decimalLess,
  formatLinkAmount,
  parseLinkAmount,
  startLinkPayment,
  usdEquivalent,
  type LinkPayError,
} from '@/lib/payment-links-client';
import './link-pay.css';

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
const LIVE_OFF = 'Live payments are not open yet. Open this link in test mode (?mode=test).';
const ACCOUNT_GAP = "This business isn't ready to take payments yet.";
const NETWORK = "We couldn't reach Tendr. Check your connection and try again.";

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
    case 'LIVE_MODE_UNAVAILABLE':
      return { ...next, message: LIVE_OFF };
    case 'ACCOUNT_NOT_READY':
    case 'UNSUPPORTED_ASSET':
      return { ...next, message: ACCOUNT_GAP };
    case 'NETWORK_ERROR':
      return { ...next, message: NETWORK };
    default:
      return { ...next, message: error.message?.trim() ? error.message : FAILED };
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
 * Same checkout-card chrome as `/demo` (white card, store header, black CTA, Tendr footnote).
 * Still starts a real checkout session via the public payment-links API.
 */
export function LinkPayBody({
  view,
  state,
  continueUrl = null,
  onAmount,
  onNote,
  onSubmit,
}: BodyProps) {
  const theme = useMemo(() => parseShopperTheme(view.theme, view.merchant.name), [view]);
  const preferred = useScheme(theme.document.settings.mode);
  const scheme = themeScheme(theme.document.settings.mode, preferred);
  const dataScheme = themeDataScheme(theme, scheme);
  const [canvasTheme, setCanvasTheme] = useState<'light' | 'dark'>(
    () => (dataScheme === 'dark' ? 'dark' : 'light'),
  );
  useEffect(() => {
    setCanvasTheme(dataScheme === 'dark' ? 'dark' : 'light');
  }, [dataScheme]);
  useEffect(() => {
    if (state.fieldError) toast.error(state.fieldError);
  }, [state.fieldError]);
  useEffect(() => {
    if (state.message) toast.error(state.message);
  }, [state.message]);
  useEffect(() => {
    if (state.tooSmall) toast.error(TOO_SMALL);
  }, [state.tooSmall]);
  const payee = view.merchant.name;
  const brand = themeDisplayName(theme);
  const logo = themeLogoUrl(theme);
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
  const amountText = open
    ? typed?.ok
      ? money(typed.amount, view)
      : null
    : view.amount
      ? money(view.amount, view)
      : null;
  const payLabel = payButtonLabel(
    theme.document.settings.button_label,
    amountText,
    'Pay with crypto',
  );
  const initial = (brand || payee).trim().charAt(0).toUpperCase() || 'T';

  return (
    <ThemedPage theme={theme}>
      <div
        className="demo-pay-page"
        data-theme={canvasTheme}
        data-scheme={dataScheme}
        data-testid="link-pay-page"
      >
        <div className="demo-pay-chrome">
          <button
            type="button"
            className="demo-pay-theme-toggle"
            aria-label={canvasTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            onClick={() => setCanvasTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          >
            {canvasTheme === 'light' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M21 14.3A8.5 8.5 0 0 1 9.7 3 7 7 0 1 0 21 14.3Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.1 5.1l1.6 1.6M17.3 17.3l1.6 1.6M18.9 5.1l-1.6 1.6M6.7 17.3l-1.6 1.6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
        <div
          className="demo-checkout-card demo-checkout-card-in"
          data-testid="link-pay-card"
          role="dialog"
          aria-labelledby="link-title"
        >
          <div className="demo-checkout-card-top">
            <div className="demo-checkout-store">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="demo-checkout-store-logo"
                  src={logo}
                  alt=""
                  width={40}
                  height={40}
                />
              ) : (
                <span
                  className="demo-checkout-store-logo demo-checkout-store-logo-fallback"
                  aria-hidden
                >
                  {initial}
                </span>
              )}
              <div>
                <p className="demo-card-label">
                  Paying {payee}
                  {theme.trading_as && theme.trading_as !== payee
                    ? ` · trading as ${theme.trading_as}`
                    : ''}
                </p>
                <h1 id="link-title" className="demo-checkout-title">
                  {view.title}
                </h1>
              </div>
            </div>
            {!view.livemode ? (
              <p className="demo-pay-test" role="note">
                Test
              </p>
            ) : null}
          </div>

          {!open && view.amount ? (
            <p className="demo-checkout-amount">{money(view.amount, view)}</p>
          ) : null}
          {!open && usd ? <p className="demo-pay-meta">≈ {usd}</p> : null}
          {!open && view.fee_payer === 'shopper' ? (
            <p className="demo-pay-meta">plus fees, shown before you pay</p>
          ) : null}

          {view.description ? <p className="demo-checkout-desc">{view.description}</p> : null}

          {continueUrl ? (
            <div className="demo-pay-continue" role="status">
              <p>You already started paying this link.</p>
              <a className="demo-checkout-primary" href={continueUrl}>
                Continue your payment
              </a>
            </div>
          ) : null}

          {!available ? (
            <p className="demo-pay-alert" role="status">
              {UNAVAILABLE[state.availability]}
            </p>
          ) : (
            <form
              className="demo-pay-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
              }}
            >
              {open ? (
                <label className="demo-pay-field">
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
                  <div id="link-amount-help">
                    {view.min_amount ? (
                      <p className="demo-pay-meta">Minimum {money(view.min_amount, view)}</p>
                    ) : null}
                    {usd ? (
                      <p className="demo-pay-meta" aria-live="polite">
                        ≈ {usd}
                      </p>
                    ) : null}
                  </div>
                </label>
              ) : null}

              {view.note === 'optional' ? (
                <label className="demo-pay-field">
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

              {!state.tooSmall ? (
                <button type="submit" className="demo-checkout-primary" disabled={state.busy}>
                  {state.busy ? <span className="demo-cta-spinner" aria-hidden /> : null}
                  <span className="pay-button-label">{payLabel}</span>
                </button>
              ) : null}
            </form>
          )}

          <p className="demo-checkout-footnote">
            <TendrLogo
              size={22}
              variant="color"
              tone={canvasTheme === 'dark' ? 'white' : 'black'}
            />
            Powered by <strong>Tendr</strong>
          </p>
        </div>
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
