'use client';

import { useMemo, useState, type ComponentType } from 'react';
import type { Quote, Token } from '@/lib/checkout/api';
import { publicEnv } from '@/lib/env';
import { adapterFor, needsReown, type WalletRoute } from '@/lib/wallets/index';

/** How re-quoting with the connected wallet as the return address went. */
export type WalletQuoteResult = 'ok' | 'refused' | 'failed';

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
  /** The deposit transaction was sent: the page saves and reports it so it is seen sooner. */
  onDepositSent?: (txHash: string) => void;
  /** Test mode: wallets connect, but no payment is ever sent from them. */
  livemode?: boolean;
  /** A payment for this quote was already sent: no pay button. */
  paymentSent?: boolean;
  sessionId?: string;
  /** Inside a frame: opens this checkout in a window for the wallet step (null if blocked). */
  openWalletWindow?: () => Window | null;
}

type Panel = ComponentType<WalletConnectProps & { route: WalletRoute }>;

export function WalletConnect(props: WalletConnectProps) {
  const { quote, token, paymentSent = false } = props;
  const route = useMemo(
    () => adapterFor(quote.origin_asset, token.blockchain),
    [quote.origin_asset, token.blockchain],
  );
  const [panel, setPanel] = useState<{ assetId: string; Panel: Panel } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

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

  if (paymentSent) {
    return (
      <div className="pay-wallet">
        <p role="status">Your payment is on its way. This page updates when it arrives.</p>
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
