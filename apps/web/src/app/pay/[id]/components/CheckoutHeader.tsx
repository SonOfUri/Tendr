'use client';

import type { SessionView } from '@/lib/checkout/api';
import { formatOrderAmount, safeHttpUrl } from '@/lib/checkout/format';
import { Countdown } from './Countdown';

/**
 * Who the shopper pays: the ACCOUNT's name (`merchant.name`), never the theme's display name.
 * When the theme shows a different store name, it says so: "<account> · trading as <name>".
 */
export function PayeeLine({ payee, tradingAs }: { payee: string; tradingAs: string | null }) {
  return (
    <p className="pay-payee">
      You&apos;re paying <strong>{payee}</strong>
      {tradingAs ? <span className="muted"> · trading as {tradingAs}</span> : null}
    </p>
  );
}

/**
 * The top of the sealed payment block: who is paid, the order total, the time left, and a close
 * control when the page is framed by a registered store page (the bridge has somewhere to send
 * `tendr:close`). The store's logo and name are the theme's header block, outside this block.
 */
export function CheckoutHeader({
  view,
  tradingAs = null,
  settlementSymbol,
  now,
  showTimer,
  canClose,
  onClose,
}: {
  view: SessionView;
  /** The theme's display name when it differs from the account name (`theme.trading_as`). */
  tradingAs?: string | null;
  settlementSymbol: string | null;
  now: number;
  showTimer: boolean;
  /** Framed, and the embed bridge has a target origin. */
  canClose: boolean;
  onClose: () => void;
}) {
  // A session from a payment link goes back to the link's page, named by its title.
  const link = view.payment_link ?? null;
  const back = safeHttpUrl(link ? link.url : view.cancel_url);
  const backLabel = link ? `Back to ${link.title}` : 'Back to store';
  return (
    <header className="pay-header">
      <div className="pay-row">
        <PayeeLine payee={view.merchant.name} tradingAs={tradingAs} />
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
