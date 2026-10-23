'use client';

import { Alert, Button, Spinner, StatusBadge } from '@tendr/ui';
import { useEffect, useState } from 'react';

type Session = {
  id: string;
  amount: string;
  currency: string;
  description: string | null;
  status: string;
  mode: string;
  paymentId: string | null;
};

type Quote = {
  id: string;
  sourceAsset: string;
  sourceNetwork: string;
  sourceAmount: string;
  destinationAmount: string;
  destinationAsset: string;
  expiresAt: string;
};

type Props = {
  title: string;
  description: string;
  amount: string;
  currency: string;
  merchantReferencePrefix: string;
  successHint: string;
};

export function CheckoutEngine({
  title,
  description,
  amount,
  currency,
  merchantReferencePrefix,
  successHint,
}: Props) {
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  async function startCheckout() {
    if (!online) return;
    setBusy(true);
    setError(null);
    setQuote(null);
    setPaymentStatus(null);
    try {
      const res = await fetch('/api/demo/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantReference: `${merchantReferencePrefix}_${Date.now()}`,
          amount,
          currency,
          description,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Failed to create session');
      setSession(data.session);
      setQuote(data.quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPayment() {
    if (!online || !session || !quote) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/demo/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, quoteId: quote.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Confirm failed');
      setSession(data.session);
      setPaymentStatus(data.payment.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="checkout-shell">
      <div className="sandbox-banner">Sandbox — no real funds move.</div>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p className="muted">{description}</p>
      <p>
        <strong>
          {amount} {currency}
        </strong>
      </p>

      {!online && (
        <Alert tone="warning">You are offline. Payment actions are disabled.</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      {session && (
        <div style={{ margin: '1rem 0', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <StatusBadge status={session.status} />
          {paymentStatus && <StatusBadge status={paymentStatus} />}
          <StatusBadge status={session.mode} />
        </div>
      )}

      {quote && (
        <p className="muted">
          Quote: pay {quote.sourceAmount} {quote.sourceAsset} on {quote.sourceNetwork} →{' '}
          {quote.destinationAmount} {quote.destinationAsset}
        </p>
      )}

      {paymentStatus === 'SETTLED' && <Alert tone="success">{successHint}</Alert>}

      <div className="cta-row">
        {!session && (
          <Button onClick={startCheckout} disabled={!online || busy}>
            {busy ? 'Starting…' : 'Start sandbox checkout'}
          </Button>
        )}
        {session && quote && paymentStatus !== 'SETTLED' && (
          <Button onClick={confirmPayment} disabled={!online || busy}>
            {busy ? 'Confirming…' : 'Authorize payment'}
          </Button>
        )}
        {busy && <Spinner label="Working" />}
      </div>
    </div>
  );
}
