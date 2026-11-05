'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spinner, StatusBadge } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { EmptyState, ErrorState, PageHeader, Panel, Stat } from '@/components/dashboard/ui';
import { api, errorMessage, type AccountView, type Balances, type GoLiveStatus } from '@/lib/api';
import { assetInfo, formatAmount } from '@/lib/assets';
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

const PREVIEW_HOME: Home = {
  test: {
    livemode: false,
    account: {
      id: 'acc_preview_test',
      nearAccountId: 'preview-test.near',
      status: 'active',
      threshold: 1,
      signerEpoch: '1',
    },
    signers: [{ userId: 'usr_preview', email: 'preview@usetendr.tech', keys: 1 }],
  },
  live: {
    livemode: true,
    account: null,
    signers: [],
  },
  testBalances: {
    accountId: 'preview-test.near',
    balances: [
      { asset: 'nep141:usdc.fakes.testnet', amount: '125000000' },
      { asset: 'nep141:wrap.testnet', amount: '2500000000000000000000000' },
    ],
  },
  liveBalances: { accountId: null, balances: [] },
  goLive: {
    checklist: {
      ok: false,
      missing: ['second_key'],
      signerCount: 1,
      recoveryKeySet: false,
    },
    live: null,
  },
};

export default function AccountHomePage() {
  const { store, context, uiPreview } = useDashboard();
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const merchantId = context?.merchantId;
  const load = useCallback(async () => {
    if (!merchantId) return;
    if (uiPreview) {
      setHome(PREVIEW_HOME);
      setError(null);
      return;
    }
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
  }, [merchantId, uiPreview]);

  useEffect(() => {
    setHome(null);
    void load();
  }, [load]);

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
    return error ? (
      <ErrorState message={error} onRetry={() => void load()} />
    ) : (
      <div className="dash-loading-screen">
        <Spinner label="Loading your account" />
      </div>
    );
  }

  const isOwner = store.role === 'owner';
  const { checklist, live } = home.goLive;
  const allReady = home.test.account?.status === 'active' && (!live || live.status === 'active');
  const liveModeBlocked = checklist.missing.includes('live_mode_unavailable');

  return (
    <>
      <PageHeader
        title={store.name}
        description="Account readiness, balances, and go-live for this business. Test and live stay separate."
      />

      {allReady && live?.status === 'active' ? (
        <Alert tone="success">Account ready.</Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {[home.test, home.live]
        .filter((v) => v.account?.storageLowAt)
        .map((v) => (
          <Alert key={v.livemode ? 'live' : 'test'} tone="danger">
            <span data-testid={`storage-low-${v.livemode ? 'live' : 'test'}`}>
              The {v.livemode ? 'live' : 'test'} account{' '}
              <span className="dash-mono">{v.account!.nearAccountId}</span> is low on NEAR for storing
              proposals, and Tendr could not top it up automatically. New proposals and approvals may
              fail until it is funded. Contact Tendr support, or send a little NEAR to the account.
            </span>
          </Alert>
        ))}

      <div className="dash-stat-grid">
        <Stat
          label="Role"
          value={store.role}
          hint={store.isSigner ? 'Signer on this business' : 'Not a signer'}
        />
        <Stat
          label="Test"
          value={STATUS_WORDS[home.test.account?.status ?? ''] ?? home.test.account?.status ?? '—'}
          hint={home.test.account ? 'Provisioned' : 'Not created'}
        />
        <Stat
          label="Live"
          value={
            live
              ? (STATUS_WORDS[live.status] ?? live.status)
              : liveModeBlocked
                ? 'Unavailable'
                : 'Not yet'
          }
          hint={live ? live.nearAccountId : 'Complete go-live when ready'}
        />
      </div>

      <div className="dash-account-grid">
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

      <Panel title="Go live">
        {live ? (
          <p className="dash-muted">
            Your live account <span className="dash-mono">{live.nearAccountId}</span> is{' '}
            <strong>{(STATUS_WORDS[live.status] ?? live.status).toLowerCase()}</strong>.
          </p>
        ) : (
          <>
            {liveModeBlocked ? (
              <Alert tone="warning">
                Live payments are unavailable on this deployment. The checklist below still applies
                when live mode is enabled.
              </Alert>
            ) : null}
            <ul className="dash-checklist">
              <ChecklistItem done label="Your passkey">
                You sign in and approve with it.
              </ChecklistItem>
              <ChecklistItem done={!checklist.missing.includes('second_key')} label="A second key">
                {checklist.signerCount} signer{checklist.signerCount === 1 ? '' : 's'}
                {checklist.recoveryKeySet ? ' and a recovery kit' : ', no recovery kit yet'}.{' '}
                {checklist.missing.includes('second_key') ? (
                  <Link href="/dashboard/onboarding/second-key" className="dash-text-link">
                    Add one
                  </Link>
                ) : null}
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
              <p className="dash-muted dash-small">Only the business owner can go live.</p>
            )}
            {!checklist.ok ? (
              <p className="dash-muted dash-small">Finish the checklist to go live.</p>
            ) : null}
          </>
        )}
      </Panel>
    </>
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
  const livemode = Boolean(view.livemode);

  return (
    <Panel
      title={title}
      action={a ? <StatusBadge status={STATUS_WORDS[a.status] ?? a.status} /> : null}
    >
      {a ? (
        <p className="dash-mono dash-small">{a.nearAccountId}</p>
      ) : (
        <p className="dash-muted">Not created yet.</p>
      )}
      <p className="dash-muted dash-small">{note}</p>
      {a?.status === 'active' ? (
        balances.balances.length === 0 ? (
          <EmptyState title="No balances yet" description="Settled funds will show here." />
        ) : (
          <ul className="dash-balance-list">
            {balances.balances.map((b) => {
              const info = assetInfo(b.asset, livemode);
              return (
                <li key={b.asset} className="dash-balance-row">
                  <span className="dash-muted dash-small" title={b.asset}>
                    {info.known ? info.symbol : b.asset}
                  </span>
                  <strong>{formatAmount(b.asset, b.amount, livemode)}</strong>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {a?.status === 'failed' && onRetry ? (
        <Button variant="secondary" onClick={onRetry} disabled={busy}>
          Try setup again
        </Button>
      ) : null}
    </Panel>
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
    <li data-done={done ? 'true' : 'false'}>
      <span className="dash-checklist-mark" aria-hidden>
        {done ? '✓' : '○'}
      </span>
      <div className="dash-checklist-copy">
        <strong>{label}</strong>
        <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
        <p className="dash-muted dash-small">{children}</p>
      </div>
    </li>
  );
}
