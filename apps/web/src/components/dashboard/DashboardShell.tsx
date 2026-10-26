'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { countdown } from '@/lib/actions';
import {
  api,
  errorMessage,
  getStoreContext,
  isSignedOut,
  onSignedOut,
  setCsrfToken,
  setStoreContext,
  type Me,
  type RecoveryRequest,
  type StoreContext,
  type StoreSummary,
} from '@/lib/api';
import { registerPasskey } from '@/lib/webauthn';

interface Dashboard {
  me: Me;
  /** The selected store and mode (per tab), or null when the person has no store yet. */
  context: StoreContext | null;
  store: StoreSummary | null;
  selectStore(ctx: StoreContext): void;
  /** Re-reads the person and their stores (after creating or joining a store). */
  refresh(): Promise<void>;
}

const DashboardContext = createContext<Dashboard | null>(null);

export function useDashboard(): Dashboard {
  const v = useContext(DashboardContext);
  if (!v) throw new Error('useDashboard outside DashboardShell');
  return v;
}

/** A store that matches the tab's saved choice, else the person's first store. */
function pickContext(me: Me): StoreContext | null {
  const saved = getStoreContext();
  if (saved && me.stores.some((s) => s.id === saved.merchantId)) return saved;
  const first = me.stores[0];
  return first ? { merchantId: first.id, livemode: false } : null;
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [context, setContext] = useState<StoreContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Any request that finds the session missing or over (401 UNAUTHENTICATED), on any
  // dashboard page, sends the person to sign in and back here afterwards.
  useEffect(
    () =>
      onSignedOut(() => {
        const here = window.location.pathname + window.location.search;
        router.replace(`/login?next=${encodeURIComponent(here)}`);
      }),
    [router],
  );

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/v1/me', { store: false });
      const ctx = pickContext(m);
      setStoreContext(ctx);
      setContext(ctx);
      setMe(m);
      setError(null);
    } catch (err) {
      // A signed-out answer is handled by the onSignedOut redirect above.
      if (!isSignedOut(err)) setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const needsStore =
    me !== null && me.stores.length === 0 && !pathname.startsWith('/dashboard/onboarding/store');
  useEffect(() => {
    if (needsStore) router.replace('/dashboard/onboarding/store');
  }, [needsStore, router]);

  const selectStore = useCallback((ctx: StoreContext) => {
    setStoreContext(ctx);
    setContext(ctx);
  }, []);

  const value = useMemo<Dashboard | null>(
    () =>
      me
        ? {
            me,
            context,
            store: me.stores.find((s) => s.id === context?.merchantId) ?? null,
            selectStore,
            refresh,
          }
        : null,
    [me, context, selectStore, refresh],
  );

  if (error) {
    return (
      <section className="dash">
        <Alert tone="danger">{error}</Alert>
        <Button variant="secondary" onClick={() => void refresh()}>
          Try again
        </Button>
      </section>
    );
  }
  if (!value || needsStore) {
    return (
      <section className="dash dash-loading">
        <Spinner label="Loading your dashboard" />
      </section>
    );
  }

  return (
    <DashboardContext.Provider value={value}>
      <DashboardHeader />
      <section className="dash">
        {value.me.passkeys.length === 0 ? <PasskeyGate onDone={refresh} /> : children}
      </section>
    </DashboardContext.Provider>
  );
}

function DashboardHeader() {
  const router = useRouter();
  const { me, context, selectStore } = useDashboard();

  async function signOut() {
    try {
      await api('/v1/auth/logout', { method: 'POST', json: {}, store: false });
    } finally {
      setStoreContext(null);
      setCsrfToken(null);
      router.replace('/login');
    }
  }

  return (
    <div className="dash-header">
      <div className="dash-header-group">
        {me.stores.length > 0 && context && (
          <label className="inline-field">
            <span className="sr-only">Store</span>
            <select
              value={context.merchantId}
              onChange={(e) => {
                if (e.target.value === '__new') router.push('/dashboard/onboarding/store');
                else selectStore({ merchantId: e.target.value, livemode: context.livemode });
              }}
            >
              {me.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="__new">+ New store</option>
            </select>
          </label>
        )}
        {context && (
          <div className="mode-switch" role="group" aria-label="Mode">
            <button
              type="button"
              aria-pressed={!context.livemode}
              onClick={() => selectStore({ ...context, livemode: false })}
            >
              Test
            </button>
            <button
              type="button"
              aria-pressed={context.livemode}
              onClick={() => selectStore({ ...context, livemode: true })}
            >
              Live
            </button>
          </div>
        )}
      </div>
      <div className="dash-header-group">
        <Link href="/dashboard" className="muted small">
          Account
        </Link>
        <span className="muted small">{me.user.email}</span>
        <button type="button" className="link-button small" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <DashboardNav />
      <RecoveryBanner />
      {context?.livemode === false && (
        <p className="test-banner">Test mode — nothing here moves real money.</p>
      )}
    </div>
  );
}

const NAV: { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Account' },
  { href: '/dashboard/payments', label: 'Payments' },
  { href: '/dashboard/review', label: 'Review' },
  { href: '/dashboard/approvals', label: 'Approvals' },
  { href: '/dashboard/withdraw', label: 'Withdraw' },
  { href: '/dashboard/addresses', label: 'Saved addresses' },
  { href: '/dashboard/webhooks', label: 'Webhooks' },
  { href: '/dashboard/settings/checkout', label: 'Checkout settings' },
  { href: '/dashboard/team', label: 'Team' },
  { href: '/dashboard/security', label: 'Security' },
  { href: '/dashboard/recovery', label: 'Recovery' },
];

function DashboardNav() {
  const pathname = usePathname();
  const { store } = useDashboard();
  if (!store) return null;
  return (
    <nav className="dash-nav" aria-label="Dashboard">
      {NAV.map((n) => {
        const current = n.href === '/dashboard' ? pathname === n.href : pathname.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} aria-current={current ? 'page' : undefined}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Shown on every dashboard page while a recovery of the store's LIVE account is pending (a
 * recovery kit only exists for the live account): anyone who did not start it should cancel it
 * before it executes.
 */
function RecoveryBanner() {
  const { store } = useDashboard();
  const [recovery, setRecovery] = useState<RecoveryRequest | null>(null);
  const merchantId = store?.id;
  useEffect(() => {
    if (!merchantId) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await api<{ recovery: RecoveryRequest | null }>('/v1/account/recovery', {
          livemode: true,
        });
        if (alive) setRecovery(r.recovery?.status === 'pending' ? r.recovery : null);
      } catch {
        // The banner is advisory; the recovery page shows errors.
      }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [merchantId]);
  if (!recovery) return null;
  return (
    <p className="recovery-banner" role="alert">
      <strong>A recovery of your live account is pending.</strong> It replaces every signer in{' '}
      {countdown(recovery.executesAt)}. If nobody on your team started it,{' '}
      <Link href="/dashboard/recovery">cancel it now</Link>.
    </p>
  );
}

/** A signed-in person with no passkey yet (they left after confirming their email). */
function PasskeyGate({ onDone }: { onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey();
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <h1>Create your passkey</h1>
      <p className="muted">
        You need a passkey before you can use your store. Your device will ask for Face ID, Touch
        ID, Windows Hello or its PIN.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button onClick={create} disabled={busy}>
        {busy ? 'Waiting for your device…' : 'Create my passkey'}
      </Button>
    </div>
  );
}
