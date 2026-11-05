'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import {
  ArrowUpFromLine,
  CheckCircle2,
  CreditCard,
  FlaskConical,
  Globe,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  PanelLeft,
  PanelLeftClose,
  MapPin,
  Menu,
  Palette,
  Radio,
  SearchCheck,
  Settings2,
  Shield,
  Building2,
  Users,
  Wallet,
  Webhook,
  X,
  type LucideProps,
} from 'lucide-react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { TendrLogo } from '@/components/TendrLogo';
import { ThemeMenu } from '@/components/ThemeToggle';
import { Select } from '@/components/dashboard/Select';
import { countdown } from '@/lib/actions';
import {
  ApiError,
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
import { linkedStore, withoutStoreLink } from '@/lib/store-link';
import { registerPasskey } from '@/lib/webauthn';

interface Dashboard {
  me: Me;
  /** The selected store and mode (per tab), or null when the person has no store yet. */
  context: StoreContext | null;
  store: StoreSummary | null;
  selectStore(ctx: StoreContext): void;
  /** Re-reads the person and their stores (after creating or joining a store). */
  refresh(): Promise<void>;
  /** True when the shell is rendering without a live API (UI review). */
  uiPreview: boolean;
  /** Next sign-out should leave preview and go to /login. */
  endPreviewSession(): void;
}

/** Local-only merchant so the dashboard chrome is reviewable when the API is down. */
const PREVIEW_ME: Me = {
  user: {
    id: 'usr_preview',
    email: 'preview@usetendr.tech',
    emailVerifiedAt: '2026-01-01T00:00:00.000Z',
  },
  stores: [
    {
      id: 'mer_preview',
      name: 'Preview Business',
      slug: 'preview-business',
      status: 'active',
      membershipId: 'mem_preview',
      role: 'owner',
      isSigner: true,
    },
  ],
  passkeys: [
    {
      id: 'pk_preview',
      deviceLabel: 'Preview',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    },
  ],
};

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

type NavIcon = ComponentType<LucideProps>;
type NavItem = { href: string; label: string; icon: NavIcon };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/dashboard', label: 'Account', icon: LayoutDashboard }],
  },
  {
    label: 'Money',
    items: [
      { href: '/dashboard/payments', label: 'Payments', icon: CreditCard },
      { href: '/dashboard/payment-links', label: 'Payment links', icon: Link2 },
      { href: '/dashboard/review', label: 'Review', icon: SearchCheck },
      { href: '/dashboard/approvals', label: 'Approvals', icon: CheckCircle2 },
      { href: '/dashboard/withdraw', label: 'Withdraw', icon: ArrowUpFromLine },
      { href: '/dashboard/addresses', label: 'Saved addresses', icon: MapPin },
    ],
  },
  {
    label: 'Checkout',
    items: [
      { href: '/dashboard/settings/checkout', label: 'Checkout settings', icon: Settings2 },
      { href: '/dashboard/settings/themes', label: 'Themes', icon: Palette },
      { href: '/dashboard/settings/connected-sites', label: 'Connected sites', icon: Globe },
      { href: '/dashboard/settings/payout', label: 'Payout', icon: Wallet },
    ],
  },
  {
    label: 'Business',
    items: [
      { href: '/dashboard/team', label: 'Team', icon: Users },
      { href: '/dashboard/webhooks', label: 'Webhooks', icon: Webhook },
      { href: '/dashboard/security', label: 'Security', icon: Shield },
      { href: '/dashboard/recovery', label: 'Recovery', icon: KeyRound },
    ],
  },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [context, setContext] = useState<StoreContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFoundAt, setNotFoundAt] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [uiPreview, setUiPreview] = useState(false);
  /** When true, missing session / API falls into UI preview instead of /login. */
  const allowPreviewRef = useRef(true);

  const enterPreview = useCallback(() => {
    const m = PREVIEW_ME;
    const ctx = pickContext(m) ?? { merchantId: m.stores[0]!.id, livemode: false };
    setStoreContext(ctx);
    setContext(ctx);
    setMe(m);
    setUiPreview(true);
    setError(null);
  }, []);

  useEffect(
    () =>
      onSignedOut(() => {
        if (allowPreviewRef.current) {
          enterPreview();
          return;
        }
        const here = window.location.pathname + window.location.search;
        router.replace(`/login?next=${encodeURIComponent(here)}`);
      }),
    [router, enterPreview],
  );

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/v1/me', { store: false });
      const { pathname: path, search } = window.location;
      const link = linkedStore(search, m.stores);
      const ctx = link.kind === 'switch' ? link.ctx : pickContext(m);
      if (link.kind !== 'none') {
        setNotFoundAt(link.kind === 'not-found' ? path : null);
        window.history.replaceState(window.history.state, '', withoutStoreLink(path, search));
      }
      setStoreContext(ctx);
      setContext(ctx);
      setMe(m);
      setUiPreview(false);
      setError(null);
    } catch (err) {
      if (isSignedOut(err) || (err instanceof ApiError && err.code === 'NETWORK_ERROR')) {
        enterPreview();
        return;
      }
      if (!isSignedOut(err)) setError(errorMessage(err));
    }
  }, [enterPreview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('tendr-sidebar') === 'collapsed');
    } catch {
      // Private mode: leave the sidebar expanded.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem('tendr-sidebar', next ? 'collapsed' : 'expanded');
      } catch {
        // Private mode: the choice lasts for this visit only.
      }
      return next;
    });
  }

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const needsStore =
    me !== null && me.stores.length === 0 && !pathname.startsWith('/dashboard/onboarding/store');
  useEffect(() => {
    if (needsStore) router.replace('/dashboard/onboarding/store');
  }, [needsStore, router]);

  const selectStore = useCallback((ctx: StoreContext) => {
    setStoreContext(ctx);
    setContext(ctx);
  }, []);

  const endPreviewSession = useCallback(() => {
    allowPreviewRef.current = false;
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
            uiPreview,
            endPreviewSession,
          }
        : null,
    [me, context, selectStore, refresh, uiPreview, endPreviewSession],
  );

  if (error) {
    return (
      <div className="dash-app dash-app--boot">
        <div className="dash-loading-screen">
          <Alert tone="danger">{error}</Alert>
          <div className="dash-page-actions">
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
            <Button variant="ghost" onClick={enterPreview}>
              Open UI preview
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (!value || needsStore) {
    return (
      <div className="dash-app dash-app--boot">
        <div className="dash-loading-screen">
          <Spinner label="Loading your dashboard" />
        </div>
      </div>
    );
  }

  return (
    <DashboardContext.Provider value={value}>
      <div
        className="dash-app"
        data-nav-open={navOpen ? 'true' : 'false'}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-preview={uiPreview ? 'true' : 'false'}
      >
        <DashboardTopBar navOpen={navOpen} onToggleNav={() => setNavOpen((v) => !v)} />
        <div className="dash-banners">
          {!uiPreview ? <RecoveryBanner /> : null}
          {value.context?.livemode === false ? (
            <p className="dash-test-banner">Test mode — nothing here moves real money.</p>
          ) : null}
        </div>
        <button
          type="button"
          className="dash-backdrop"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
        <DashboardSidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        <main className="dash-main">
          <div className="dash-main-inner">
            {value.me.passkeys.length === 0 ? (
              <PasskeyGate onDone={refresh} />
            ) : notFoundAt === pathname ? (
              <LinkNotFound />
            ) : (
              children
            )}
          </div>
        </main>
      </div>
    </DashboardContext.Provider>
  );
}

async function performSignOut(opts: {
  uiPreview: boolean;
  endPreviewSession: () => void;
  router: ReturnType<typeof useRouter>;
}) {
  opts.endPreviewSession();
  try {
    if (!opts.uiPreview) {
      await api('/v1/auth/logout', { method: 'POST', json: {}, store: false });
    }
  } finally {
    setStoreContext(null);
    setCsrfToken(null);
    opts.router.replace('/login');
  }
}

function DashboardTopBar({
  navOpen,
  onToggleNav,
}: {
  navOpen: boolean;
  onToggleNav: () => void;
}) {
  const router = useRouter();
  const { me, context, selectStore } = useDashboard();

  return (
    <header className="dash-top">
      <div className="dash-top-left">
        <button
          type="button"
          className="dash-menu-btn"
          aria-expanded={navOpen}
          aria-controls="dash-sidebar"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          onClick={onToggleNav}
        >
          {navOpen ? <X size={18} strokeWidth={1.85} /> : <Menu size={18} strokeWidth={1.85} />}
        </button>
        <Link href="/dashboard" className="dash-top-brand">
          <span className="dash-top-brand-mark-wrap">
            <TendrLogo size={22} className="dash-top-brand-mark" />
          </span>
          <span className="dash-top-brand-copy">
            <span className="dash-top-brand-name">Tendr</span>
            <span className="dash-top-brand-sub">Merchant dashboard</span>
          </span>
        </Link>
      </div>

      <div className="dash-top-right">
        {me.stores.length > 0 && context ? (
          <Select
            variant="pill"
            ariaLabel="Business"
            value={context.merchantId}
            leading={<Building2 size={15} strokeWidth={1.85} />}
            options={[
              ...me.stores.map((s) => ({ value: s.id, label: s.name })),
              { value: '__new', label: '+ New business' },
            ]}
            onChange={(next) => {
              if (next === '__new') router.push('/dashboard/onboarding/store');
              else selectStore({ merchantId: next, livemode: context.livemode });
            }}
          />
        ) : null}

        {context ? (
          <div className="dash-mode" role="group" aria-label="Mode">
            <button
              type="button"
              className="dash-mode-btn"
              aria-pressed={!context.livemode}
              onClick={() => selectStore({ ...context, livemode: false })}
            >
              <FlaskConical size={14} strokeWidth={1.85} aria-hidden />
              Test
            </button>
            <button
              type="button"
              className="dash-mode-btn"
              aria-pressed={context.livemode}
              onClick={() => selectStore({ ...context, livemode: true })}
            >
              <Radio size={14} strokeWidth={1.85} aria-hidden />
              Live
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function DashboardSidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, store, uiPreview, endPreviewSession } = useDashboard();
  if (!store) {
    return (
      <aside id="dash-sidebar" className="dash-sidebar" aria-label="Dashboard">
        <SidebarHead collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
        <div className="dash-sidebar-theme">
          <ThemeMenu />
        </div>
      </aside>
    );
  }

  const initials = (me.user.email?.[0] ?? 'T').toUpperCase();

  return (
    <aside id="dash-sidebar" className="dash-sidebar" aria-label="Dashboard">
      <SidebarHead collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
      <div className="dash-sidebar-scroll">
        <nav className="dash-sidebar-nav">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="dash-nav-group">
              <span className="dash-nav-label">{group.label}</span>
              <ul className="dash-nav-list">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const current =
                    item.href === '/dashboard'
                      ? pathname === item.href
                      : pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="dash-nav-link"
                        title={item.label}
                        aria-current={current ? 'page' : undefined}
                      >
                        <span className="dash-nav-icon" aria-hidden>
                          <Icon size={17} strokeWidth={1.75} />
                        </span>
                        <span className="dash-nav-text">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="dash-sidebar-banner">
        <img
          className="dash-sidebar-banner-art dash-sidebar-banner-art--on-dark"
          src="/onboarding-bg-image.png"
          alt=""
        />
        <img
          className="dash-sidebar-banner-art dash-sidebar-banner-art--on-light"
          src="/onboarding-bg-image-light.png"
          alt=""
        />
        <div className="dash-sidebar-banner-scrim" aria-hidden />
        <div className="dash-sidebar-account">
          <span className="dash-sidebar-avatar" aria-hidden>
            {initials}
          </span>
          <div className="dash-sidebar-account-copy">
            <p className="dash-sidebar-account-email" title={me.user.email}>
              {me.user.email}
            </p>
            <p className="dash-sidebar-account-role">
              {store.name} · {store.role}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="dash-sidebar-signout"
          onClick={() =>
            void performSignOut({ uiPreview, endPreviewSession, router })
          }
        >
          <LogOut size={16} strokeWidth={1.85} aria-hidden />
          <span>Sign out</span>
        </button>
      </div>

      <div className="dash-sidebar-theme">
        <ThemeMenu />
      </div>
    </aside>
  );
}

function SidebarHead({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div className="dash-sidebar-head">
      <Link href="/dashboard" className="dash-sidebar-logo" aria-label="Tendr">
        <img className="dash-sidebar-logo-mark dash-sidebar-logo-mark--on-dark" src="/logo-white.png" alt="" />
        <img className="dash-sidebar-logo-mark dash-sidebar-logo-mark--on-light" src="/logo-black.png" alt="" />
      </Link>
      <button
        type="button"
        className="dash-sidebar-collapse"
        aria-pressed={collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={onToggleCollapsed}
      >
        {collapsed ? (
          <PanelLeft size={18} strokeWidth={1.75} />
        ) : (
          <PanelLeftClose size={18} strokeWidth={1.75} />
        )}
      </button>
    </div>
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
    <p className="dash-recovery-banner" role="alert">
      <strong>A recovery of your live account is pending.</strong> It replaces every signer in{' '}
      {countdown(recovery.executesAt)}. If nobody on your team started it,{' '}
      <Link href="/dashboard/recovery">cancel it now</Link>.
    </p>
  );
}

/** A link to a business the person is not a member of (never says whether that business exists). */
function LinkNotFound() {
  return (
    <div className="dash-panel">
      <h1 className="dash-page-title">Page not found</h1>
      <p className="dash-muted">
        This link is for a business you are not a member of, or it is no longer valid. If you have
        more than one Tendr login, sign in with the one that belongs to that business.
      </p>
      <p>
        <Link href="/dashboard" className="dash-text-link">
          Go to your account
        </Link>
      </p>
    </div>
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
    <div className="dash-panel">
      <h1 className="dash-page-title">Create your passkey</h1>
      <p className="dash-muted">
        You need a passkey before you can use your business on Tendr. Your device will ask for Face
        ID, Touch ID, Windows Hello or its PIN.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button onClick={create} disabled={busy}>
        {busy ? 'Waiting for your device…' : 'Create my passkey'}
      </Button>
    </div>
  );
}
