'use client';

// The Connect popup (WooCommerce plugin spec §2): check the plugin's parameters, sign in or sign
// up, pick (or create) a store the person owns or administers, approve with a passkey, and go back
// to the plugin's return URL. See lib/connect.ts for the parameter and navigation rules.
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { PayoutChooser } from '@/components/dashboard/PayoutChooser';
import { RecoveryKitCreator } from '@/components/dashboard/RecoveryKitCreator';
import {
  api,
  errorMessage,
  isSignedOut,
  setStoreContext,
  type Me,
  type StoreContext,
  type StoreSummary,
} from '@/lib/api';
import {
  APPROVAL_DETAIL,
  approvalQuestion,
  authorizeBody,
  cancelRedirect,
  checkedRedirect,
  clearConnectParams,
  clearConnectWaiting,
  clearWaitingOnPageHide,
  connectNextStep,
  eligibleStores,
  hasConnectParams,
  loadConnectParams,
  markConnectWaiting,
  parseConnectParams,
  saveConnectParams,
  siteLabel,
  siteOrigin,
  waitingNextStep,
  type ConnectParams,
} from '@/lib/connect';
import { previewSlug } from '@/lib/navigation';
import { loginWithPasskey, registerPasskey, withStepUp } from '@/lib/webauthn';

type Store = Pick<StoreSummary, 'id' | 'name' | 'slug' | 'role'>;
type Created = StoreSummary & { testAccount: { nearAccountId: string; status: string } };

type Phase =
  | { k: 'loading' }
  | { k: 'invalid'; error: string }
  | { k: 'signed-out' }
  | { k: 'email-sent'; email: string }
  | { k: 'passkey' }
  | { k: 'pick' }
  | { k: 'new-store' }
  | { k: 'recovery'; store: Created }
  | { k: 'payout'; store: Store; storeContext: StoreContext; isNew: boolean }
  | { k: 'approve'; store: Store }
  | { k: 'leaving' };

const POLL_MS = 3000;

/**
 * Choose payout (spec §2), in test mode: for a new store, and for a picked store with none set
 * (the step moves on by itself when the store already has one).
 */
function payoutPhase(store: Store, isNew: boolean): Phase {
  return { k: 'payout', store, storeContext: { merchantId: store.id, livemode: false }, isNew };
}

/** Where a signed-in person goes next (lib/connect.ts `connectNextStep`). */
function nextPhase(me: Me): Phase {
  return { k: connectNextStep(me) };
}

export function ConnectFlow() {
  const [params, setParams] = useState<ConnectParams | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [error, setError] = useState<string | null>(null);

  /** Reads the session; `quiet` keeps the current screen when signed out (polling). */
  const loadMe = useCallback(async (quiet = false): Promise<Me | null> => {
    try {
      const m = await api<Me>('/v1/me', { store: false });
      setMe(m);
      setError(null);
      return m;
    } catch (err) {
      if (!isSignedOut(err)) setError(errorMessage(err));
      else if (!quiet) setPhase({ k: 'signed-out' });
      return null;
    }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    let p: ConnectParams | null;
    if (hasConnectParams(q)) {
      const r = parseConnectParams(q);
      if (!r.ok) {
        clearConnectParams();
        setPhase({ k: 'invalid', error: r.error });
        return;
      }
      p = r.params;
      saveConnectParams(p);
      // The parameters now live in this tab only; keep them out of the address bar and history.
      window.history.replaceState(null, '', '/connect');
    } else {
      p = loadConnectParams();
    }
    if (!p) {
      setPhase({
        k: 'invalid',
        error: 'This connect link has expired or is incomplete. Start again from your site.',
      });
      return;
    }
    setParams(p);
    void loadMe().then((m) => m && setPhase(nextPhase(m)));
  }, [loadMe]);

  // While the person confirms their email (or makes their passkey) in the tab the email link
  // opened, this window checks for the session and carries on by itself: from "check your inbox"
  // as soon as there is a session (to the passkey screen if none was made there), from the
  // passkey screen once there is a passkey.
  const waiting = phase.k === 'email-sent' || phase.k === 'passkey' ? phase.k : null;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      void loadMe(true).then((m) => {
        const next = waitingNextStep(waiting, m);
        if (next) setPhase({ k: next });
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waiting, loadMe]);

  // The flag that sends an email-link tab back here goes once this window does.
  useEffect(() => clearWaitingOnPageHide(), []);

  function cancel() {
    if (!params) return;
    const target = cancelRedirect(params);
    clearConnectParams();
    clearConnectWaiting();
    setPhase({ k: 'leaving' });
    window.location.assign(target);
  }

  if (phase.k === 'invalid') {
    return (
      <div className="card">
        <h1>We can’t connect this site</h1>
        <Alert tone="danger">{phase.error}</Alert>
        <p className="muted small">You can close this window.</p>
      </div>
    );
  }
  if (phase.k === 'loading' && error) {
    return (
      <div className="card">
        <Alert tone="danger">{error}</Alert>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  }
  if (phase.k === 'loading' || phase.k === 'leaving' || !params) {
    return (
      <div className="card">
        <Spinner label={phase.k === 'leaving' ? 'Taking you back to your site' : 'Loading'} />
      </div>
    );
  }

  const cancelLink = (
    <p className="muted small">
      Not now?{' '}
      <button type="button" className="link-button" onClick={cancel}>
        Cancel and go back to your site
      </button>
    </p>
  );

  return (
    <div className="card">
      <SiteBanner params={params} />
      {error && <Alert tone="danger">{error}</Alert>}
      {phase.k === 'signed-out' && (
        <SignIn
          onSignedIn={async () => {
            const m = await loadMe();
            if (m) setPhase(nextPhase(m));
          }}
          onEmailSent={(email) => {
            markConnectWaiting();
            setPhase({ k: 'email-sent', email });
          }}
        />
      )}
      {phase.k === 'email-sent' && (
        <>
          <h1>Check your inbox</h1>
          <Alert tone="success">
            If <strong>{phase.email}</strong> can sign up, we sent it a link. It works for 15
            minutes.
          </Alert>
          <p className="muted">
            Open the link, confirm your email and create your passkey there. Then come back to this
            window: it carries on by itself.
          </p>
        </>
      )}
      {phase.k === 'passkey' && (
        <CreatePasskey
          onDone={async () => {
            const m = await loadMe();
            if (m) setPhase(nextPhase(m));
          }}
        />
      )}
      {phase.k === 'pick' && me && (
        <StorePicker
          stores={eligibleStores(me.stores)}
          onPick={(store) => setPhase(payoutPhase(store, false))}
          onNew={() => setPhase({ k: 'new-store' })}
        />
      )}
      {phase.k === 'new-store' && me && (
        <NewStore
          first={me.stores.length === 0}
          onCreated={async (store) => {
            await loadMe(true);
            setPhase({ k: 'recovery', store });
          }}
          onBack={eligibleStores(me.stores).length > 0 ? () => setPhase({ k: 'pick' }) : null}
        />
      )}
      {phase.k === 'recovery' && (
        <>
          <p className="step-label">New business · recovery kit</p>
          <h1>Save your recovery kit</h1>
          <dl className="facts">
            <dt>Business</dt>
            <dd>{phase.store.name}</dd>
            <dt>Test account</dt>
            <dd>
              <code>{phase.store.testAccount.nearAccountId}</code>
            </dd>
          </dl>
          <p className="muted">
            The kit is your second way into {phase.store.name}, so a lost phone never locks you out.
            Your business needs it before it can take real money.
          </p>
          <RecoveryKitCreator
            storeName={phase.store.name}
            storeSlug={phase.store.slug}
            replacing={false}
            onRegistered={() => setPhase(payoutPhase(phase.store, true))}
          />
        </>
      )}
      {phase.k === 'payout' && (
        <>
          <p className="step-label">{phase.isNew ? 'New business · payout' : 'Payout'}</p>
          <h1>Where your payments go</h1>
          <p>
            Payments settle into {phase.store.name}’s own tendr account, in the token you choose.
            From there you withdraw to a saved address on your dashboard.
          </p>
          <PayoutChooser
            key={phase.store.id}
            store={phase.storeContext}
            storeName={phase.store.name}
            onDone={() => setPhase({ k: 'approve', store: phase.store })}
          />
        </>
      )}
      {phase.k === 'approve' && (
        <Approve
          params={params}
          store={phase.store}
          onLeave={() => setPhase({ k: 'leaving' })}
          onCancel={cancel}
          onBack={() => setPhase({ k: 'pick' })}
        />
      )}
      {phase.k !== 'approve' && cancelLink}
    </div>
  );
}

/** The site asking to connect, shown on every screen. */
function SiteBanner({ params }: { params: ConnectParams }) {
  return (
    <div className="connect-origin">
      <span className="muted small">Site asking to connect</span>
      <strong className="address">{siteOrigin(params)}</strong>
      <span className="muted small">WooCommerce plugin {params.plugin_version}</span>
    </div>
  );
}

function SignIn({
  onSignedIn,
  onEmailSent,
}: {
  onSignedIn: () => Promise<void>;
  onEmailSent: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Sign in to tendr</h1>
      <p className="muted">
        Use your passkey: Face ID, Touch ID, Windows Hello or your device PIN.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        disabled={busy}
        onClick={() =>
          run(async () => {
            await loginWithPasskey();
            await onSignedIn();
          })
        }
      >
        {busy ? 'Waiting…' : 'Sign in with a passkey'}
      </Button>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/v1/auth/email/start', { method: 'POST', json: { email }, store: false });
            onEmailSent(email);
          });
        }}
      >
        <h2>New to tendr?</h2>
        <p className="muted small">
          Enter your email. We’ll send a link to confirm it, then you’ll create a passkey and your
          business. By creating an account you agree to the{' '}
          <Link href="/terms" target="_blank" rel="noopener noreferrer">
            Terms
          </Link>
          .
        </p>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <Button type="submit" variant="secondary" disabled={busy || !email}>
          Create an account
        </Button>
      </form>
    </>
  );
}

function CreatePasskey({ onDone }: { onDone: () => Promise<void> }) {
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
    <>
      <h1>Create your passkey</h1>
      <p className="muted">
        Your email is confirmed. If you are creating your passkey in the tab the email opened,
        finish there and this window carries on. Or create it here.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button onClick={create} disabled={busy}>
        {busy ? 'Waiting for your device…' : 'Create my passkey here'}
      </Button>
    </>
  );
}

function StorePicker({
  stores,
  onPick,
  onNew,
}: {
  stores: StoreSummary[];
  onPick: (s: Store) => void;
  onNew: () => void;
}) {
  const [chosen, setChosen] = useState<string>(stores[0]?.id ?? '');
  const store = stores.find((s) => s.id === chosen);
  if (stores.length === 0) {
    return (
      <>
        <h1>Create a business</h1>
        <p className="muted">
          You are not an owner or admin of any business, so you can’t connect a site to one. Create
          a business for this site, or ask an owner to make you an admin.
        </p>
        <Button onClick={onNew}>Create a business</Button>
      </>
    );
  }
  return (
    <>
      <h1>Choose a business</h1>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (store) onPick(store);
        }}
      >
        <ul className="choices">
          {stores.map((s) => (
            <li key={s.id}>
              <label>
                <input
                  type="radio"
                  name="store"
                  value={s.id}
                  checked={chosen === s.id}
                  onChange={() => setChosen(s.id)}
                />
                <span className="grow">
                  <strong>{s.name}</strong>{' '}
                  <span className="muted small">
                    {s.slug} · {s.role}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <Button type="submit" disabled={!store}>
          Continue
        </Button>
      </form>
      <Button variant="secondary" onClick={onNew}>
        Create a new business
      </Button>
    </>
  );
}

function NewStore({
  first,
  onCreated,
  onBack,
}: {
  first: boolean;
  onCreated: (store: Created) => Promise<void>;
  onBack: (() => void) | null;
}) {
  const [name, setName] = useState('');
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
      // The recovery kit is registered for this store (the API reads the tab's store headers).
      setStoreContext({ merchantId: res.id, livemode: false });
      await onCreated(res);
    } catch (err) {
      // The API's own message, e.g. the store limit.
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <p className="step-label">{first ? 'Your business' : 'New business'}</p>
      <h1>Name your business</h1>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Business name</span>
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme"
          />
        </label>
        <dl className="facts">
          <dt>Business address</dt>
          <dd>
            <code>{slug}</code>
          </dd>
          <dt>Test account</dt>
          <dd>
            <code>{slug}.tendr.testnet</code>
          </dd>
        </dl>
        <p className="muted small">
          Your Tendr account is where this business’s money is kept. Only you and the people you
          choose can move it — not Tendr.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="button-row">
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create business'}
          </Button>
          {onBack && (
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
      </form>
    </>
  );
}

function Approve({
  params,
  store,
  onLeave,
  onCancel,
  onBack,
}: {
  params: ConnectParams;
  store: Store;
  onLeave: () => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await withStepUp(() =>
        api<{ redirect: string }>('/v1/connect/authorize', {
          method: 'POST',
          json: authorizeBody(params),
          store: { merchantId: store.id, livemode: false },
        }),
      );
      const target = checkedRedirect(res.redirect, params.return_url);
      if (!target) {
        setError('tendr answered with an unexpected address, so we stopped. Nothing was sent.');
        setBusy(false);
        return;
      }
      clearConnectParams();
      clearConnectWaiting();
      onLeave();
      window.location.assign(target);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>{approvalQuestion(siteLabel(params), store.name)}</h1>
      <p>{APPROVAL_DETAIL}</p>
      <dl className="facts">
        <dt>Business</dt>
        <dd>{store.name}</dd>
        <dt>Goes back to</dt>
        <dd className="address">{new URL(params.return_url).origin}</dd>
      </dl>
      <p className="muted small">
        Only approve if you started this from your own site’s admin. Approving needs your passkey.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="button-row">
        <Button onClick={approve} disabled={busy}>
          {busy ? 'Waiting for your passkey…' : 'Approve'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Choose another store
        </Button>
      </div>
    </>
  );
}
