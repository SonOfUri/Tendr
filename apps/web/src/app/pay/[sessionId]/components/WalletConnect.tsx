'use client';

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { Quote, Token } from '@/lib/checkout/api';
import { publicEnv } from '@/lib/env';
import type { PaymentBlock } from '@/lib/wallets/block';
import { adapterFor, needsReown, type WalletRoute } from '@/lib/wallets/index';
import type { PendingState } from '@/lib/wallets/tx-store';

/** How re-quoting with the connected wallet as the return address went. */
export type WalletQuoteResult = 'ok' | 'refused' | 'failed';

/** What a wallet send produced: a hash, or "possibly sent" / "failed" after the wallet signed. */
export interface WalletSendResult {
  txHash: string | null;
  /** The quote this payment was for (bound before the wallet opened). */
  quoteId: string;
  state: PendingState;
}

/**
 * The connect-wallet slot: connect (Reown AppKit for EVM, Solana and Bitcoin, TronLink, NEAR
 * Wallet Selector), re-quote with the wallet as the return address, then send exactly
 * `quote.amount_in` of `token` from the shopper's own wallet to `quote.deposit_address`. Tendr
 * never signs for the shopper.
 *
 * This shell is all the checkout loads up front: the wallet step (WalletPanel.tsx) and every
 * wallet SDK load only when "Connect wallet" is clicked.
 */
export interface WalletConnectProps {
  /** The live quote: where to send, how much (base units) and until when. */
  quote: Pick<
    Quote,
    'id' | 'deposit_address' | 'amount_in' | 'origin_asset' | 'deadline' | 'refund_address'
  >;
  /** The token being paid with (network, decimals, symbol). */
  token: Token;
  /**
   * The connected wallet's address on the token's network. The page re-quotes with it as the
   * return address, so money that needs to come back goes straight to that wallet.
   */
  onWalletAddress?: (address: string) => Promise<WalletQuoteResult> | void;
  /** The wallet sent (or may have sent) a payment: the page records and reports it. */
  onDepositSent?: (r: WalletSendResult) => void;
  /** Test mode: wallets connect, but no payment is ever sent from them. */
  livemode?: boolean;
  /** A payment may already be on its way (C32): no wallet payment at all, just a notice. */
  blocked?: PaymentBlock;
  /** The shopper confirmed "My payment didn't go through". */
  onDidntGoThrough?: () => void;
  sessionId?: string;
  /** Inside a frame: opens this checkout in a window for the wallet step (null if blocked). */
  openWalletWindow?: () => Window | null;
}

type Panel = ComponentType<WalletConnectProps & { route: WalletRoute }>;

const BLOCK_COPY: Record<NonNullable<PaymentBlock>, string> = {
  sent: 'Your payment is on its way. This page updates when it arrives.',
  uncertain: 'Check your wallet before paying again.',
  failed: "Your payment didn't go through in your wallet.",
};

/** "Your payment is on its way", with a confirmed way out when it really didn't go through. */
export function PaymentSentNotice({
  blocked,
  onDidntGoThrough,
}: {
  blocked: NonNullable<PaymentBlock>;
  onDidntGoThrough?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="pay-wallet">
      <p role="status">{BLOCK_COPY[blocked]}</p>
      {!onDidntGoThrough ? null : confirming ? (
        <div className="pay-alert" role="group" aria-label="Confirm the payment didn't go through">
          <p className="small">
            Only continue if your wallet shows no payment for this order. Paying twice means waiting
            for the extra to come back.
          </p>
          <div className="pay-wallet-list">
            <button
              type="button"
              className="pay-button pay-button-secondary pay-button-small"
              onClick={() => {
                setConfirming(false);
                onDidntGoThrough();
              }}
            >
              It didn&apos;t go through
            </button>
            <button type="button" className="link-button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="link-button small" onClick={() => setConfirming(true)}>
          My payment didn&apos;t go through
        </button>
      )}
    </div>
  );
}

export function WalletConnect(props: WalletConnectProps) {
  const { quote, token, blocked = null, onDidntGoThrough } = props;
  const route = useMemo(
    () => adapterFor(quote.origin_asset, token.blockchain),
    [quote.origin_asset, token.blockchain],
  );
  const [panel, setPanel] = useState<{ assetId: string; Panel: Panel } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // A block closes the wallet step; after "didn't go through" it starts again from the button.
  useEffect(() => {
    if (blocked) setPanel(null);
  }, [blocked]);

  if (blocked) return <PaymentSentNotice blocked={blocked} onDidntGoThrough={onDidntGoThrough} />;

  if (!route || (needsReown(route.chainFamily) && publicEnv.reownProjectId === null)) {
    return (
      <div className="pay-wallet">
        <p className="muted small">
          Paying from a connected wallet isn&apos;t available for {token.symbol}. Send it yourself
          using the details below.
        </p>
      </div>
    );
  }

  // Opened for this token: the wallet step. Another token starts over from the button.
  if (panel && panel.assetId === route.target.assetId) {
    return <panel.Panel {...props} route={route} />;
  }

  async function open() {
    setLoading(true);
    setFailed(false);
    try {
      const { WalletPanel } = await import('./WalletPanel');
      setPanel({ assetId: route!.target.assetId, Panel: WalletPanel });
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pay-wallet">
      <button
        type="button"
        className="pay-button"
        onClick={() => void open()}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? 'Connecting…' : 'Connect wallet'}
      </button>
      {failed ? (
        <p className="pay-error" role="alert">
          We couldn&apos;t connect your wallet. Try again or pay by sending manually.
        </p>
      ) : null}
    </div>
  );
}
