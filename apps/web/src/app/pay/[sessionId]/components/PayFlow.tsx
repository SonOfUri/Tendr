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
import { WalletConnect, type WalletQuoteResult } from './WalletConnect';

type Reason = 'choose' | 'auto' | 'refund' | 'retry' | 'wallet';

/** "Leftovers under $1 aren't returned.", the threshold formatted through formatUsd. */
export function leftoversNotice(thresholdUsd: number): string {
  const usd = Number.isFinite(thresholdUsd) ? formatUsd(String(thresholdUsd)) : null;
  if (!usd) return "Small leftovers aren't returned.";
  return `Leftovers under ${usd.replace(/\.00$/, '')} aren't returned.`;
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
  sentQuoteId = null,
  openWalletWindow,
}: {
  view: SessionView;
  client: CheckoutClient;
  tokens: Token[];
  now: number;
  /** A new quote replaced the session's previous one. */
  onQuote: (quote: Quote) => void;
  /** Ask for the latest session state now. */
  onRefresh: () => void;
  /** A connected wallet sent the deposit for `quoteId`: save and report the hash. */
  onDepositSent?: (txHash: string, quoteId: string) => void;
  /** The quote a wallet payment was already sent for (its pay button stays hidden). */
  sentQuoteId?: string | null;
  /** Inside a frame: opens the wallet step in a window. */
  openWalletWindow?: () => Window | null;
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
  const autoRequoted = useRef<string | null>(null);

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
    if (!live) void requote(t, null, 'choose');
  }

  // A price that ran out is replaced once, automatically; the shopper only notices if it moved.
  useEffect(() => {
    if (step !== 'pay' || !token || !quote || loading) return;
    if (Date.parse(quote.deadline) > now || autoRequoted.current === quote.id) return;
    autoRequoted.current = quote.id;
    void requote(token, quote.refund_address, 'auto');
  }, [step, token, quote, loading, now, requote]);

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
                  onClick={() => void requote(token, quote?.refund_address ?? null, 'retry')}
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
        loading ? (
          <p className="muted" role="status">
            Getting your price…
          </p>
        ) : null
      ) : (
        <>
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

          {failure?.kind === 'on_its_way' ? null : (
            <WalletConnect
              quote={quote}
              token={token}
              livemode={view.livemode}
              sessionId={view.id}
              paymentSent={sentQuoteId === quote.id}
              openWalletWindow={openWalletWindow}
              onWalletAddress={(address) => requote(token, address, 'wallet')}
              onDepositSent={(txHash) => onDepositSent?.(txHash, quote.id)}
            />
          )}

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
          {!view.livemode ? <TestModePanel client={client} kind="pay" onDone={onRefresh} /> : null}
        </>
      )}
    </section>
  );
}
