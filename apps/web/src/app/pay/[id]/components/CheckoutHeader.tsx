'use client';

import type { SessionView } from '@/lib/checkout/api';
import { formatOrderAmount, safeHttpUrl } from '@/lib/checkout/format';
import { Countdown } from './Countdown';

/**
 * The store's name and logo, the order total, the time left, and a close control when the page
 * is framed by a registered store page (the bridge has somewhere to send `tendr:close`).
 */
export function CheckoutHeader({
  view,
  settlementSymbol,
  now,
  showTimer,
  canClose,
  onClose,
}: {
  view: SessionView;
  settlementSymbol: string | null;
  now: number;
  showTimer: boolean;
  /** Framed, and the embed bridge has a target origin. */
  canClose: boolean;
  onClose: () => void;
}) {
  const logo = view.merchant.logo_url?.startsWith('https://')
    ? safeHttpUrl(view.merchant.logo_url)
    : null;
  // A session from a payment link goes back to the link's page, named by its title.
  const link = view.payment_link ?? null;
  const back = safeHttpUrl(link ? link.url : view.cancel_url);
  const backLabel = link ? `Back to ${link.title}` : 'Back to store';
  return (
    <header className="pay-header">
      <div className="pay-row">
        <div className="pay-store">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- the store's own logo, any host
            <img src={logo} alt="" width={28} height={28} className="pay-logo" />
          ) : null}
          <span className="pay-store-name">{view.merchant.name}</span>
        </div>
        {canClose ? (
          <button type="button" className="pay-close" onClick={onClose} aria-label="Close checkout">
            ×
          </button>
        ) : showTimer && back ? (
          <a className="link-button small" href={back} target="_top" rel="noopener">
            {backLabel}
          </a>
        ) : null}
      </div>
      <div className="pay-row">
        <span className="muted">Order total</span>
        <strong className="pay-total">
          {formatOrderAmount(view.amount, view.amount_currency, settlementSymbol)}
        </strong>
      </div>
      {showTimer ? (
        <div className="pay-row muted small">
          <span>Time left to pay</span>
          <Countdown
            deadline={view.expires_at}
            now={now}
            label="to pay"
            announceUnderMs={5 * 60_000}
          />
        </div>
      ) : null}
      {!view.livemode ? (
        <p className="pay-test-banner small" role="note">
          Test mode. No real money moves.
        </p>
      ) : null}
    </header>
  );
}
