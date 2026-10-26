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
import { createPoller, type Poller } from '@/lib/checkout/poller';
import { clearClientSecret, takeClientSecret } from '@/lib/checkout/secret';
import { screenFor, type ScreenKind } from '@/lib/checkout/status';
import { publicEnv } from '@/lib/env';
import { EmailPanel, NeedsAddressPanel } from './ActionPanels';
import { CheckoutHeader } from './CheckoutHeader';
import { PayFlow } from './PayFlow';
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
  const now = useNow();

  useEffect(() => {
    const s = takeClientSecret(sessionId, window);
    setSecret(s);
    if (!s) setFatal('incomplete');
  }, [sessionId]);

  const client = useMemo(
    () => (secret ? createCheckoutClient({ baseUrl: publicEnv.apiBaseUrl, secret }) : null),
    [secret],
  );

  useEffect(() => {
    if (!client) return;
    const poller = createPoller({
      tick: async () => {
        try {
          const v = await client.session();
          setView(v);
          const { terminal, pollMs } = screenFor(v, new Date());
          // SETTLED or REFUNDED (C28): nothing more to wait for, a reload no longer needs it.
          if (terminal) clearClientSecret(sessionId, window);
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

  return (
    <div className="pay-card">
      <CheckoutHeader
        view={view}
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
        />
      )}

      {screen.action === 'email' ? <EmailPanel client={client} onDone={refresh} /> : null}
      {screen.action === 'needs_address' && screen.refundNeedingAddress ? (
        <NeedsAddressPanel client={client} refund={screen.refundNeedingAddress} onDone={refresh} />
      ) : null}

      <p className="pay-foot muted small">Payments by Tendr</p>
    </div>
  );
}

function Reconnecting() {
  return (
    <p className="pay-reconnecting small" role="status" aria-live="polite">
      Reconnecting…
    </p>
  );
}
