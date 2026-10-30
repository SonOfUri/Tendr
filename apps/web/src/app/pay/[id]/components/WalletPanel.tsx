'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Quote } from '@/lib/checkout/api';
import { formatUnits, shortAddress } from '@/lib/checkout/format';
import { payButtonLabel, usePayLabel } from '@/components/theme/pay-label';
import { publicEnv } from '@/lib/env';
import { toWalletError, walletErrorCopy } from '@/lib/wallets/errors';
import type { ChainFamily, WalletAdapter, WalletRoute } from '@/lib/wallets/index';
import { sameAddress } from '@/lib/wallets/match';
import { runGaslessPay, runWalletPay, type GaslessProgress } from '@/lib/wallets/pay';
import { isFramed } from '@/lib/wallets/popup';
import {
  defaultFeeMode,
  expectationFor,
  feeChoiceAvailable,
  gaslessMethodOf,
  nativeFeeUnits,
  pickOption,
  quoteFee,
  resolveFeeRecipient,
  unavailableReason,
  type FeeMode,
  type GaslessOption,
} from '@/lib/wallets/gasless/index';
import { NetworkFee, showFeeChoice } from './NetworkFee';
import type { WalletConnectProps, WalletGaslessParams, WalletQuoteResult } from './WalletConnect';

// The wallet step after "Connect wallet" was clicked (loaded on demand by WalletConnect.tsx), in
// the wallet-first order (ruling T10-a): connect → which gasless method this wallet can use
// (`gasless/options` + the wallet's own abilities) → quote for this wallet with that method and
// fee choice → the network-fee line → sign and relay (gasless) or send (the chain's coin).

/** What this wallet can do without the chain's coin, decided once per connected address. */
interface GaslessPlan {
  address: string;
  option: GaslessOption | null;
  nativeSymbol: string | null;
  /** Why a method the wallet could use is not offered to this account. */
  unavailable: string | null;
  defaultMode: FeeMode;
  /** Tendr's fee account here (API value checked against the pinned config, T10-g). */
  feeRecipient: string | null;
}

/** The quote fields for a plan: the method, and the fee choice when the shopper pays. */
export function gaslessParams(plan: GaslessPlan | null, mode: FeeMode): WalletGaslessParams {
  const o = plan?.option;
  if (!o) return {};
  if (o.paid_by === 'merchant') return { gasless_method: o.method };
  return { gasless_method: o.method, fee_mode: mode };
}

const UNAVAILABLE_COPY: Record<string, string> = {
  near_account_needs_balance: 'Your NEAR account needs a tiny amount of NEAR to pay this way.',
  tron_account_not_activated: "Your Tron account isn't activated yet.",
};

const PROGRESS_COPY: Record<GaslessProgress, string> = {
  preparing: 'Preparing your payment',
  signing: 'Confirm in your wallet',
  confirming: 'Confirming your payment',
  previous_attempt: 'Your previous attempt is still being confirmed',
};

const MISMATCH_COPY =
  "This payment request doesn't match your price, so we didn't ask your wallet to sign it. Try again or pay by sending manually.";

/** Whether the pay button is live. */
/**
 * The main wallet "Pay …" button's words: Tendr's "Pay <amount> <token>", or the theme's button
 * words (R22) with `{amount}` filled with that same Tendr-formatted amount.
 */
export function walletPayLabel(
  themeLabel: string | null,
  amount: string | null,
  symbol: string,
): string {
  return payButtonLabel(
    themeLabel,
    amount ? `${amount} ${symbol}` : null,
    `Pay ${amount ?? ''} ${symbol}`,
  );
}

export function canPay(opts: {
  family: ChainFamily;
  address: string | null;
  quote: Pick<Quote, 'refund_address' | 'deadline'>;
  now: number;
  livemode: boolean;
  paymentSent: boolean;
  busy: boolean;
  /** A gasless quote: the wallet only signs, so test mode can run it (the relay is simulated). */
  gasless?: boolean;
}): boolean {
  return (
    (opts.livemode || opts.gasless === true) &&
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
  gasless,
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
  const planRef = useRef<GaslessPlan | null>(null);
  const [plan, setPlan] = useState<GaslessPlan | null>(null);
  const [feeMode, setFeeMode] = useState<FeeMode>('token');
  // GASLESS_NOT_AVAILABLE: this wallet pays the fee in the chain's coin from now on.
  const gaslessOff = useRef(false);
  const [progress, setProgress] = useState<GaslessProgress | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  // The theme's button words for the main "Pay …" action (R22); unset keeps Tendr's.
  const themeLabel = usePayLabel();

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

  /** Which gasless method this wallet uses here, and the fee choice's starting point. */
  async function planFor(adapter: WalletAdapter, a: string): Promise<GaslessPlan> {
    const base: GaslessPlan = {
      address: a,
      option: null,
      nativeSymbol: gasless?.nativeToken?.symbol ?? null,
      unavailable: null,
      defaultMode: 'token',
      feeRecipient: null,
    };
    if (!adapter.gasless || !gasless || gaslessOff.current) return base;
    try {
      const [opts, all] = await Promise.all([
        gasless.api.gaslessOptions({ origin_asset: quote.origin_asset, wallet_address: a }),
        adapter.gasless.methods().catch(() => []),
      ]);
      // Test mode never uses the paymaster: the smart wallet would send a real operation (T10-f).
      const methods = livemode ? all : all.filter((m) => m !== 'paymaster');
      // Every fee leg must go to Tendr's fee account: the API's, matching the pinned one.
      const feeRecipient = resolveFeeRecipient(
        opts.fee_recipient,
        publicEnv.gasFeeRecipients[route.target.blockchain],
        route.chainFamily,
        livemode,
      );
      const option = feeRecipient ? pickOption(opts.options, methods) : null;
      let defaultMode: FeeMode = 'token';
      if (feeChoiceAvailable(option)) {
        // Preselect the coin only when the wallet holds at least twice its fee.
        const nativeFee = nativeFeeUnits(option!.token_fee?.usd, gasless.nativeToken);
        const balance =
          nativeFee === null ? null : await adapter.gasless.nativeBalance().catch(() => null);
        defaultMode = defaultFeeMode(balance, nativeFee);
      }
      return {
        address: a,
        option,
        nativeSymbol: opts.native_symbol ?? base.nativeSymbol,
        unavailable: option ? null : unavailableReason(opts.options, methods),
        defaultMode,
        feeRecipient,
      };
    } catch {
      // Options unavailable: the wallet sends normally, and the page says it needs the coin.
      return base;
    }
  }

  /**
   * Re-quotes for the wallet: its address as the return address (screened by the API) and as the
   * paying wallet, with the gasless method and fee choice (`mode` when the shopper switches).
   */
  async function quoteForWallet(adapter: WalletAdapter, a: string, mode?: FeeMode) {
    setPhase('quoting');
    let result: WalletQuoteResult = 'failed';
    try {
      let p = planRef.current;
      let m = mode ?? feeMode;
      if (!p || p.address !== a) {
        p = await planFor(adapter, a);
        planRef.current = p;
        setPlan(p);
        m = mode ?? p.defaultMode;
      }
      setFeeMode(m);
      result = (await onWalletAddress?.(a, gaslessParams(p, m))) ?? 'ok';
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

  /** Gasless: prepare, check, sign, relay and wait for the outcome. */
  async function payGasless(adapter: WalletAdapter, a: string) {
    let expect;
    try {
      expect = expectationFor(quote, route.target, a, {
        livemode,
        feeRecipient: planRef.current?.address === a ? planRef.current.feeRecipient : null,
      });
    } catch {
      setMessage(MISMATCH_COPY);
      return;
    }
    if (!expect || !adapter.gasless || !gasless) return;
    const step = await runGaslessPay({
      quote,
      expect,
      api: gasless.api,
      signer: adapter.gasless,
      now: () => Date.now(),
      checkBeforeSend,
      record: (r) => onDepositSent?.(r),
      onProgress: setProgress,
    });
    setProgress(null);
    switch (step.kind) {
      case 'requote':
        if (!step.gasless) {
          // This wallet can't pay without the coin right now: quote it for a normal send.
          gaslessOff.current = true;
          planRef.current = null;
          setMessage(
            `Paying without ${plan?.nativeSymbol ?? 'the network’s coin'} isn't available right now.`,
          );
        } else {
          // The sponsorship may have changed (released, re-decided): ask the options again (m8).
          planRef.current = null;
          setMessage("Your price ran out, so we've updated it. Check the amount, then pay.");
        }
        await quoteForWallet(adapter, a);
        break;
      case 'sign_again':
        setMessage('Your signature ran out. Sign again to pay.');
        break;
      case 'mismatch':
        setMessage(MISMATCH_COPY);
        break;
      case 'refused_signed':
        setMessage(
          "Your signed payment didn't match this price, so it wasn't sent. Try again or pay by sending manually.",
        );
        break;
      case 'relay_failed':
        setMessage(
          step.reason === 'insufficient_token_balance'
            ? `Your wallet doesn't hold enough ${token.symbol} for this payment.`
            : "Your payment couldn't be sent, and nothing left your wallet. Try again.",
        );
        break;
      case 'retry':
        setMessage("We couldn't reach the network to send your payment.");
        setCanRetry(true);
        break;
      case 'rate_limited':
        setMessage('Too many attempts. Wait a few minutes, then try again.');
        break;
      case 'still_confirming':
        setMessage(PROGRESS_COPY.previous_attempt);
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
  }

  async function pay() {
    const adapter = adapterRef.current;
    if (!adapter || !address || sendingRef.current || blocked) return;
    sendingRef.current = true;
    onSendingChange?.(true);
    setMessage(null);
    setCanRetry(false);
    setOfferWindow(false);
    setPhase('sending');
    try {
      if (gaslessQuote) {
        await payGasless(adapter, address);
        return;
      }
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
      setProgress(null);
      setPhase((p) => (p === 'idle' ? p : 'ready'));
      onSendingChange?.(false);
    }
  }

  async function disconnect() {
    const a = adapterRef.current;
    adapterRef.current = null;
    planRef.current = null;
    setPlan(null);
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

  const gaslessQuote = gasless !== undefined && gaslessMethodOf(quote) !== null;
  // A token fee is sent on top of the payment: the button shows the total.
  // One fee for the line, the button and the signature (I1); an inconsistent quote is not paid.
  const fee = (() => {
    if (!gaslessQuote) return 0n;
    try {
      return quoteFee(quote);
    } catch {
      return null;
    }
  })();
  const total = (() => {
    try {
      return BigInt(quote.amount_in) + (fee ?? 0n);
    } catch {
      return quote.amount_in;
    }
  })();
  const amount = formatUnits(total, token.decimals);
  const busy =
    phase === 'loading' || phase === 'connecting' || phase === 'quoting' || phase === 'sending';
  const payable =
    fee !== null &&
    canPay({
      family: route.chainFamily,
      address,
      quote,
      now: Date.now(),
      livemode,
      paymentSent: blocked !== null,
      busy,
      gasless: gaslessQuote,
    });
  const quoteIsForWallet = sameAddress(route.chainFamily, address, quote.refund_address);
  const choiceShown = showFeeChoice(plan?.option ?? null, quote.network_fee);

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
          {gasless && quoteIsForWallet ? (
            <NetworkFee
              networkFee={quote.network_fee}
              merchantName={gasless.merchantName}
              token={token}
              coin={plan?.nativeSymbol ?? null}
              disabled={busy}
              choice={
                choiceShown
                  ? {
                      // While the new price loads, the shopper's pick shows at once (m7).
                      mode:
                        phase === 'quoting'
                          ? feeMode
                          : quote.network_fee?.fee_mode === 'native'
                            ? 'native'
                            : 'token',
                      tokenFeeAmount: plan?.option?.token_fee?.amount ?? null,
                      onChoose: (m) =>
                        adapterRef.current && void quoteForWallet(adapterRef.current, address, m),
                    }
                  : null
              }
            />
          ) : null}
          {plan?.unavailable && UNAVAILABLE_COPY[plan.unavailable] ? (
            <p className="muted small">{UNAVAILABLE_COPY[plan.unavailable]}</p>
          ) : null}
          {livemode || gaslessQuote ? (
            <>
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
                      ? progress
                        ? PROGRESS_COPY[progress]
                        : 'Confirm in your wallet'
                      : phase === 'quoting'
                        ? 'Updating your price'
                        : walletPayLabel(themeLabel, amount, token.symbol)}
                  </span>
                </span>
              </button>
              {!livemode ? (
                <p className="pay-test-label small" role="note">
                  <strong>Test mode</strong>: your wallet signs a test payment that no network
                  accepts. Nothing is sent.
                </p>
              ) : null}
              {fee === null ? (
                <p className="pay-error" role="alert">
                  {MISMATCH_COPY}
                </p>
              ) : null}
            </>
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
      {canRetry && phase === 'ready' ? (
        <button
          type="button"
          className="pay-button pay-button-secondary"
          onClick={() => void pay()}
        >
          Try again
        </button>
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
