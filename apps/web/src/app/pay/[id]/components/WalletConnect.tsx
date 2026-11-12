'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { Quote, Token } from '@/lib/checkout/api';
import type { FeeMode, GaslessApi, GaslessMethod } from '@/lib/wallets/gasless/index';
import { publicEnv } from '@/lib/env';
import { toast } from '@/components/toast';
import { showBlockNotice, type PaymentBlock } from '@/lib/wallets/block';
import { adapterFor, needsReown, type WalletRoute } from '@/lib/wallets/index';
import type { WalletSendResult } from '@/lib/wallets/pay';

export type { WalletSendResult };

/** How re-quoting with the connected wallet as the return address went. */
export type WalletQuoteResult = 'ok' | 'refused' | 'failed';

/** What the wallet path asks the quote for: the gasless method and, when the shopper pays, how. */
export interface WalletGaslessParams {
  gasless_method?: GaslessMethod;
  fee_mode?: FeeMode;
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
  > &
    Partial<Pick<Quote, 'network_fee' | 'fee_amount'>>;
  /** The token being paid with (network, decimals, symbol). */
  token: Token;
  /**
   * The connected wallet's address on the token's network. The page re-quotes with it as the
   * return address (so money that needs to come back goes straight to that wallet) and as the
   * paying wallet, with the gasless method and fee choice when there is one.
   */
  onWalletAddress?: (
    address: string,
    gasless?: WalletGaslessParams,
  ) => Promise<WalletQuoteResult> | void;
  /**
   * Gasless payments (project 5a): the shopper routes, the store's name for "Network fee: paid by
   * {merchant}", and the chain's coin (to preselect it when the wallet holds enough).
   */
  gasless?: { api: GaslessApi; merchantName: string; nativeToken: Token | null };
  /** The wallet sent (or may have sent) a payment: the page records and reports it. */
  onDepositSent?: (r: WalletSendResult) => void;
  /** Test mode: wallets connect, but no payment is ever sent from them. */
  livemode?: boolean;
  testnet?: boolean;
  /** A payment may already be on its way (C32): no wallet payment at all, just a notice. */
  blocked?: PaymentBlock;
  /** The shopper confirmed "My payment didn't go through". */
  onDidntGoThrough?: () => void;
  sessionId?: string;
  /** Inside a frame: opens this checkout in a window for the wallet step (null if blocked). */
  openWalletWindow?: () => Window | null;
  /**
   * Re-fetches the session right before the wallet opens: 'blocked' when a deposit was reported
   * meanwhile (another tab), 'error' when it could not be checked.
   */
  checkBeforeSend?: () => Promise<'ok' | 'blocked' | 'error'>;
  /** A wallet send is in flight (or just settled). */
  onSendingChange?: (sending: boolean) => void;
  /** Skip the intermediate button and open the wallet connect step on mount. */
  autoOpen?: boolean;
}

type Panel = ComponentType<WalletConnectProps & { route: WalletRoute }>;

/** The confirm step's warning: covers a payment that failed and one that was never sent. */
export const CONFIRM_NOT_SENT_COPY =
  'Only continue if your wallet shows this payment failed or was never sent. If you pay again and both go through, you wait for the extra to come back.';

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
          <p className="small">{CONFIRM_NOT_SENT_COPY}</p>
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
  const {
    quote,
    token,
    blocked = null,
    onDidntGoThrough,
    onSendingChange,
    autoOpen = false,
  } = props;
  const route = useMemo(() => {
    const r = adapterFor(quote.origin_asset, token.blockchain);
    return r &&
      ((props.testnet && r.target.network !== 'testnet') ||
        (props.livemode !== false && r.target.network === 'testnet'))
      ? null
      : r;
  }, [quote.origin_asset, token.blockchain, props.testnet, props.livemode]);
  const [panel, setPanel] = useState<{ assetId: string; Panel: Panel } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // A wallet send in flight: a block arriving from a poll waits until it settles (C33), so the
  // panel (and its wallet connection) is never torn down mid-send.
  const [sending, setSending] = useState(false);
  const autoOpened = useRef(false);
  const noticeShown = showBlockNotice(blocked, sending);
  // End-to-end tests only: an injected test wallet stands in for Reown (lib/env.ts).
  const injected =
    route?.chainFamily === 'evm' &&
    publicEnv.e2eInjectedWallet &&
    typeof window !== 'undefined' &&
    'ethereum' in window;
  const walletAvailable =
    !!route && !(needsReown(route.chainFamily) && publicEnv.reownProjectId === null && !injected);

  async function open() {
    if (!route) return;
    setLoading(true);
    setFailed(false);
    try {
      const { WalletPanel } = await import('./WalletPanel');
      setPanel({ assetId: route.target.assetId, Panel: WalletPanel });
    } catch {
      setFailed(true);
      toast.error("We couldn't connect your wallet. Try again or pay by sending manually.");
    } finally {
      setLoading(false);
    }
  }

  // A block closes the wallet step; after "didn't go through" it starts again from the button.
  useEffect(() => {
    if (noticeShown) setPanel(null);
  }, [noticeShown]);

  // Demo / direct entry: open the wallet modal without an extra click.
  useEffect(() => {
    if (!autoOpen || autoOpened.current || noticeShown || !walletAvailable) return;
    autoOpened.current = true;
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, walletAvailable, noticeShown, quote.origin_asset]);

  if (noticeShown && blocked) {
    return <PaymentSentNotice blocked={blocked} onDidntGoThrough={onDidntGoThrough} />;
  }

  if (!walletAvailable) {
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
  if (panel && route && panel.assetId === route.target.assetId) {
    return (
      <panel.Panel
        {...props}
        route={route}
        onSendingChange={(v) => {
          setSending(v);
          onSendingChange?.(v);
        }}
      />
    );
  }

  return (
    <div className="pay-wallet">
      <button
        type="button"
        className="pay-button"
        onClick={() => void open()}
        disabled={loading || autoOpen}
        aria-busy={loading || autoOpen}
      >
        <span className="pay-button-label">
          {loading || autoOpen ? <span className="pay-button-spinner" aria-hidden /> : null}
          <span>{loading || autoOpen ? 'Connecting' : 'Connect wallet'}</span>
        </span>
      </button>
    </div>
  );
}
