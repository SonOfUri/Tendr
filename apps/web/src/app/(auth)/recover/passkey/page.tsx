'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert } from '@tendr/ui';
import { AuthCta } from '@/components/login/AuthCta';
import { AuthStage } from '@/components/login/AuthStage';
import { toast } from '@/components/toast';
import { api, errorMessage, isSignedOut } from '@/lib/api';
import { registerPasskey } from '@/lib/webauthn';

interface RecoverySession {
  csrfToken: string | null;
  store: { id: string; slug: string; name: string };
  email: string;
}

/**
 * The emailed `recovery_register` link: with the recovery-kit session from /recover in this
 * browser, it registers the person's new first passkey. Then they sign in normally.
 */
function RecoverPasskey() {
  const params = useSearchParams();
  // Read once, then dropped from the address bar.
  const [token] = useState(() => params.get('token'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // The kit session opened at /recover: its CSRF token (this page is a fresh load from the email,
  // so nothing is in memory, and the API's cookie may be on another host), business and email.
  const [session, setSession] = useState<RecoverySession | null | undefined>(undefined);

  useEffect(() => {
    if (params.get('token')) window.history.replaceState(null, '', '/recover/passkey');
  }, [params]);

  useEffect(() => {
    api<RecoverySession>('/v1/auth/recovery-session', { store: false })
      .then(setSession)
      .catch((err) => {
        setSession(null);
        if (!isSignedOut(err)) setError(errorMessage(err));
      });
  }, []);

  async function create() {
    if (!token || !session) return;
    setBusy(true);
    setError(null);
    try {
      await registerPasskey({ recoveryToken: token });
      setDone(true);
      toast.success('Your new passkey is ready.');
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthStage>
      {!token ? (
        <>
          <p className="login-panel-eyebrow">Recovery</p>
          <h1>This link is incomplete</h1>
          <p className="login-panel-lead">
            Open the link from your email again, or <Link href="/recover">start over</Link>.
          </p>
        </>
      ) : session === null ? (
        <>
          <p className="login-panel-eyebrow">Recovery</p>
          <h1>Open this link in the browser you started from</h1>
          <p className="login-panel-lead">
            This link only works together with the recovery-kit check you did at{' '}
            <Link href="/recover">Lost your passkeys?</Link> in this same browser; the emailed link
            lasts 15 minutes. Start over there if it has expired.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
        </>
      ) : done ? (
        <>
          <p className="login-panel-eyebrow">Recovery</p>
          <h1>Your new passkey is ready</h1>
          <p className="login-panel-lead">
            Sign in with it. If your team lost every passkey, you can then start a recovery of the
            live account from the dashboard.
          </p>
          <Link href="/login?next=/dashboard/recovery" className="login-panel-cta-link">
            <span className="login-panel-cta-label">Sign in</span>
          </Link>
        </>
      ) : (
        <>
          <p className="login-panel-eyebrow">Recovery</p>
          <h1>Create your new passkey</h1>
          {session && (
            <p className="login-panel-lead">
              For <strong>{session.email}</strong> at <strong>{session.store.name}</strong> (
              <code>{session.store.slug}</code>).
            </p>
          )}
          <p className="login-panel-lead">
            Use this same browser you started from. Your device will ask for Face ID, Touch ID,
            Windows Hello or its PIN.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
          <AuthCta onClick={() => void create()} disabled={busy || !session}>
            {busy ? 'Waiting for your device…' : 'Create my passkey'}
          </AuthCta>
        </>
      )}
    </AuthStage>
  );
}

export default function RecoverPasskeyPage() {
  return (
    <Suspense>
      <RecoverPasskey />
    </Suspense>
  );
}
