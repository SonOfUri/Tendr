'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { api, errorMessage, type StoreSummary } from '@/lib/api';
import { previewSlug } from '@/lib/navigation';

type Created = StoreSummary & { testAccount: { nearAccountId: string; status: string } };

export default function StoreNamePage() {
  const router = useRouter();
  const { me, refresh, selectStore } = useDashboard();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = previewSlug(name);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<Created>('/v1/merchants', {
        method: 'POST',
        json: { name: name.trim() },
        store: false,
      });
      selectStore({ merchantId: res.id, livemode: false });
      await refresh();
      setCreated(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="card">
        <p className="step-label">Step 3 of 3</p>
        <h1>{created.name} is set up</h1>
        <dl className="facts">
          <dt>Store address</dt>
          <dd>
            <code>{created.slug}</code>
          </dd>
          <dt>Test account</dt>
          <dd>
            <code>{created.testAccount.nearAccountId}</code>{' '}
            <span className="muted small">
              {created.testAccount.status === 'active' ? 'ready' : 'being set up — about a minute'}
            </span>
          </dd>
        </dl>
        <p className="muted">
          You can try payments in test mode straight away. Before you take real money, add a second
          way to get into your account.
        </p>
        <Button onClick={() => router.push('/dashboard/onboarding/second-key')}>
          Add a second key
        </Button>
      </div>
    );
  }

  return (
    <div className="card">
      <p className="step-label">{me.stores.length === 0 ? 'Step 3 of 3' : 'New store'}</p>
      <h1>Name your store</h1>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Store name</span>
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Coffee"
          />
        </label>
        <dl className="facts">
          <dt>Store address</dt>
          <dd>
            <code>{slug}</code>
          </dd>
          <dt>Test account</dt>
          <dd>
            <code>{slug}.tendr.testnet</code>
          </dd>
        </dl>
        <p className="muted small">
          Your account is where your store’s money is kept. Only you and the people you choose can
          move it — not Tendr. If the address is taken we add a number, like <code>{slug}-2</code>.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create store'}
        </Button>
      </form>
    </div>
  );
}
