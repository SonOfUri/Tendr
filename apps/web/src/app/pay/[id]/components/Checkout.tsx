'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckoutApiError,
  createCheckoutClient,
  type Quote,
  type SessionView,
  type Token,
} from '@/lib/checkout/api';
import { createEmbedBridge, type EmbedBridge } from '@/lib/checkout/embed-bridge';
import { isModalEmbed, shouldForwardEscape } from '@/lib/checkout/escape';
import { createPoller, type Poller } from '@/lib/checkout/poller';
import { clearClientSecret, takeClientSecret } from '@/lib/checkout/secret';
import { screenFor, type ScreenKind } from '@/lib/checkout/status';
import { publicEnv } from '@/lib/env';
import { paymentBlock } from '@/lib/wallets/block';
import {
  isWalletWindow,
  listenForWalletDone,
  openWalletWindow,
  postWalletDone,
} from '@/lib/wallets/popup';
import { walletModalOpen } from '@/lib/wallets/modal-state';
import { createDepositReporter, type PendingTx } from '@/lib/wallets/tx-store';
import { ThemedPage } from '@/components/theme/ThemedPage';
import { formatOrderAmount } from '@/lib/checkout/format';
import { parseShopperThemeCached } from '@/lib/theme/parse';
import { EmailPanel, NeedsAddressPanel } from './ActionPanels';
import { CheckoutCanvas, successBackBlock } from './CheckoutCanvas';
import { CheckoutHeader } from './CheckoutHeader';
import { PayFlow } from './PayFlow';
import type { WalletSendResult } from './WalletConnect';
import { CheckingScreen, StatusScreen } from './StatusScreens';
import { useNow } from './useNow';

/** What a screen reader hears when the screen changes. */
const ANNOUNCE: Record<ScreenKind, string> = {
  pay: '',
  topup: 'You sent less than the full amount',
  underpaid: 'Payment incomplete',
  detected: 'Payment detected',
  converting: 'Converting your payment',
  complete: 'Payment complete',
  late: 'Your payment arrived too late',
  refunded: 'Your refund is being processed',
  held: "We couldn't complete this payment",
  expired: 'This checkout has expired',
  checking: 'Checking your payment',
};

type Fatal = 'incomplete' | 'invalid';

/**
 * The shopper checkout. Reads the client secret from the fragment (memory only), polls the session
 * every 2 s while visible, shows the screen for its state, and tells a framing store page what is
 * happening (embed bridge).
 */
export function Checkout({ sessionId }: { sessionId: string }) {
  // undefined until read in the browser (the fragment never reaches the server).
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<SessionView | null>(null);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const [connection, setConnection] = useState<'ok' | 'reconnecting'>('ok');
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [tokensFailed, setTokensFailed] = useState(false);
  // Framed by a registered store page: the × control can tell it to close.
  const [canClose, setCanClose] = useState(false);
  const pollerRef = useRef<Poller | null>(null);
  const bridgeRef = useRef<EmbedBridge | null>(null);
  // The wallet window opened from a framed checkout (`?wallet=1`, lib/wallets/popup.ts).
  const [walletWindow, setWalletWindow] = useState(false);
  // A connected-wallet deposit already sent (kept across reloads: lib/wallets/tx-store.ts).
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  // The server `deposit_submitted_at` the shopper confirmed didn't go through (C32).
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const stopPopupListener = useRef<(() => void) | null>(null);
  const now = useNow();

  useEffect(() => {
    const s = takeClientSecret(sessionId, window);
    setSecret(s);
    if (!s) setFatal('incomplete');
    setWalletWindow(isWalletWindow(window.location.search));
  }, [sessionId]);

  const client = useMemo(
    () => (secret ? createCheckoutClient({ baseUrl: publicEnv.apiBaseUrl, secret }) : null),
    [secret],
  );

  const reporter = useMemo(
    () =>
      client
        ? createDepositReporter({
            sessionId,
            storage: () => window.sessionStorage,
            // Always the record's own quote: a hash is never re-bound to a newer quote.
            deposit: (txHash, quoteId) => client.deposit(txHash, quoteId),
            onChange: setPendingTx,
          })
        : null,
    [client, sessionId],
  );
  const reporterRef = useRef(reporter);
  reporterRef.current = reporter;

  // After a reload: a hash saved but not yet acknowledged is posted again (never paid twice).
  useEffect(() => {
    if (!reporter) return;
    setPendingTx(reporter.pending());
    setDismissedAt(reporter.dismissed());
    void reporter.resume().then((r) => {
      if (r) pollerRef.current?.poke();
    });
  }, [reporter]);

  useEffect(() => {
    if (!client) return;
    const poller = createPoller({
      tick: async () => {
        try {
          const v = await client.session();
          setView(v);
          const { terminal, pollMs } = screenFor(v, new Date());
          // SETTLED or REFUNDED (C28): nothing more to wait for, a reload no longer needs it.
          if (terminal) {
            clearClientSecret(sessionId, window);
            reporterRef.current?.clear();
          } else if (v.status !== 'PENDING_DEPOSIT') {
            // The session moved on (the deposit was seen): the block ends here, and should the
            // session come back to PENDING_DEPOSIT (a short payment) this deposit no longer counts.
            const r = reporterRef.current;
            const at = v.deposit_submitted_at ?? null;
            if (r && (r.pending() || (at && r.dismissed() !== at))) {
              r.dismiss(at);
              setDismissedAt(at);
            }
          }
          return { terminal, intervalMs: pollMs };
        } catch (err) {
          if (err instanceof CheckoutApiError && [401, 403, 404].includes(err.status)) {
            setFatal('invalid');
            return { terminal: true };
          }
          throw err;
        }
      },
      doc: document,
      onConnection: setConnection,
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [client, sessionId]);

  const loadTokens = useCallback(() => {
    if (!client) return;
    setTokensFailed(false);
    client
      .tokens()
      .then((r) => setTokens(r.tokens))
      .catch(() => setTokensFailed(true));
  }, [client]);
  useEffect(loadTokens, [loadTokens]);

  const refresh = useCallback(() => pollerRef.current?.poke(), []);

  // A connected wallet sent (or may have sent) the deposit: record it (this blocks any further
  // wallet payment), report a hash with its own quote id, and in the wallet window tell the
  // framed checkout that opened it, then close.
  const onDepositSent = useCallback(
    (r: WalletSendResult) => {
      if (!reporter) return;
      const reported = reporter.record(r).finally(refresh);
      refresh();
      // A tx id saved before its broadcast is not a result yet: the window stays open.
      if (r.persistOnly) return;
      if (
        walletWindow &&
        r.txHash !== null &&
        r.state !== 'failed' &&
        postWalletDone(window, sessionId, r.txHash, r.quoteId)
      ) {
        const wait = new Promise((res) => setTimeout(res, 2000));
        void Promise.race([reported, wait]).finally(() => window.close());
      }
    },
    [reporter, refresh, walletWindow, sessionId],
  );
  // Right before a wallet send: the session is re-fetched, and a deposit reported meanwhile
  // (another tab, another window) blocks this one (C33).
  const checkBeforeSend = useCallback(async (): Promise<'ok' | 'blocked' | 'error'> => {
    if (!client || !reporter) return 'error';
    let v: SessionView;
    try {
      v = await client.session();
    } catch {
      return 'error';
    }
    setView(v);
    const block = paymentBlock({
      status: v.status,
      pending: reporter.pending(),
      depositSubmittedAt: v.deposit_submitted_at ?? null,
      dismissedSubmittedAt: reporter.dismissed(),
    });
    if (v.status !== 'PENDING_DEPOSIT') return 'blocked';
    return block === null ? 'ok' : 'blocked';
  }, [client, reporter]);

  // The wallet window: its result is recorded with the WINDOW's quote id, never this page's.
  const openWallet = useCallback(() => {
    if (!secret) return null;
    const w = openWalletWindow(window, sessionId, secret);
    if (w) {
      stopPopupListener.current?.();
      stopPopupListener.current = listenForWalletDone(window, w, sessionId, (txHash, quoteId) => {
        stopPopupListener.current?.();
        stopPopupListener.current = null;
        onDepositSent({ txHash, quoteId, state: 'sent' });
      });
    }
    return w;
  }, [secret, sessionId, onDepositSent]);
  useEffect(() => () => stopPopupListener.current?.(), []);

  // "My payment didn't go through", confirmed: drop the record and the server time it saw. The
  // page may then fetch a new price, which the API grants only when it allows one.
  const onDidntGoThrough = useCallback(() => {
    const at = view?.deposit_submitted_at ?? null;
    reporter?.dismiss(at);
    setDismissedAt(at);
    refresh();
  }, [reporter, view?.deposit_submitted_at, refresh]);
  const onQuote = useCallback((q: Quote) => setView((v) => (v ? { ...v, quote: q } : v)), []);

  const screen = view ? screenFor(view, new Date(now)) : null;

  // The embed bridge needs the session's checkout domains: created with the first view.
  useEffect(() => {
    if (!view || bridgeRef.current) return;
    const bridge = createEmbedBridge({
      win: window,
      sessionId,
      checkoutDomains: Array.isArray(view.checkout_domains) ? view.checkout_domains : [],
    });
    bridgeRef.current = bridge;
    setCanClose(bridge.targetOrigin !== null);
    bridge.ready(screenFor(view, new Date()).bridgeStatus);
  }, [view, sessionId]);
  // Framed by a registered store page: report the page's height (the inline widget sizes its
  // frame to it), and in tendr.js's modal only, an Esc nothing in here handled asks the store page
  // to close (focus is inside this frame, so the store page never sees the key; lib/checkout/
  // escape.ts). The widget never closes on Esc.
  const framedForStore = canClose;
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!framedForStore || !bridge) return;
    const root = document.querySelector('.pay');
    const stopHeight = root ? bridge.watchHeight(root) : () => {};
    const modal = isModalEmbed(window.location.search);
    const onKey = (e: KeyboardEvent) => {
      if (shouldForwardEscape(e, { modal, walletModalOpen: walletModalOpen(), doc: document })) {
        bridge.close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      stopHeight();
      document.removeEventListener('keydown', onKey);
    };
  }, [framedForStore]);
  const bridgeStatus = screen?.bridgeStatus ?? null;
  useEffect(() => {
    bridgeRef.current?.status(bridgeStatus);
  }, [bridgeStatus]);

  const tokenOf = useCallback(
    (assetId: string) => tokens?.find((t) => t.asset_id === assetId) ?? null,
    [tokens],
  );

  if (fatal) {
    return (
      <div className="pay-card">
        <section className="pay-section">
          <h1 className="pay-title">
            {fatal === 'incomplete'
              ? 'This checkout link is incomplete'
              : 'This checkout link is no longer valid'}
          </h1>
          <p role="alert">
            {fatal === 'incomplete'
              ? 'This checkout link is incomplete. Return to the store and try again.'
              : 'Return to the store and try again.'}
          </p>
        </section>
      </div>
    );
  }

  if (!view || !screen || !client) {
    return (
      <div className="pay-card">
        {connection === 'reconnecting' ? <Reconnecting /> : null}
        <CheckingScreen />
      </div>
    );
  }

  const settlementSymbol =
    view.amount_currency === 'USD' ? null : (tokenOf(view.amount_currency)?.symbol ?? null);
  // A theme that doesn't parse is the Tendr default look; payment never depends on the theme.
  const theme = parseShopperThemeCached(view.theme, view.merchant.name);

  // The sealed payment block: everything about the money stays Tendr's, whatever the theme says.
  const sealed = (
    <>
      <CheckoutHeader
        view={view}
        tradingAs={theme.trading_as}
        settlementSymbol={settlementSymbol}
        now={now}
        showTimer={screen.kind === 'pay'}
        canClose={canClose}
        onClose={() => bridgeRef.current?.close()}
      />
      {connection === 'reconnecting' ? <Reconnecting /> : null}
      <p className="sr-only" role="status" aria-live="polite">
        {ANNOUNCE[screen.kind]}
      </p>

      {screen.kind === 'pay' && screen.notice === 'previous_returned' ? (
        <p className="pay-alert" role="note">
          Your earlier payment didn&apos;t cover the full amount and is being returned to you. You
          can try again below.
        </p>
      ) : null}

      {screen.kind === 'pay' ? (
        tokens ? (
          <PayFlow
            view={view}
            client={client}
            tokens={tokens}
            now={now}
            onQuote={onQuote}
            onRefresh={refresh}
            onDepositSent={onDepositSent}
            blocked={paymentBlock({
              status: view.status,
              pending: pendingTx,
              depositSubmittedAt: view.deposit_submitted_at ?? null,
              dismissedSubmittedAt: dismissedAt,
            })}
            onDidntGoThrough={onDidntGoThrough}
            checkBeforeSend={checkBeforeSend}
            openWalletWindow={walletWindow ? undefined : openWallet}
          />
        ) : tokensFailed ? (
          <section className="pay-section">
            <p role="alert">We can&apos;t load the ways to pay right now.</p>
            <button type="button" className="pay-button pay-button-secondary" onClick={loadTokens}>
              Try again
            </button>
          </section>
        ) : (
          <CheckingScreen />
        )
      ) : (
        <StatusScreen
          view={view}
          screen={screen}
          tokenOf={tokenOf}
          client={client}
          now={now}
          onRefresh={refresh}
          showBackLink={screen.kind !== 'complete' || successBackBlock(theme) === null}
        />
      )}

      {screen.action === 'email' ? <EmailPanel client={client} onDone={refresh} /> : null}
      {screen.action === 'needs_address' && screen.refundNeedingAddress ? (
        <NeedsAddressPanel client={client} refund={screen.refundNeedingAddress} onDone={refresh} />
      ) : null}
    </>
  );

  return (
    <ThemedPage theme={theme}>
      <div className="pay-card">
        <CheckoutCanvas
          view={view}
          theme={theme}
          screen={screen.kind}
          sealed={sealed}
          amountText={formatOrderAmount(view.amount, view.amount_currency, settlementSymbol)}
          settlementSymbol={settlementSymbol}
        />
        <p className="pay-foot muted small">Payments by Tendr</p>
      </div>
    </ThemedPage>
  );
}

function Reconnecting() {
  return (
    <p className="pay-reconnecting small" role="status" aria-live="polite">
      Reconnecting…
    </p>
  );
}
