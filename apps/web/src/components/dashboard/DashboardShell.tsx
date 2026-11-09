'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from 'react';
import {
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
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { ThemeMenu } from '@/components/ThemeToggle';
import { PwaBanners, PwaInstallButton } from '@/components/pwa/PwaInstall';
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
  type AccountView,
  type GoLiveStatus,
  type RecoveryRequest,
  type StoreContext,
  type StoreSummary,
} from '@/lib/api';
import { linkedStore, withoutStoreLink } from '@/lib/store-link';
import { toast } from '@/components/toast';
import { registerPasskey } from '@/lib/webauthn';

interface Dashboard {
  me: Me;
  /** The selected store and mode (per tab), or null when the person has no store yet. */
  context: StoreContext | null;
  store: StoreSummary | null;
  selectStore(ctx: StoreContext): void;
  /** Re-reads the person and their stores (after creating or joining a store). */
  refresh(): Promise<void>;
  /** Always false; kept for callers that still branch on preview chrome. */
  uiPreview: boolean;
  /** No-op; preview sessions are no longer used. */
  endPreviewSession(): void;
  /** Current mode uses a single-owner Intents wallet. */
  nativeWallet: boolean;
  /** The live account is, or will be, a single-owner Intents wallet. */
  nativeLive: boolean;
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

type NavIcon = ComponentType<LucideProps>;
type NavItem = { href: string; label: string; icon: NavIcon };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
      { href: '/dashboard/account', label: 'Account', icon: Building2 },
    ],
  },
  {
    label: 'Money',
    items: [
      { href: '/dashboard/payments', label: 'Payments', icon: CreditCard },
      { href: '/dashboard/invoices', label: 'Invoices', icon: CreditCard },
      { href: '/dashboard/payment-links', label: 'Payment links', icon: Link2 },
      { href: '/dashboard/review', label: 'Review', icon: SearchCheck },
      { href: '/dashboard/approvals', label: 'Approvals', icon: CheckCircle2 },
      { href: '/dashboard/wallet', label: 'Wallet', icon: Wallet },
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
      { href: '/dashboard/api-keys', label: 'API keys', icon: KeyRound },
      { href: '/dashboard/security', label: 'Security', icon: Shield },
      { href: '/dashboard/recovery', label: 'Recovery', icon: KeyRound },
    ],
  },
];

/** Local API workbench — development, or when the console launcher sets the public flag. */
const API_CONSOLE_NAV: NavGroup = {
  label: 'Developer',
  items: [{ href: '/settings/api-console', label: 'API console', icon: FlaskConical }],
};

function navGroups(): NavGroup[] {
  const consoleOn =
    process.env.NODE_ENV === 'development' ||
    process.env.NEXT_PUBLIC_API_CONSOLE_ENABLED === 'true';
  return consoleOn ? [...NAV_GROUPS, API_CONSOLE_NAV] : NAV_GROUPS;
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [context, setContext] = useState<StoreContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFoundAt, setNotFoundAt] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [native, setNative] = useState({ current: false, live: false });
  const uiPreview = false;

  const goToLogin = useCallback(() => {
    const here = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(here)}`);
  }, [router]);

  useEffect(() => onSignedOut(goToLogin), [goToLogin]);

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
      setError(null);
    } catch (err) {
      if (isSignedOut(err)) return;
      // No offline/fake dashboard: signed-out and unreachable API both go to login.
      if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
        goToLogin();
        return;
      }
      if (!isSignedOut(err)) {
        const message = errorMessage(err);
        setError(message);
        toast.error(message);
      }
    }
  }, [goToLogin]);

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

  const endPreviewSession = useCallback(() => {}, []);

  useEffect(() => {
    if (!context) {
      setNative({ current: false, live: false });
      return;
    }
    const controller = new AbortController();
    const livemode = context.livemode;
    void (async () => {
      try {
        const current = await api<AccountView>('/v1/account', { signal: controller.signal });
        let liveNative = current.account?.kind === 'native_intents';
        if (!livemode || !current.account) {
          if (!livemode) {
            const live = await api<AccountView>('/v1/account', {
              livemode: true,
              signal: controller.signal,
            });
            liveNative = live.account?.kind === 'native_intents';
            if (!live.account) {
              const status = await api<GoLiveStatus>('/v1/account/go-live', {
                signal: controller.signal,
              });
              liveNative = status.accountKind === 'native_intents';
            }
          } else {
            const status = await api<GoLiveStatus>('/v1/account/go-live', {
              signal: controller.signal,
            });
            liveNative = status.accountKind === 'native_intents';
          }
        }
        if (!controller.signal.aborted) {
          setNative({ current: livemode ? liveNative : current.account?.kind === 'native_intents', live: liveNative });
        }
      } catch {
        if (!controller.signal.aborted) setNative({ current: false, live: false });
      }
    })();
    return () => controller.abort();
  }, [context]);

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
            nativeWallet: native.current,
            nativeLive: native.live,
          }
        : null,
    [me, context, selectStore, refresh, uiPreview, endPreviewSession, native],
  );

  if (error) {
    return (
      <div className="dash-app dash-app--boot">
        <div className="dash-loading-screen">
          <p className="dash-muted">{error}</p>
          <div className="dash-page-actions">
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
            <Button variant="ghost" onClick={goToLogin}>
              Back to sign in
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
          <PageSkeleton label="Loading your dashboard" />
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
          <PwaBanners />
          {!uiPreview ? <RecoveryBanner /> : null}
          {value.context?.livemode === false ? (
            <div className="dash-test-banner-slot">
              <div className="dash-test-banner">
                <span className="dash-test-banner-mark" aria-hidden>
                  <FlaskConical size={15} strokeWidth={1.85} />
                </span>
                <p className="dash-test-banner-copy">
                  <strong>Test mode</strong>
                  <span>Nothing here moves real money.</span>
                </p>
              </div>
            </div>
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
            ) : contractRouteBlocked(pathname, native.current, native.live) ? (
              <ContractRouteNotice />
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

function visibleNav(nativeWallet: boolean, nativeLive: boolean): NavGroup[] {
  return navGroups().map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (
        nativeWallet &&
        (item.href === '/dashboard/security' || item.href === '/dashboard/addresses')
      ) {
        return false;
      }
      if (nativeLive && item.href === '/dashboard/recovery') return false;
      return true;
    }),
  })).filter((group) => group.items.length > 0);
}

function contractRouteBlocked(pathname: string, nativeWallet: boolean, nativeLive: boolean): boolean {
  const security =
    pathname === '/dashboard/security' || pathname.startsWith('/dashboard/security/');
  const addresses =
    pathname === '/dashboard/addresses' || pathname.startsWith('/dashboard/addresses/');
  const recovery =
    pathname === '/dashboard/recovery' || pathname.startsWith('/dashboard/recovery/');
  const secondKey = pathname.startsWith('/dashboard/onboarding/second-key');
  return (nativeWallet && (security || addresses)) || (nativeLive && (recovery || secondKey));
}

function ContractRouteNotice() {
  return (
    <section className="dash-panel stack">
      <h1 className="dash-page-title">Single-owner wallet</h1>
      <p className="dash-muted">
        This wallet uses its owner’s passkey. Shared signing, saved-address restrictions, spending
        limits, auto-sweep, and wallet recovery are not available.
      </p>
      <Link href="/dashboard/wallet">Open wallet</Link>
    </section>
  );
}

function pageTitle(pathname: string): string {
  const items = navGroups().flatMap((group) => group.items);
  const exact = items.find((item) => item.href === pathname);
  if (exact) return exact.label;
  if (pathname.startsWith('/dashboard/onboarding/second-key')) return 'Add a second key';
  if (pathname.startsWith('/dashboard/onboarding/store')) return 'New business';
  if (pathname.startsWith('/dashboard/payments/')) return 'Payment';
  if (pathname.startsWith('/dashboard/payment-links/')) return 'Payment link';
  if (pathname.startsWith('/dashboard/approvals/')) return 'Approval';
  if (pathname.startsWith('/dashboard/settings/themes/')) return 'Edit theme';
  const nested = items
    .filter((item) => item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return nested?.label ?? 'Dashboard';
}

function DashboardTopBar({
  navOpen,
  onToggleNav,
}: {
  navOpen: boolean;
  onToggleNav: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { me, context, selectStore } = useDashboard();
  const title = pageTitle(pathname);

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
        <p className="dash-top-title">{title}</p>
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
  const { me, store, uiPreview, endPreviewSession, nativeWallet, nativeLive } = useDashboard();
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
          {visibleNav(nativeWallet, nativeLive).map((group) => (
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
        <PwaInstallButton />
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="dash-sidebar-logo-word dash-sidebar-logo-word--on-dark"
          src="/logo-with-watermark-white.png"
          alt=""
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="dash-sidebar-logo-word dash-sidebar-logo-word--on-light"
          src="/logo-with-watermark-dark.png"
          alt=""
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="dash-sidebar-logo-mark dash-sidebar-logo-mark--on-dark" src="/logo-white.png" alt="" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
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
  async function create() {
    setBusy(true);
    try {
      await registerPasskey();
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
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
      <Button onClick={create} disabled={busy}>
        {busy ? 'Waiting for your device…' : 'Create my passkey'}
      </Button>
    </div>
  );
}
