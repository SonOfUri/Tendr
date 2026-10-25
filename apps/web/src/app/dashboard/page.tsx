'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spinner, StatusBadge } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { api, errorMessage, type AccountView, type Balances, type GoLiveStatus } from '@/lib/api';
import { withStepUp } from '@/lib/webauthn';

interface Home {
  test: AccountView;
  live: AccountView;
  testBalances: Balances;
  liveBalances: Balances;
  goLive: GoLiveStatus;
}

const STATUS_WORDS: Record<string, string> = {
  provisioning: 'Being set up',
  active: 'Ready',
  failed: 'Setup failed',
};

export default function AccountHomePage() {
  const { store, context } = useDashboard();
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const merchantId = context?.merchantId;
  const load = useCallback(async () => {
    if (!merchantId) return;
    try {
      const [test, live, testBalances, liveBalances, goLive] = await Promise.all([
        api<AccountView>('/v1/account', { livemode: false }),
        api<AccountView>('/v1/account', { livemode: true }),
        api<Balances>('/v1/account/balances', { livemode: false }),
        api<Balances>('/v1/account/balances', { livemode: true }),
        api<GoLiveStatus>('/v1/account/go-live', { livemode: false }),
      ]);
      setHome({ test, live, testBalances, liveBalances, goLive });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [merchantId]);

  useEffect(() => {
    setHome(null);
    void load();
  }, [load]);

  // While an account is being set up, check again every few seconds.
  const settingUp =
    home?.test.account?.status === 'provisioning' || home?.goLive.live?.status === 'provisioning';
  useEffect(() => {
    if (!settingUp) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [settingUp, load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await withStepUp(fn);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!store) return null;
  if (!home) {
    return error ? <Alert tone="danger">{error}</Alert> : <Spinner label="Loading your account" />;
  }

  const isOwner = store.role === 'owner';
  const { checklist, live } = home.goLive;
  const allReady = home.test.account?.status === 'active' && (!live || live.status === 'active');

  return (
    <div className="stack">
      <div>
        <h1>{store.name}</h1>
        {allReady && live?.status === 'active' && <Alert tone="success">Account ready.</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>

      <div className="grid-2">
        <AccountCard
          title="Test account"
          view={home.test}
          balances={home.testBalances}
          note="Test money only. Try payments here first."
          onRetry={
            isOwner && home.test.account?.status === 'failed'
              ? () =>
                  act(() => api('/v1/account/retry', { method: 'POST', json: {}, livemode: false }))
              : undefined
          }
          busy={busy}
        />
        <AccountCard
          title="Live account"
          view={home.live}
          balances={home.liveBalances}
          note={live ? 'Real money.' : 'Created when you go live.'}
          onRetry={
            isOwner && home.live.account?.status === 'failed'
              ? () =>
                  act(() => api('/v1/account/retry', { method: 'POST', json: {}, livemode: true }))
              : undefined
          }
          busy={busy}
        />
      </div>

      <section className="card">
        <h2>Go live</h2>
        {live ? (
          <p>
            Your live account <code>{live.nearAccountId}</code> is{' '}
            <strong>{(STATUS_WORDS[live.status] ?? live.status).toLowerCase()}</strong>.
          </p>
        ) : (
          <>
            <ul className="checklist">
              <ChecklistItem done label="Your passkey">
                You sign in and approve with it.
              </ChecklistItem>
              <ChecklistItem done={!checklist.missing.includes('second_key')} label="A second key">
                {checklist.signerCount} signer{checklist.signerCount === 1 ? '' : 's'}
                {checklist.recoveryKeySet ? ' and a recovery kit' : ', no recovery kit yet'}.{' '}
                {checklist.missing.includes('second_key') && (
                  <Link href="/dashboard/onboarding/second-key">Add one</Link>
                )}
              </ChecklistItem>
              <ChecklistItem done={!checklist.missing.includes('threshold')} label="Approval rule">
                One signer’s approval moves money to start with; you can require more later.
              </ChecklistItem>
            </ul>
            {isOwner ? (
              <Button
                disabled={!checklist.ok || busy}
                onClick={() =>
                  act(() =>
                    api('/v1/account/go-live', { method: 'POST', json: {}, livemode: false }),
                  )
                }
              >
                {busy ? 'Working…' : 'Go live'}
              </Button>
            ) : (
              <p className="muted small">Only the store owner can go live.</p>
            )}
            {!checklist.ok && <p className="muted small">Finish the checklist to go live.</p>}
          </>
        )}
      </section>
    </div>
  );
}

function AccountCard({
  title,
  view,
  balances,
  note,
  onRetry,
  busy,
}: {
  title: string;
  view: AccountView;
  balances: Balances;
  note: string;
  onRetry?: () => void;
  busy: boolean;
}) {
  const a = view.account;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {a && <StatusBadge status={STATUS_WORDS[a.status] ?? a.status} />}
      </div>
      {a ? (
        <p>
          <code>{a.nearAccountId}</code>
        </p>
      ) : (
        <p className="muted">Not created yet.</p>
      )}
      <p className="muted small">{note}</p>
      {a?.status === 'active' &&
        (balances.balances.length === 0 ? (
          <p className="muted">No money in this account yet.</p>
        ) : (
          <table className="balances">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Amount (smallest unit)</th>
              </tr>
            </thead>
            <tbody>
              {balances.balances.map((b) => (
                <tr key={b.asset}>
                  <td>{b.asset}</td>
                  <td>
                    <code>{b.amount}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {a?.status === 'failed' && onRetry && (
        <Button variant="secondary" onClick={onRetry} disabled={busy}>
          Try setup again
        </Button>
      )}
    </section>
  );
}

function ChecklistItem({
  done,
  label,
  children,
}: {
  done: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className={done ? 'done' : 'todo'}>
      <span aria-hidden>{done ? '✓' : '○'}</span>
      <div>
        <strong>{label}</strong>
        <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
        <p className="muted small">{children}</p>
      </div>
    </li>
  );
}
