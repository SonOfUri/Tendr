'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createCheckoutClient,
  type Quote,
  type SessionView,
  type Token,
} from '@/lib/checkout/api';
import { formatUnits, networkName } from '@/lib/checkout/format';
import { screenFor } from '@/lib/checkout/status';
import { buildDemoAssetOptions } from '@/lib/demo-assets';
import { publicEnv } from '@/lib/env';
import { createDepositReporter } from '@/lib/wallets/tx-store';
import { TendrLogo } from '@/components/TendrLogo';
import {
  WalletConnect,
  type WalletQuoteResult,
  type WalletSendResult,
} from '@/app/pay/[sessionId]/components/WalletConnect';
import { TestModePanel } from '@/app/pay/[sessionId]/components/TestModePanel';
import type { DemoCheckoutBootstrap, DemoSlug } from '@/lib/demo';
import { buildDemoUiQuote } from '@/lib/demo-ui-checkout';
import { DemoAssetModal } from './DemoAssetModal';
import { DemoStatusCard } from './DemoStatusCard';
import { DemoTendrAiFab } from './DemoTendrAiFab';
import { DemoTransferDetails } from './DemoTransferDetails';

type Props = {
  sessionId: string;
  clientSecret: string;
  productName: string;
  merchantName: string;
  merchantLogoUrl: string;
  payEyebrow: string;
  skin: DemoSlug;
  /** Display amount while session hydrates (and as fallback). */
  amountHint?: string;
  /** Prefetched session/tokens/quote from /api/demo/checkout — skips cold load. */
  bootstrap?: DemoCheckoutBootstrap | null;
  /** Pure frontend demo — never call the checkout API. */
  uiOnly?: boolean;
  successHint?: string;
  onClose: () => void;
  onComplete: () => void;
  /** Fired when the demo enters confirming / success panels (for sidebar sync). */
  onStatusChange?: (status: 'confirming' | 'success') => void;
};

type PayMethod = 'transfer' | 'wallet';

function secretFromSessionUrl(url: string): string | null {
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  return new URLSearchParams(hash).get('cs');
}

export function clientSecretFromCheckout(opts: {
  clientSecret?: string | null;
  url?: string | null;
}): string | null {
  if (opts.clientSecret) return opts.clientSecret;
  if (opts.url) return secretFromSessionUrl(opts.url);
  return null;
}

export function DemoCheckoutPanel({
  sessionId,
  clientSecret,
  productName,
  merchantName,
  merchantLogoUrl,
  payEyebrow,
  skin,
  amountHint,
  bootstrap,
  uiOnly = false,
  successHint,
  onClose,
  onComplete,
  onStatusChange,
}: Props) {
  const client = useMemo(
    () => createCheckoutClient({ baseUrl: publicEnv.apiBaseUrl, secret: clientSecret }),
    [clientSecret],
  );

  const booted = Boolean(bootstrap?.session);
  const [view, setView] = useState<SessionView | null>(bootstrap?.session ?? null);
  const [tokens, setTokens] = useState<Token[]>(bootstrap?.tokens ?? []);
  const [tokenId, setTokenId] = useState<string>(bootstrap?.tokenId ?? '');
  const [quote, setQuote] = useState<Quote | null>(bootstrap?.quote ?? null);
  const [method, setMethod] = useState<PayMethod>('transfer');
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'pay' | 'waiting' | 'done' | 'error'>(
    booted || uiOnly ? 'pay' : 'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Skip the first auto-quote when bootstrap already supplied one for this token. */
  const skipQuoteForToken = useRef<string | null>(
    bootstrap?.quote && bootstrap.tokenId ? bootstrap.tokenId : null,
  );

  const completed = useRef(false);
  const demoTimerQuoteId = useRef<string | null>(null);
  const demoTimerStartedAt = useRef<number | null>(null);
  const demoTimerPausedMs = useRef(0);
  const demoTimerPauseBegan = useRef<number | null>(null);
  const assetOptions = useMemo(() => buildDemoAssetOptions(tokens), [tokens]);
  const selectedToken = tokens.find((t) => t.asset_id === tokenId) ?? null;
  const amountUsd = view?.amount ?? amountHint ?? '0';

  const reporter = useMemo(
    () =>
      createDepositReporter({
        sessionId,
        storage: () => window.sessionStorage,
        deposit: (txHash, quoteId) => client.deposit(txHash, quoteId),
        onChange: () => undefined,
      }),
    [client, sessionId],
  );

  const refresh = useCallback(async () => {
    if (uiOnly) return view;
    const next = await client.session();
    setView(next);
    const screen = screenFor(next, new Date());
    if (screen.kind === 'complete' && !completed.current) {
      completed.current = true;
      setPhase('done');
    } else if (screen.kind === 'detected' || screen.kind === 'converting') {
      setPhase('waiting');
    }
    return next;
  }, [client, uiOnly, view]);

  useEffect(() => {
    if (uiOnly || booted) return;
    let cancelled = false;
    (async () => {
      try {
        const [session, tokenRes] = await Promise.all([client.session(), client.tokens()]);
        if (cancelled) return;
        const options = buildDemoAssetOptions(tokenRes.tokens);
        const firstPayable = options.find((o) => o.token)?.token;
        setView(session);
        setTokens(tokenRes.tokens);
        setTokenId(firstPayable?.asset_id ?? '');
        setPhase('pay');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load checkout');
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [booted, client, sessionId, uiOnly]);

  useEffect(() => {
    if (uiOnly) return;
    if (phase === 'loading' || phase === 'error' || phase === 'done') return;
    const id = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(id);
  }, [phase, refresh, uiOnly]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (phase !== 'pay' || !tokenId) return;
    if (skipQuoteForToken.current === tokenId) {
      skipQuoteForToken.current = null;
      return;
    }
    const token = tokens.find((t) => t.asset_id === tokenId);
    if (!token) return;

    if (uiOnly) {
      setBusy(true);
      setError(null);
      // Tiny tick so asset switches still feel responsive without a network roundtrip.
      const t = window.setTimeout(() => {
        setQuote(buildDemoUiQuote(token, amountUsd));
        setBusy(false);
      }, 120);
      return () => window.clearTimeout(t);
    }

    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      setQuote(null);
      try {
        const q = await client.quote({ origin_asset: tokenId });
        if (!cancelled) setQuote(q);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not get a price');
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tokenId, phase, client, uiOnly, tokens, amountUsd]);

  const requoteForWallet = useCallback(
    async (address: string): Promise<WalletQuoteResult> => {
      if (!selectedToken) return 'failed';
      if (uiOnly) {
        setQuote(buildDemoUiQuote(selectedToken, amountUsd));
        return 'ok';
      }
      try {
        const q = await client.quote({
          origin_asset: selectedToken.asset_id,
          refund_address: address,
          refund_chain: selectedToken.blockchain,
        });
        setQuote(q);
        return 'ok';
      } catch {
        return 'failed';
      }
    },
    [amountUsd, client, selectedToken, uiOnly],
  );

  const onDepositSent = useCallback(
    (result: WalletSendResult) => {
      if (uiOnly) {
        setPhase('waiting');
        return;
      }
      void reporter.record(result).then(() => refresh()).catch(() => undefined);
      setPhase('waiting');
    },
    [reporter, refresh, uiOnly],
  );

  useEffect(() => {
    if (phase === 'waiting') onStatusChange?.('confirming');
    if (phase === 'done') onStatusChange?.('success');
  }, [phase, onStatusChange]);

  // UI demo: Transfer → confirming → success at 15s of active time.
  // Pauses while asset dropdown is open or Connect wallet is selected.
  useEffect(() => {
    if (!quote || completed.current) return;
    if (phase === 'loading' || phase === 'error' || phase === 'done') return;

    if (demoTimerQuoteId.current !== quote.id) {
      demoTimerQuoteId.current = quote.id;
      demoTimerStartedAt.current = Date.now();
      demoTimerPausedMs.current = 0;
      demoTimerPauseBegan.current = null;
    } else if (demoTimerStartedAt.current === null) {
      demoTimerStartedAt.current = Date.now();
    }

    const paused = method === 'wallet' || assetPickerOpen;
    if (paused) {
      if (demoTimerPauseBegan.current === null) {
        demoTimerPauseBegan.current = Date.now();
      }
      return;
    }

    if (demoTimerPauseBegan.current !== null) {
      demoTimerPausedMs.current += Date.now() - demoTimerPauseBegan.current;
      demoTimerPauseBegan.current = null;
    }

    // Stay on transfer details long enough to demo; then pending checklist → success.
    const WAIT_AT_MS = 45_000;
    const DONE_AT_MS = 56_000;

    const tick = () => {
      if (completed.current || demoTimerStartedAt.current === null) return;
      const elapsed = Date.now() - demoTimerStartedAt.current - demoTimerPausedMs.current;
      if (elapsed >= WAIT_AT_MS) {
        setPhase((p) => (p === 'pay' ? 'waiting' : p));
      }
      if (elapsed >= DONE_AT_MS) {
        completed.current = true;
        setPhase('done');
      }
    };

    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [quote, method, assetPickerOpen, phase]);

  const amountLabel = view ? `$${view.amount}` : amountHint ? `$${amountHint}` : '—';
  const sendAmount =
    quote && selectedToken ? formatUnits(quote.amount_in, selectedToken.decimals) : null;
  const showPayChrome = phase === 'loading' || phase === 'pay' || phase === 'error';
  const quoteReady = Boolean(quote && selectedToken && sendAmount);

  const enterClass = booted ? '' : ' demo-checkout-overlay-in';
  const cardEnterClass = booted ? '' : ' demo-checkout-card-in';

  if (phase === 'waiting' || phase === 'done') {
    return (
      <div
        className={`demo-checkout-overlay${enterClass}`}
        role="dialog"
        aria-modal="true"
        aria-label={phase === 'waiting' ? 'Confirming payment' : 'Payment complete'}
      >
        <DemoStatusCard
          variant={phase === 'waiting' ? 'confirming' : 'success'}
          skin={skin}
          merchantName={merchantName}
          merchantLogoUrl={merchantLogoUrl}
          payEyebrow={payEyebrow}
          amountLabel={amountLabel}
          successHint={successHint}
          onClose={phase === 'waiting' ? onClose : undefined}
          onContinue={onComplete}
        />
      </div>
    );
  }

  return (
    <div
      className={`demo-checkout-overlay${enterClass}`}
      role="dialog"
      aria-modal="true"
      aria-label="Tendr checkout"
    >
      <div
        className={`demo-checkout-card demo-checkout-card-wide${cardEnterClass}`}
        data-skin={skin}
      >
        <div className="demo-checkout-card-top">
          <div className="demo-checkout-store">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={merchantLogoUrl}
              alt=""
              className="demo-checkout-store-logo"
              width={40}
              height={40}
            />
            <div>
              <p className="demo-card-label">
                {payEyebrow} {merchantName}
              </p>
              <h2 className="demo-checkout-title">{productName}</h2>
            </div>
          </div>
          <button type="button" className="demo-checkout-close" aria-label="Close checkout" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="demo-checkout-amount">{amountLabel}</p>

        {phase === 'error' ? (
          <p className="demo-error" role="alert">
            {error}
          </p>
        ) : null}

        {showPayChrome && tokens.length > 0 ? (
          <>
            <DemoAssetModal
              options={assetOptions}
              value={tokenId || assetOptions.find((o) => o.token)?.value || ''}
              disabled={busy}
              skin={skin}
              onOpenChange={setAssetPickerOpen}
              onChange={(id) => {
                setTokenId(id);
                setPhase('pay');
              }}
            />

            {!assetPickerOpen ? (
              <DemoTendrAiFab
                options={assetOptions}
                amountLabel={amountUsd}
                skin={skin}
                onPickRoute={(id) => {
                  setTokenId(id);
                  setPhase('pay');
                }}
              />
            ) : null}

            <div className="demo-pay-methods" role="tablist" aria-label="Payment method">
              <button
                type="button"
                role="tab"
                aria-selected={method === 'transfer'}
                className="demo-pay-method"
                onClick={() => setMethod('transfer')}
              >
                Transfer
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={method === 'wallet'}
                className="demo-pay-method"
                onClick={() => setMethod('wallet')}
              >
                Connect wallet
              </button>
            </div>

            {busy && !quote ? (
              <div className="demo-checkout-skeleton" aria-busy="true" aria-label="Getting price">
                <span className="demo-skel demo-skel-line" />
                <span className="demo-skel demo-skel-block" />
                <span className="demo-skel demo-skel-line short" />
              </div>
            ) : null}

            {method === 'transfer' && quoteReady ? (
              <div className="demo-checkout-reveal">
                <DemoTransferDetails
                  address={quote!.deposit_address}
                  amount={sendAmount!}
                  symbol={selectedToken!.symbol}
                  network={networkName(selectedToken!.blockchain)}
                  deadline={quote!.deadline}
                />
              </div>
            ) : null}

            {method === 'wallet' && quote && selectedToken ? (
              <div className="demo-wallet-slot demo-checkout-reveal">
                <WalletConnect
                  key={selectedToken.asset_id}
                  quote={quote}
                  token={selectedToken}
                  livemode={view?.livemode ?? false}
                  sessionId={sessionId}
                  autoOpen
                  onWalletAddress={requoteForWallet}
                  onDepositSent={onDepositSent}
                />
                {!uiOnly && view && !view.livemode ? (
                  <TestModePanel
                    client={client}
                    kind="pay"
                    onDone={() => {
                      void refresh()
                        .then(() => setPhase('waiting'))
                        .catch(() => undefined);
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {phase === 'loading' || (phase === 'pay' && tokens.length === 0 && !error) ? (
          <div className="demo-checkout-skeleton" aria-busy="true" aria-label="Loading checkout">
            <span className="demo-skel demo-skel-pill" />
            <span className="demo-skel demo-skel-tabs" />
            <span className="demo-skel demo-skel-block" />
            <span className="demo-skel demo-skel-line" />
            <span className="demo-skel demo-skel-line short" />
          </div>
        ) : null}

        {error && phase !== 'error' ? (
          <p className="demo-error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="demo-checkout-footnote">
          <TendrLogo size={22} />
          Powered by <strong>Tendr</strong>
        </p>
      </div>
    </div>
  );
}

/** Instant shell shown the moment the user starts checkout — before the session exists. */
export function DemoCheckoutOpening({
  productName,
  merchantName,
  merchantLogoUrl,
  payEyebrow,
  skin,
  amountHint,
  onClose,
}: {
  productName: string;
  merchantName: string;
  merchantLogoUrl: string;
  payEyebrow: string;
  skin: DemoSlug;
  amountHint: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="demo-checkout-overlay demo-checkout-overlay-in"
      role="dialog"
      aria-modal="true"
      aria-label="Opening checkout"
      aria-busy="true"
    >
      <div className="demo-checkout-card demo-checkout-card-wide demo-checkout-card-in" data-skin={skin}>
        <div className="demo-checkout-card-top">
          <div className="demo-checkout-store">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={merchantLogoUrl}
              alt=""
              className="demo-checkout-store-logo"
              width={40}
              height={40}
            />
            <div>
              <p className="demo-card-label">
                {payEyebrow} {merchantName}
              </p>
              <h2 className="demo-checkout-title">{productName}</h2>
            </div>
          </div>
          <button type="button" className="demo-checkout-close" aria-label="Close checkout" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="demo-checkout-amount">${amountHint}</p>

        <div className="demo-checkout-skeleton" aria-hidden>
          <span className="demo-skel demo-skel-pill" />
          <span className="demo-skel demo-skel-tabs" />
          <span className="demo-skel demo-skel-block" />
          <span className="demo-skel demo-skel-line" />
          <span className="demo-skel demo-skel-line short" />
        </div>

        <p className="demo-checkout-footnote">
          <TendrLogo size={22} />
          Powered by <strong>Tendr</strong>
        </p>
      </div>
    </div>
  );
}
