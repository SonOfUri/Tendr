'use client';

import type { SessionView } from '@/lib/checkout/api';
import { formatOrderAmount, safeHttpUrl } from '@/lib/checkout/format';
import { Countdown } from './Countdown';

/** The store's name and logo, the order total, the time left, and a close control when framed. */
export function CheckoutHeader({
  view,
  settlementSymbol,
  now,
  showTimer,
  framed,
  onClose,
}: {
  view: SessionView;
  settlementSymbol: string | null;
  now: number;
  showTimer: boolean;
  framed: boolean;
  onClose: () => void;
}) {
  const logo = view.merchant.logo_url?.startsWith('https://')
    ? safeHttpUrl(view.merchant.logo_url)
    : null;
  const back = safeHttpUrl(view.cancel_url);
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
        {framed ? (
          <button type="button" className="pay-close" onClick={onClose} aria-label="Close checkout">
            ×
          </button>
        ) : showTimer && back ? (
          <a className="link-button small" href={back} target="_top" rel="noopener">
            Back to store
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
