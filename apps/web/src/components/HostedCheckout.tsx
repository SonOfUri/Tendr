'use client';

import { Alert, Button, Spinner, StatusBadge } from '@tendr/ui';
import { useEffect, useState } from 'react';

export function HostedCheckout({ sessionId }: { sessionId: string }) {
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{
    id: string;
    amount: string;
    currency: string;
    status: string;
    description: string | null;
    mode: string;
  } | null>(null);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/checkout/${sessionId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message ?? 'Failed to load session');
        setSession(data.session);
        setQuoteId(data.quote?.id ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  async function confirm() {
    if (!quoteId || !online) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/demo/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, quoteId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Confirm failed');
      setSession(data.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="checkout-shell">
        <Spinner />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="checkout-shell">
        <Alert tone="danger">{error ?? 'Session not found'}</Alert>
      </div>
    );
  }

  return (
    <div className="checkout-shell">
      <div className="sandbox-banner">Sandbox — no real funds move.</div>
      {!online && <Alert tone="warning">Offline — payment disabled.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <p>
        <StatusBadge status={session.status} /> <StatusBadge status={session.mode} />
      </p>
      <h2 style={{ marginTop: '0.5rem' }}>{session.description ?? 'Checkout'}</h2>
      <p>
        <strong>
          {session.amount} {session.currency}
        </strong>
      </p>
      {session.status !== 'SETTLED' && (
        <Button onClick={confirm} disabled={!online || busy || !quoteId}>
          {busy ? 'Confirming…' : 'Authorize payment'}
        </Button>
      )}
      {session.status === 'SETTLED' && <Alert tone="success">Payment settled.</Alert>}
    </div>
  );
}
