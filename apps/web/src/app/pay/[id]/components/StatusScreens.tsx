'use client';

import type { CheckoutClient, SessionPayment, SessionView, Token } from '@/lib/checkout/api';
import { explorerTxUrl, formatUnits, networkName, safeHttpUrl } from '@/lib/checkout/format';
import { extraPaidNotice } from '@/lib/checkout/returns';
import type { ScreenState } from '@/lib/checkout/status';
import { Countdown } from './Countdown';
import { SendDetails } from './SendDetails';
import { TestModePanel } from './TestModePanel';

interface Props {
  view: SessionView;
  screen: ScreenState;
  /** Looks up a token by asset id (null when unknown or the list is unavailable). */
  tokenOf: (assetId: string) => Token | null;
  client: CheckoutClient;
  now: number;
  onRefresh: () => void;
  /**
   * The complete screen's own way back. Off when the theme's thank-you page has a back-to-store
   * block, which draws it instead (one link, not two).
   */
  showBackLink?: boolean;
}

/** A link back to the store; inside a frame it navigates the store's page, not the frame. */
export function StoreLink({ href, children }: { href: string | null; children: string }) {
  const url = safeHttpUrl(href);
  if (!url) return null;
  return (
    <a className="pay-button" href={url} target="_top" rel="noopener">
      {children}
    </a>
  );
}

/**
 * Back to where the shopper came from: the payment link page ("Back to <title>") for a session
 * made from a link, else the store's success or cancel page ("Return to store"). `label` is the
 * theme's back-to-store wording, when it sets one.
 */
export function BackLink({
  view,
  to,
  label,
}: {
  view: SessionView;
  to: 'success' | 'cancel';
  label?: string;
}) {
  const link = view.payment_link;
  if (link) return <StoreLink href={link.url}>{label || `Back to ${link.title}`}</StoreLink>;
  return (
    <StoreLink href={to === 'success' ? view.success_url : view.cancel_url}>
      {label || 'Return to store'}
    </StoreLink>
  );
}

function paidAmount(view: SessionView, payment: SessionPayment | null, token: Token | null) {
  if (!token) return null;
  const received = payment?.amount_received
    ? formatUnits(payment.amount_received, token.decimals)
    : null;
  const quoted = view.quote ? formatUnits(view.quote.amount_in, token.decimals) : null;
  const amount = received && received !== '0' ? received : quoted;
  return amount ? `${amount} ${token.symbol}` : null;
}

function returnsOf(view: SessionView, payment: SessionPayment | null) {
  const refunds = Array.isArray(view.refunds) ? view.refunds : [];
  return payment ? refunds.filter((r) => r.payment_id === payment.id) : refunds;
}

function TxLink({
  view,
  payment,
  token,
}: {
  view: SessionView;
  payment: SessionPayment | null;
  token: Token | null;
}) {
  const hash = payment?.origin_tx_hash;
  if (!hash) return null;
  const href = view.livemode && token ? explorerTxUrl(token.blockchain, hash) : null;
  const short = hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
  return (
    <div>
      <dt>Transaction</dt>
      <dd>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="address">
            {short} ↗<span className="sr-only"> (opens a block explorer)</span>
          </a>
        ) : (
          <span className="address">{short}</span>
        )}
      </dd>
    </div>
  );
}

export function ProgressScreen({ kind }: { kind: 'detected' | 'converting' }) {
  const steps = [
    { label: 'Payment detected', state: 'done' },
    { label: 'Converting', state: kind === 'converting' ? 'current' : 'todo' },
    { label: 'Settled', state: 'todo' },
  ] as const;
  return (
    <section className="pay-section" aria-labelledby="pay-progress-title">
      <h2 id="pay-progress-title">We&apos;ve got your payment</h2>
      <ol className="pay-steps">
        {steps.map((s) => (
          <li
            key={s.label}
            data-state={s.state}
            aria-current={s.state === 'current' ? 'step' : undefined}
          >
            <span aria-hidden>{s.state === 'done' ? '✓' : s.state === 'current' ? '◌' : '○'}</span>{' '}
            {s.label}
            {s.state === 'current' ? '…' : ''}
            <span className="sr-only">
              {s.state === 'done' ? ' (done)' : s.state === 'todo' ? ' (next)' : ' (in progress)'}
            </span>
          </li>
        ))}
      </ol>
      <p className="muted small">
        This usually takes a minute or two. You can close this page; the store will confirm your
        order.
      </p>
    </section>
  );
}

export function StatusScreen({
  view,
  screen,
  tokenOf,
  client,
  now,
  onRefresh,
  showBackLink = true,
}: Props) {
  const payment = screen.payment;
  const token = view.quote ? tokenOf(view.quote.origin_asset) : null;
  const returns = returnsOf(view, payment);
  const sent = returns.some((r) => r.state === 'sent');

  switch (screen.kind) {
    case 'detected':
    case 'converting':
      return <ProgressScreen kind={screen.kind} />;

    case 'complete': {
      const paid = paidAmount(view, payment, token);
      // Kept is said only when nothing of this payment is being returned (C41).
      const notice = payment ? extraPaidNotice(payment, returns) : null;
      return (
        <section className="pay-section" aria-labelledby="pay-done-title">
          <h2 id="pay-done-title" className="pay-success">
            ✓ Payment complete
          </h2>
          <dl className="pay-kv">
            {paid ? (
              <div>
                <dt>Paid</dt>
                <dd>{paid}</dd>
              </div>
            ) : null}
            <TxLink view={view} payment={payment} token={token} />
          </dl>
          {notice === 'kept' ? (
            <p className="muted small">
              You sent a little extra. Leftovers under $1 aren&apos;t returned, so it stays with the
              store.
            </p>
          ) : notice === 'returning' ? (
            <p className="muted small">
              You sent a little extra. It&apos;s being sent back to you.
            </p>
          ) : notice === 'contact' ? (
            <p className="muted small">Contact the store about the extra you paid.</p>
          ) : notice === 'sent' ? (
            <p className="muted small">You sent a little extra. It was sent back to you.</p>
          ) : null}
          {showBackLink ? <BackLink view={view} to="success" /> : null}
        </section>
      );
    }

    case 'topup': {
      const offer = view.topup;
      const t = offer ? tokenOf(offer.origin_asset) : null;
      const remaining = offer && t ? formatUnits(offer.remaining_amount, t.decimals) : null;
      return (
        <section className="pay-section" aria-labelledby="pay-topup-title">
          <h2 id="pay-topup-title">You sent less than the full amount</h2>
          {offer ? (
            <>
              <div className="pay-row">
                <p>{offer.message}</p>
                <Countdown deadline={offer.deadline} now={now} label="to send the rest" />
              </div>
              {t && remaining ? (
                <SendDetails
                  address={offer.deposit_address}
                  amount={remaining}
                  symbol={t.symbol}
                  network={networkName(t.blockchain)}
                />
              ) : (
                <p className="address">{offer.deposit_address}</p>
              )}
              <p className="muted small">
                If the rest doesn&apos;t arrive in time, what you sent is returned to you.
              </p>
              {!view.livemode ? (
                <TestModePanel client={client} kind="topup" onDone={onRefresh} />
              ) : null}
            </>
          ) : null}
        </section>
      );
    }

    case 'underpaid':
      return (
        <section className="pay-section" aria-labelledby="pay-under-title">
          <h2 id="pay-under-title">Payment incomplete</h2>
          <p>You sent less than the full amount, so it&apos;s being returned to you.</p>
          <p className="muted small">
            The cost of sending it back is taken from the amount returned.
          </p>
          <BackLink view={view} to="cancel" />
        </section>
      );

    case 'late':
      return (
        <section className="pay-section" aria-labelledby="pay-late-title">
          <h2 id="pay-late-title">Your payment arrived too late</h2>
          <p>
            It arrived after this checkout expired, so the order wasn&apos;t paid.{' '}
            {sent ? 'Your money was sent back to you.' : "It's being returned to you."}
          </p>
          <p className="muted small">
            The cost of sending it back is taken from the amount returned.
          </p>
          <BackLink view={view} to="cancel" />
        </section>
      );

    case 'refunded': {
      // No return rows on a refunded session: it went straight back to the shopper's address.
      const done = sent || (view.status === 'REFUNDED' && returns.length === 0);
      return (
        <section className="pay-section" aria-labelledby="pay-refund-title">
          <h2 id="pay-refund-title">
            {done ? 'Your money was returned' : 'Your refund is being processed'}
          </h2>
          <p>
            This order wasn&apos;t paid.{' '}
            {done
              ? 'The money you sent was sent back to you.'
              : "We're sending the money you paid back to you."}
          </p>
          <p className="muted small">
            The cost of sending it back is taken from the amount returned.
          </p>
          <BackLink view={view} to="cancel" />
        </section>
      );
    }

    case 'held':
      return (
        <section className="pay-section" aria-labelledby="pay-held-title">
          <h2 id="pay-held-title">We couldn&apos;t complete this payment</h2>
          <p>Please contact the store for help with this order.</p>
          <BackLink view={view} to="cancel" />
        </section>
      );

    case 'expired':
      return (
        <section className="pay-section pay-status-screen" aria-labelledby="pay-expired-title">
          <div className="pay-status-hero" aria-hidden>
            <div className="pay-status-orb pay-status-orb-expired">
              <span className="pay-status-ring" />
              <span className="pay-status-ring pay-status-ring-delay" />
              <span className="pay-status-expired-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M12 7.5V12l3.2 2.1"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
          </div>
          <h2 id="pay-expired-title">This checkout has expired</h2>
          <p>
            {view.payment_link
              ? `Go back to ${view.payment_link.title} to start again.`
              : 'Return to the store to start again.'}{' '}
            Don&apos;t send money to an address from this page.
          </p>
          <BackLink view={view} to="cancel" />
        </section>
      );

    case 'pay':
    case 'checking':
    default:
      return <CheckingScreen />;
  }
}

export function CheckingScreen() {
  return (
    <section className="pay-section pay-center">
      <span className="pay-spinner" aria-hidden />
      <p role="status">Checking your payment…</p>
    </section>
  );
}
