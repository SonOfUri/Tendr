'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Quote } from '@/lib/checkout/api';
import { formatUnits, shortAddress } from '@/lib/checkout/format';
import { publicEnv } from '@/lib/env';
import { toWalletError, walletErrorCopy } from '@/lib/wallets/errors';
import type { ChainFamily, WalletAdapter, WalletRoute } from '@/lib/wallets/index';
import { sameAddress } from '@/lib/wallets/match';
import { runWalletPay } from '@/lib/wallets/pay';
import { isFramed } from '@/lib/wallets/popup';
import type { WalletConnectProps, WalletQuoteResult } from './WalletConnect';

// The wallet step after "Connect wallet" was clicked (loaded on demand by WalletConnect.tsx):
// connect, re-quote with the wallet as the return address, then pay the locked quote.

/** Whether the pay button is live. */
export function canPay(opts: {
  family: ChainFamily;
  address: string | null;
  quote: Pick<Quote, 'refund_address' | 'deadline'>;
  now: number;
  livemode: boolean;
  paymentSent: boolean;
  busy: boolean;
}): boolean {
  return (
    opts.livemode &&
    !opts.paymentSent &&
    !opts.busy &&
    sameAddress(opts.family, opts.address, opts.quote.refund_address) &&
    Date.parse(opts.quote.deadline) > opts.now
  );
}

type Phase = 'idle' | 'loading' | 'connecting' | 'quoting' | 'ready' | 'sending' | 'popup';

const CONNECT_FAILED = "We couldn't connect your wallet. Try again or pay by sending manually.";
const WALLET_REFUSED = "We can't accept a payment from this wallet.";

export function WalletPanel({
  route,
  quote,
  token,
  onWalletAddress,
  onDepositSent,
  livemode = true,
  blocked = null,
  sessionId,
  openWalletWindow,
  checkBeforeSend,
  onSendingChange,
}: WalletConnectProps & { route: WalletRoute }) {
  const adapterRef = useRef<WalletAdapter | null>(null);
  const sendingRef = useRef(false);
  const started = useRef(false);
  const nearPick = useRef<((id: string | null) => void) | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [address, setAddress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [offerWindow, setOfferWindow] = useState(false);
  const [nearWallets, setNearWallets] = useState<{ id: string; name: string }[] | null>(null);

  // Mounted by the "Connect wallet" click: start connecting right away. Unmounting (another
  // token, or a payment went out) drops the wallet connection.
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void connect();
    }
    return () => {
      nearPick.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      const a = adapterRef.current;
      adapterRef.current = null;
      if (a) void a.disconnect().catch(() => {});
    },
    [],
  );

  const framed = typeof window !== 'undefined' && isFramed(window);
  const canOfferWindow = framed && !!openWalletWindow && !!sessionId;

  const fail = useCallback(
    (err: unknown, during: 'connect' | 'send') => {
      const e = toWalletError(err);
      setMessage(
        during === 'connect' && e.kind !== 'rejected' && e.kind !== 'chain_mismatch'
          ? CONNECT_FAILED
          : walletErrorCopy(e),
      );
      // In a frame, a wallet that could not open or be reached gets the window fallback.
      setOfferWindow(canOfferWindow && (e.kind === 'unavailable' || e.kind === 'failed'));
    },
    [canOfferWindow],
  );

  async function connect() {
    if (!route) return;
    setMessage(null);
    setRefused(false);
    setOfferWindow(false);
    setPhase('loading');
    let connected = false;
    try {
      let adapter = adapterRef.current;
      if (!adapter) {
        adapter = await route.load({
          reownProjectId: publicEnv.reownProjectId,
          pickNearWallet: (wallets) =>
            new Promise((resolve) => {
              nearPick.current = (id) => {
                nearPick.current = null;
                setNearWallets(null);
                resolve(id);
              };
              setNearWallets(wallets);
            }),
        });
        adapterRef.current = adapter;
      }
      setPhase('connecting');
      const { address: a } = await adapter.connect();
      connected = true;
      setAddress(a);
      await quoteForWallet(adapter, a);
    } catch (err) {
      setPhase(connected ? 'ready' : 'idle');
      fail(err, 'connect');
    }
  }

  /** Re-quotes with the wallet as the return address (screened by the API). */
  async function quoteForWallet(adapter: WalletAdapter, a: string) {
    setPhase('quoting');
    let result: WalletQuoteResult = 'failed';
    try {
      result = (await onWalletAddress?.(a)) ?? 'ok';
    } finally {
      if (result === 'refused') {
        setRefused(true);
        setAddress(null);
        adapterRef.current = null;
        void adapter.disconnect().catch(() => {});
      }
      setPhase(result === 'refused' ? 'idle' : 'ready');
    }
  }

  async function pay() {
    const adapter = adapterRef.current;
    if (!adapter || !address || sendingRef.current || blocked) return;
    sendingRef.current = true;
    onSendingChange?.(true);
    setMessage(null);
    setOfferWindow(false);
    setPhase('sending');
    try {
      const step = await runWalletPay({
        quote,
        decimals: token.decimals,
        now: () => Date.now(),
        adapter,
        checkBeforeSend,
        record: (r) => onDepositSent?.(r),
      });
      switch (step.kind) {
        case 'requote':
          // The price ran out while the shopper read it: renewed, the wallet never opened.
          setMessage("Your price ran out, so we've updated it. Check the amount, then pay.");
          await quoteForWallet(adapter, address);
          break;
        case 'check_failed':
          setMessage("We couldn't check your payment status. Try again in a moment.");
          break;
        case 'account_changed':
          setAddress(step.address);
          setMessage('Your wallet switched accounts, so we updated the price for this one.');
          await quoteForWallet(adapter, step.address);
          break;
        case 'error':
          fail(step.error, 'send');
          break;
        // 'sent', 'recorded', 'blocked': the page now shows the payment notice.
      }
    } finally {
      sendingRef.current = false;
      setPhase((p) => (p === 'idle' ? p : 'ready'));
      onSendingChange?.(false);
    }
  }

  async function disconnect() {
    const a = adapterRef.current;
    adapterRef.current = null;
    setAddress(null);
    setPhase('idle');
    setMessage(null);
    if (a) await a.disconnect().catch(() => {});
  }

  function continueInWindow() {
    if (!openWalletWindow || !sessionId) return;
    const w = openWalletWindow();
    if (!w) {
      setMessage(
        'Your browser blocked the new window. Allow pop-ups for this page, or pay by sending manually.',
      );
      return;
    }
    // The page listens for the window's result (Checkout.tsx) and records the window's quote.
    setOfferWindow(false);
    setMessage(null);
    setPhase('popup');
  }

  const amount = formatUnits(quote.amount_in, token.decimals);
  const busy =
    phase === 'loading' || phase === 'connecting' || phase === 'quoting' || phase === 'sending';
  const payable = canPay({
    family: route.chainFamily,
    address,
    quote,
    now: Date.now(),
    livemode,
    paymentSent: blocked !== null,
    busy,
  });

  return (
    <div className="pay-wallet">
      {nearWallets ? (
        <div className="pay-wallet-list" role="group" aria-label="Choose a NEAR wallet">
          {nearWallets.map((w) => (
            <button
              key={w.id}
              type="button"
              className="pay-button pay-button-secondary"
              onClick={() => nearPick.current?.(w.id)}
            >
              {w.name}
            </button>
          ))}
          <button type="button" className="link-button" onClick={() => nearPick.current?.(null)}>
            Cancel
          </button>
        </div>
      ) : phase === 'popup' ? (
        <p role="status">
          Finish paying in the new window. This page updates when you&apos;re done.
        </p>
      ) : !address ? (
        <button
          type="button"
          className="pay-button"
          onClick={() => void connect()}
          disabled={busy}
          aria-busy={busy}
        >
          <span className="pay-button-label">
            {busy ? <span className="pay-button-spinner" aria-hidden /> : null}
            <span>{busy ? 'Connecting' : 'Connect wallet'}</span>
          </span>
        </button>
      ) : (
        <>
          <p className="small">
            Paying from <span>{shortAddress(address)}</span>{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => void disconnect()}
              disabled={phase === 'sending'}
            >
              Disconnect
            </button>
          </p>
          {phase === 'ready' && !sameAddress(route.chainFamily, address, quote.refund_address) ? (
            <button
              type="button"
              className="pay-button pay-button-secondary pay-button-small"
              onClick={() => adapterRef.current && void quoteForWallet(adapterRef.current, address)}
            >
              Get a price for this wallet
            </button>
          ) : null}
          {livemode ? (
            <button
              type="button"
              className="pay-button"
              onClick={() => void pay()}
              disabled={!payable}
              aria-busy={phase === 'sending' || phase === 'quoting'}
            >
              <span className="pay-button-label">
                {phase === 'sending' || phase === 'quoting' ? (
                  <span className="pay-button-spinner" aria-hidden />
                ) : null}
                <span>
                  {phase === 'sending'
                    ? 'Confirm in your wallet'
                    : phase === 'quoting'
                      ? 'Updating your price'
                      : `Pay ${amount ?? ''} ${token.symbol}`}
                </span>
              </span>
            </button>
          ) : (
            <p className="muted small">
              Test mode: wallets connect, but nothing is sent from them. Simulate a payment with the
              buttons below.
            </p>
          )}
        </>
      )}

      {refused ? (
        <p className="pay-error" role="alert">
          {WALLET_REFUSED} You can still pay by sending manually below.
        </p>
      ) : null}
      {message ? (
        <p className="pay-error" role="alert">
          {message}
        </p>
      ) : null}
      {offerWindow ? (
        <button
          type="button"
          className="pay-button pay-button-secondary"
          onClick={continueInWindow}
        >
          Continue in a new window
        </button>
      ) : null}
    </div>
  );
}
