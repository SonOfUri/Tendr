'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckoutClient, Quote, SessionView, Token } from '@/lib/checkout/api';
import { formatUnits, formatUsd, networkName } from '@/lib/checkout/format';
import { Countdown } from './Countdown';
import { quoteFailure, type QuoteFailure } from './quote-errors';
import { RefundAddressField } from './RefundAddressField';
import { SendDetails } from './SendDetails';
import { TestModePanel } from './TestModePanel';
import { TokenPicker } from './TokenPicker';
import {
  autoRequoteDue,
  chooseQuotes,
  freshQuoteDue,
  showManualSend,
  type PaymentBlock,
} from '@/lib/wallets/block';
import {
  PaymentSentNotice,
  WalletConnect,
  type WalletQuoteResult,
  type WalletSendResult,
} from './WalletConnect';

type Reason = 'choose' | 'auto' | 'refund' | 'retry' | 'wallet';

/** "Leftovers under $1 aren't returned.", the threshold formatted through formatUsd. */
export function leftoversNotice(thresholdUsd: number): string {
  const usd = Number.isFinite(thresholdUsd) ? formatUsd(String(thresholdUsd)) : null;
  if (!usd) return "Small leftovers aren't returned.";
  return `Leftovers under ${usd.replace(/\.00$/, '')} aren't returned.`;
}

/** The return address of the shopper's latest quote, and the network it is on. */
export type KnownRefund = { address: string | null; blockchain: string } | null;

/** The return address a new quote for a token on `blockchain` keeps (C35), or null. */
export function refundToCarry(last: KnownRefund, blockchain: string): string | null {
  return last && last.blockchain === blockchain ? last.address : null;
}

/**
 * The pay step with no quote for the chosen token: while blocked, the payment notice with its
 * "didn't go through" control (C35), so a blocked tab is never left blank; otherwise the loading
 * line while a price is fetched.
 */
export function QuotePending({
  blocked,
  loading,
  onDidntGoThrough,
}: {
  blocked: PaymentBlock;
  loading: boolean;
  onDidntGoThrough?: () => void;
}) {
  if (blocked) return <PaymentSentNotice blocked={blocked} onDidntGoThrough={onDidntGoThrough} />;
  if (!loading) return null;
  return (
    <p className="muted" role="status">
      Getting your price…
    </p>
  );
}

/**
 * Steps 1-3: choose a token, see the exact amount with a countdown to the price's deadline (a new
 * price is fetched automatically when it runs out), then pay with a wallet or send by hand.
 */
export function PayFlow({
  view,
  client,
  tokens,
  now,
  onQuote,
  onRefresh,
  onDepositSent,
  blocked = null,
  onDidntGoThrough,
  openWalletWindow,
  checkBeforeSend,
}: {
  view: SessionView;
  client: CheckoutClient;
  tokens: Token[];
  now: number;
  /** A new quote replaced the session's previous one. */
  onQuote: (quote: Quote) => void;
  /** Ask for the latest session state now. */
  onRefresh: () => void;
  /** A connected wallet sent (or may have sent) the deposit: record and report it. */
  onDepositSent?: (r: WalletSendResult) => void;
  /** A payment may be on its way (C32): no wallet payment and no automatic re-quote. */
  blocked?: PaymentBlock;
  /** The shopper confirmed their payment didn't go through. */
  onDidntGoThrough?: () => void;
  /** Inside a frame: opens the wallet step in a window. */
  openWalletWindow?: () => Window | null;
  /** Re-fetches the session right before a wallet send (another tab may have paid). */
  checkBeforeSend?: () => Promise<'ok' | 'blocked' | 'error'>;
}) {
  const resumed = view.quote
    ? (tokens.find((t) => t.asset_id === view.quote!.origin_asset) ?? null)
    : null;
  const [token, setToken] = useState<Token | null>(resumed);
  const [step, setStep] = useState<'choose' | 'pay'>(resumed ? 'pay' : 'choose');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<QuoteFailure | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState(false);
  // A wallet send in flight: the quote it pays is never replaced under it (C33).
  const [walletSending, setWalletSending] = useState(false);
  const autoRequoted = useRef<string | null>(null);
  // The current quote vanished (the watcher reopened the session and superseded it, C34).
  const freshRequested = useRef(false);
  // The latest quote's return address: a fresh quote and "Try again" keep it (C35).
  const knownRefund = useRef<KnownRefund>(null);

  const quote =
    view.quote && token && view.quote.origin_asset === token.asset_id ? view.quote : null;

  const requote = useCallback(
    async (t: Token, refund: string | null, reason: Reason): Promise<WalletQuoteResult> => {
      setLoading(true);
      setFailure(null);
      if (reason !== 'auto') setPriceChanged(false);
      const previous = view.quote?.origin_asset === t.asset_id ? view.quote.amount_in : null;
      try {
        const q = await client.quote({
          origin_asset: t.asset_id,
          ...(refund ? { refund_address: refund, refund_chain: t.blockchain } : {}),
        });
        setRefundError(null);
        if (reason === 'auto' && previous !== null && previous !== q.amount_in)
          setPriceChanged(true);
        onQuote(q);
        return 'ok';
      } catch (err) {
        const f = quoteFailure(err, t.symbol);
        if (f.kind === 'expired') onRefresh();
        // A connected wallet the API refuses (screening or format): the wallet slot says so.
        else if (f.kind === 'refund_address') {
          if (reason === 'wallet') return 'refused';
          setRefundError(f.message);
        } else setFailure(f);
        return 'failed';
      } finally {
        setLoading(false);
      }
    },
    [client, onQuote, onRefresh, view.quote],
  );

  function choose(t: Token) {
    setToken(t);
    setStep('pay');
    setRefundError(null);
    const current = view.quote;
    const live =
      current && current.origin_asset === t.asset_id && Date.parse(current.deadline) > Date.now();
    // While blocked, no new price: the pay step shows the notice instead (C35).
    if (chooseQuotes({ live: Boolean(live), blocked: blocked !== null }))
      void requote(t, null, 'choose');
  }

  useEffect(() => {
    if (!view.quote) return;
    const chain = tokens.find((t) => t.asset_id === view.quote!.origin_asset)?.blockchain;
    if (chain) knownRefund.current = { address: view.quote.refund_address, blockchain: chain };
  }, [view.quote, tokens]);

  /** The return address for a new quote for `t`: the current one's, else the last one known. */
  const refundFor = (t: Token) =>
    quote ? quote.refund_address : refundToCarry(knownRefund.current, t.blockchain);

  // No current quote for the chosen token (a reopened session, or a token chosen while blocked):
  // fetch a new price (a fresh deposit address) once, keeping the shopper's return address.
  useEffect(() => {
    if (quote) freshRequested.current = false;
    const due = freshQuoteDue({
      onPayStep: step === 'pay',
      tokenAsset: token?.asset_id ?? null,
      quoteAsset: view.quote?.origin_asset ?? null,
      loading,
      failed: failure !== null,
      blocked: blocked !== null,
      alreadyTried: freshRequested.current,
    });
    if (!due || !token) return;
    freshRequested.current = true;
    void requote(token, refundToCarry(knownRefund.current, token.blockchain), 'auto');
  }, [quote, view.quote, step, token, loading, failure, blocked, requote]);

  // A price that ran out is replaced once, automatically; the shopper only notices if it moved.
  useEffect(() => {
    if (step !== 'pay' || !token || !quote || loading) return;
    // Never while a payment may be on its way: a new quote would move the deposit address.
    const due = autoRequoteDue({
      quote,
      now,
      blocked: blocked !== null,
      sending: walletSending,
      lastAutoId: autoRequoted.current,
    });
    if (!due) return;
    autoRequoted.current = quote.id;
    void requote(token, quote.refund_address, 'auto');
  }, [step, token, quote, loading, now, requote, blocked, walletSending]);

  if (step === 'choose' || !token) {
    return (
      <TokenPicker
        tokens={tokens}
        selected={token?.asset_id ?? null}
        onChoose={choose}
        disabled={loading}
      />
    );
  }

  const network = networkName(token.blockchain);
  const amount = quote ? formatUnits(quote.amount_in, token.decimals) : null;
  const usd = quote?.amount_in_usd ? formatUsd(quote.amount_in_usd) : null;
  // Blocked and past the deadline: the deposit address is expired, so only the notice remains.
  const manual = quote ? showManualSend(blocked, quote.deadline, now) : true;

  return (
    <section className="pay-section" aria-labelledby="pay-quote-title">
      <div className="pay-row">
        <h2 id="pay-quote-title">
          Pay with {token.symbol} <span className="muted">on {network}</span>
        </h2>
        <button type="button" className="link-button" onClick={() => setStep('choose')}>
          Change
        </button>
      </div>

      {failure ? (
        <div className="pay-alert" role="alert">
          {failure.kind === 'on_its_way' ? (
            <p>Your payment is on its way. This page updates when it arrives.</p>
          ) : (
            <>
              <p>{failure.kind === 'message' ? failure.message : 'Something went wrong.'}</p>
              {failure.kind === 'message' && failure.retry ? (
                <button
                  type="button"
                  className="pay-button pay-button-secondary"
                  onClick={() => void requote(token, refundFor(token), 'retry')}
                >
                  Try again
                </button>
              ) : (
                <button
                  type="button"
                  className="pay-button pay-button-secondary"
                  onClick={() => setStep('choose')}
                >
                  Choose another token
                </button>
              )}
            </>
          )}
        </div>
      ) : null}

      {!quote || !amount ? (
        <QuotePending blocked={blocked} loading={loading} onDidntGoThrough={onDidntGoThrough} />
      ) : (
        <>
          {manual ? (
            <div className="pay-quote">
              <div className="pay-row">
                <span>You send</span>
                <Countdown deadline={quote.deadline} now={now} label="on this price" />
              </div>
              <p className="pay-amount">
                {amount} {token.symbol}
              </p>
              {usd ? <p className="muted small">About {usd}</p> : null}
              {quote.fee_lines.length > 0 ? (
                <dl className="pay-fees">
                  {quote.fee_lines.map((f) => (
                    <div key={f.kind}>
                      <dt>{f.label} (included)</dt>
                      <dd>{formatUsd(f.amount_usd) ?? f.amount_usd}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <p className="small" aria-live="polite">
                {loading
                  ? 'Updating your price…'
                  : priceChanged
                    ? 'The price changed. Please send the new amount.'
                    : ''}
              </p>
            </div>
          ) : null}

          {failure?.kind === 'on_its_way' ? null : (
            <WalletConnect
              quote={quote}
              token={token}
              livemode={view.livemode}
              sessionId={view.id}
              blocked={blocked}
              onDidntGoThrough={onDidntGoThrough}
              openWalletWindow={openWalletWindow}
              checkBeforeSend={checkBeforeSend}
              onSendingChange={setWalletSending}
              onWalletAddress={(address) => requote(token, address, 'wallet')}
              onDepositSent={onDepositSent}
            />
          )}

          {manual ? (
            <>
              <p className="pay-or muted small">or send it yourself</p>
              <SendDetails
                address={quote.deposit_address}
                amount={amount}
                symbol={token.symbol}
                network={network}
              />
              <RefundAddressField
                blockchain={token.blockchain}
                saved={quote.refund_address}
                busy={loading}
                error={refundError}
                onSave={(address) => void requote(token, address, 'refund')}
              />
              {quote.small_overpay_notice ? (
                <p className="muted small">{leftoversNotice(quote.small_overpay_usd)}</p>
              ) : null}
              {!view.livemode ? (
                <TestModePanel client={client} kind="pay" onDone={onRefresh} />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
