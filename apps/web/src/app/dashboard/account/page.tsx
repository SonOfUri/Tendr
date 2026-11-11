'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Alert, Button, StatusBadge } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import {
  Check,
  ChevronRight,
  CircleCheck,
  Crown,
  FlaskConical,
  Radio,
  Shield,
  UserRound,
  Wallet,
  RefreshCw,
  Rocket,
} from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { TokenLogo } from '@/components/dashboard/asset-logos';
import { NativeWalletSetup } from '@/components/dashboard/NativeWallet';
import { CopyableId } from '@/components/dashboard/CopyableId';
import { EmptyState, ErrorState, PageHeader, Panel, Stat } from '@/components/dashboard/ui';
import { api, errorMessage, type AccountView, type Balances, type GoLiveStatus } from '@/lib/api';
import { assetInfo, formatAmount } from '@/lib/assets';
import { toast } from '@/components/toast';
import { withStepUp } from '@/lib/webauthn';

function roleIcon(role: string | null | undefined) {
  const r = (role ?? '').toLowerCase();
  if (r === 'owner') return <Crown size={14} strokeWidth={2} aria-hidden />;
  if (r === 'admin') return <Shield size={14} strokeWidth={2} aria-hidden />;
  return <UserRound size={14} strokeWidth={2} aria-hidden />;
}

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

type StepTone = 'passkey' | 'second' | 'rule' | 'payout';

interface GoLiveStep {
  id: string;
  tone: StepTone;
  label: string;
  detail: string;
  done: boolean;
  href?: string;
  action?: string;
}

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
      missing: ['second_key', 'payout'],
      signerCount: 1,
      recoveryKeySet: false,
    },
    live: null,
  },
};

export default function AccountHomePage() {
  const { store, context, uiPreview, me } = useDashboard();
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
      const message = errorMessage(err);
      setError(message);
      toast.error(message);
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
    try {
      await withStepUp(fn);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
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
        <PageSkeleton label="Loading your account" />
      </div>
    );
  }

  const isOwner = store.role === 'owner';
  const { checklist, live } = home.goLive;
  const allReady = home.test.account?.status === 'active' && (!live || live.status === 'active');
  const liveModeBlocked = checklist.missing.includes('live_mode_unavailable');
  const nativeLive =
    home.live.account?.kind === 'native_intents' ||
    (!home.live.account && home.goLive.accountKind === 'native_intents');
  const goLiveComplete = Boolean(live) && checklist.ok && !liveModeBlocked;
  const livePayoutPending = Boolean(live) && checklist.missing.includes('payout');

  const walletActive = home.live.account?.status === 'active';
  const steps: GoLiveStep[] = nativeLive
    ? [
        {
          id: 'passkey',
          tone: 'passkey',
          label: 'Your passkey',
          detail: 'You sign in and approve with it.',
          done: true,
        },
        {
          id: 'wallet_passkey',
          tone: 'second',
          label: 'Wallet passkey',
          detail: walletActive
            ? 'Live wallet is active. Withdrawals and settlement use this passkey.'
            : home.live.nativeWallet
              ? 'Finish activation with the wallet passkey. That does not move any money.'
              : 'Create the wallet passkey, then activate. Activation does not move any money.',
          done: !checklist.missing.includes('wallet_passkey'),
          href: walletActive ? '/dashboard/wallet' : undefined,
          action: 'Open wallet',
        },
        {
          id: 'payout',
          tone: 'payout',
          label: 'Default settlement',
          detail:
            'Choose the default settlement token on the wallet page — payment links need this.',
          done: !checklist.missing.includes('payout'),
          href: '/dashboard/wallet',
          action: 'Set settlement',
        },
      ]
    : [
        {
          id: 'passkey',
          tone: 'passkey',
          label: 'Your passkey',
          detail: 'You sign in and approve with it.',
          done: true,
        },
        {
          id: 'second_key',
          tone: 'second',
          label: 'A second key',
          detail: `${checklist.signerCount} signer${checklist.signerCount === 1 ? '' : 's'}${
            checklist.recoveryKeySet ? ' and a recovery kit' : ', no recovery kit yet'
          }.`,
          done: !checklist.missing.includes('second_key'),
          href: '/dashboard/onboarding/second-key',
          action: 'Add one',
        },
        {
          id: 'threshold',
          tone: 'rule',
          label: 'Approval rule',
          detail: 'One signer’s approval moves money to start with; you can require more later.',
          done: !checklist.missing.includes('threshold'),
          href: '/dashboard/security#approval-rule',
          action: 'Set the rule',
        },
        {
          id: 'payout',
          tone: 'payout',
          label: livePayoutPending ? 'Live payout' : 'Approve payout',
          detail: livePayoutPending
            ? 'Choose where live payments settle, then approve with your passkey.'
            : 'Choose the default settlement token and approve it — payment links need this.',
          done: !checklist.missing.includes('payout'),
          href: '/dashboard/settings/payout',
          action: 'Set payout',
        },
      ];

  const currentIndex = steps.findIndex((s) => !s.done);
  const needsWalletSetup = nativeLive && checklist.missing.includes('wallet_passkey');

  return (
    <>
      <PageHeader
        title={store.name}
        description="Account readiness, balances, and go-live for this business. Test and live stay separate."
      />

      {allReady && live?.status === 'active' && checklist.ok ? (
        <Alert tone="success">Account ready.</Alert>
      ) : null}
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
          icon={roleIcon(store.role)}
          value={store.role ? store.role.charAt(0).toUpperCase() + store.role.slice(1) : store.role}
          hint={store.isSigner ? 'Signer on this business' : 'Not a signer'}
        />
        <Stat
          label="Test"
          icon={<FlaskConical size={14} strokeWidth={2} aria-hidden />}
          value={STATUS_WORDS[home.test.account?.status ?? ''] ?? home.test.account?.status ?? '—'}
          hint={home.test.account ? 'Provisioned' : 'Not created'}
        />
        <Stat
          label="Live"
          icon={<Radio size={14} strokeWidth={2} aria-hidden />}
          value={
            live
              ? (STATUS_WORDS[live.status] ?? live.status)
              : liveModeBlocked
                ? 'Unavailable'
                : 'Not yet'
          }
          hint={
            live ? (
              <CopyableId value={live.nearAccountId} label="Copy account id" />
            ) : (
              'Complete go-live when ready'
            )
          }
        />
      </div>

      <div className="dash-account-grid">
        <AccountCard
          title={
            <span className="dash-panel-title-with-icon">
              <FlaskConical size={16} strokeWidth={2} aria-hidden />
              Test account
            </span>
          }
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
          title={
            <span className="dash-panel-title-with-icon">
              <Radio size={16} strokeWidth={2} aria-hidden />
              Live account
            </span>
          }
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
        {goLiveComplete && live ? (
          <div className="dash-golive-ready">
            <span className="dash-golive-ready-mark" aria-hidden>
              <CircleCheck size={22} strokeWidth={1.85} />
            </span>
            <div className="dash-golive-ready-copy">
              <strong>
                Live account {(STATUS_WORDS[live.status] ?? live.status).toLowerCase()}
              </strong>
              <p className="dash-muted dash-small">
                <CopyableId value={live.nearAccountId} label="Copy account id" />
                {nativeLive ? (
                  <>
                    {' '}
                    · Settlement and withdrawals are on the{' '}
                    <Link href="/dashboard/wallet">wallet page</Link>.
                  </>
                ) : null}
              </p>
            </div>
          </div>
        ) : (
          <>
            {liveModeBlocked ? (
              <Alert tone="warning">
                Live payments are unavailable on this deployment. The checklist below still applies
                when live mode is enabled.
              </Alert>
            ) : null}
            {live && live.status !== 'active' && !nativeLive ? (
              <div className="dash-golive-ready" style={{ marginBottom: '1rem' }}>
                <span className="dash-golive-ready-mark" aria-hidden>
                  <CircleCheck size={22} strokeWidth={1.85} />
                </span>
                <div className="dash-golive-ready-copy">
                  <strong>
                    Live account {(STATUS_WORDS[live.status] ?? live.status).toLowerCase()}
                  </strong>
                  <p className="dash-muted dash-small">
                    <CopyableId value={live.nearAccountId} label="Copy account id" />
                  </p>
                </div>
              </div>
            ) : null}
            <p className="dash-golive-lead">Finish these steps before real money can move.</p>
            <ol className="dash-golive-stepper" aria-label="Go live steps">
              {steps.map((step, index) => {
                const current = index === currentIndex;
                const body = (
                  <>
                    <span className="dash-golive-step-rail" aria-hidden>
                      <span className="dash-golive-step-dot">
                        {step.done ? <Check size={14} strokeWidth={2.75} /> : (
                          <span className="dash-golive-step-num">{index + 1}</span>
                        )}
                      </span>
                      {index < steps.length - 1 ? <span className="dash-golive-step-line" /> : null}
                    </span>
                    <span className="dash-golive-step-card">
                      <span className="dash-golive-step-copy">
                        <strong>{step.label}</strong>
                        <span className="sr-only">
                          {step.done ? ' (done)' : current ? ' (current)' : ' (to do)'}
                        </span>
                        <p className="dash-muted dash-small">{step.detail}</p>
                      </span>
                      {step.href ? (
                        <span className="dash-golive-step-go">
                          {step.done ? 'Review' : step.action}
                          <ChevronRight size={16} strokeWidth={2.25} aria-hidden />
                        </span>
                      ) : null}
                    </span>
                  </>
                );
                return (
                  <li
                    key={step.id}
                    className="dash-golive-step"
                    data-tone={step.tone}
                    data-done={step.done ? 'true' : 'false'}
                    data-current={current ? 'true' : 'false'}
                    style={{ '--step-i': index } as CSSProperties}
                  >
                    {step.href ? (
                      <Link href={step.href} className="dash-golive-step-link">
                        {body}
                      </Link>
                    ) : (
                      <div className="dash-golive-step-link dash-golive-step-link--static">{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
            {needsWalletSetup ? (
              <div className="dash-golive-wallet-setup">
                <NativeWalletSetup
                  view={home.live}
                  status={home.goLive}
                  store={{ merchantId: store.id, livemode: true }}
                  userId={me.user.id}
                  isOwner={isOwner}
                  onDone={() => void load()}
                />
              </div>
            ) : null}
            <div className="dash-golive-actions">
              {!nativeLive && !live && isOwner ? (
                <Button
                  className="dash-btn-icon"
                  disabled={!checklist.ok || busy}
                  onClick={() =>
                    act(() =>
                      api('/v1/account/go-live', { method: 'POST', json: {}, livemode: false }),
                    )
                  }
                >
                  {busy ? (
                    'Working…'
                  ) : (
                    <>
                      <Rocket size={16} strokeWidth={1.75} aria-hidden />
                      Go live
                    </>
                  )}
                </Button>
              ) : null}
              {!nativeLive && !live && !isOwner ? (
                <p className="dash-muted dash-small">Only the business owner can go live.</p>
              ) : null}
              {!checklist.ok ? (
                <p className="dash-muted dash-small">
                  {needsWalletSetup
                    ? 'Activate the wallet passkey to continue.'
                    : livePayoutPending || checklist.missing.includes('payout')
                      ? 'Set default settlement on the wallet page to finish.'
                      : 'Finish the steps to go live.'}
                </p>
              ) : null}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}

/** Truncate long intents asset ids for narrow cards; full id stays on `title`. */
function shortAssetId(asset: string): string {
  const t = asset.trim();
  if (t.length <= 28) return t;
  return `${t.slice(0, 14)}…${t.slice(-10)}`;
}

function AccountCard({
  title,
  view,
  balances,
  note,
  onRetry,
  busy,
}: {
  title: ReactNode;
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
        <p className="dash-small">
          <CopyableId value={a.nearAccountId} label="Copy account id" />
        </p>
      ) : (
        <p className="dash-muted">Not created yet.</p>
      )}
      <p className="dash-muted dash-small">{note}</p>
      {a?.status === 'active' ? (
        balances.balances.length === 0 ? (
          <EmptyState
            icon={<Wallet size={22} strokeWidth={1.75} />}
            title="No balances yet"
            description="Settled funds will show here."
          />
        ) : (
          <ul className="dash-balance-list">
            {balances.balances.map((b) => {
              const info = assetInfo(b.asset, livemode);
              const label = info.known ? info.symbol : shortAssetId(b.asset);
              const amount = info.known
                ? formatAmount(b.asset, b.amount, livemode)
                : `${b.amount} units`;
              return (
                <li key={b.asset} className="dash-balance-row">
                  <span className="dash-balance-asset dash-muted dash-small" title={b.asset}>
                    <span className="dash-balance-asset-main">
                      <TokenLogo
                        symbol={info.known ? info.symbol : b.asset}
                        assetId={b.asset}
                        size={22}
                      />
                      <span>{label}</span>
                    </span>
                  </span>
                  <strong className="dash-balance-amt" title={formatAmount(b.asset, b.amount, livemode)}>
                    {amount}
                  </strong>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {a?.status === 'failed' && onRetry ? (
        <Button variant="secondary" className="dash-btn-icon" onClick={onRetry} disabled={busy}>
          {busy ? (
            'Try setup again'
          ) : (
            <>
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              Try setup again
            </>
          )}
        </Button>
      ) : null}
    </Panel>
  );
}
