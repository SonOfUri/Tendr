'use client';

import { Button } from '@tendr/ui';
import { useState } from 'react';
import type { DemoSlug } from '@/lib/demo';

export function DemoCheckoutButton({ slug }: { slug: DemoSlug }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/demo/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const data = (await res.json()) as { url?: string; error?: { message?: string } };
      if (!res.ok || !data.url) {
        throw new Error(data.error?.message ?? 'Failed to start checkout');
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start checkout');
      setBusy(false);
    }
  }

  return (
    <div>
      <Button onClick={start} disabled={busy}>
        {busy ? 'Opening checkout…' : 'Pay with Tendr'}
      </Button>
      {error && (
        <p role="alert" className="muted" style={{ marginTop: '0.75rem', color: 'var(--tendr-danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
