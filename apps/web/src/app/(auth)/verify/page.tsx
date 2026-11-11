'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { Alert } from '@tendr/ui';
import { AuthCta } from '@/components/login/AuthCta';
import { AuthStage } from '@/components/login/AuthStage';
import { api, errorMessage } from '@/lib/api';
import { loadConnectParams, takeConnectWaiting } from '@/lib/connect';
import { safeNext, takePendingInvite } from '@/lib/navigation';
import { registerPasskey, type SessionStart } from '@/lib/webauthn';
import LoginRecoveryCodes from '@/components/auth/LoginRecoveryCodes';

type Step = 'confirm' | 'passkey' | 'recovery' | 'done' | 'connect-elsewhere';

function Verify() {
  const router = useRouter();
  const params = useSearchParams();
  // Read once, then dropped from the address bar so it is not kept in history or referrers.
  const [token] = useState(() => params.get('token'));
  const [next] = useState(() => safeNext(params.get('next')));
  const [step, setStep] = useState<Step>('confirm');
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryUnsaved, setRecoveryUnsaved] = useState(false);

  useEffect(() => {
    if (params.get('token')) window.history.replaceState(null, '', '/verify');
  }, [params]);

  function finish() {
    // Signing up from the Connect popup: in this same tab, back to /connect (its parameters are
    // in this tab's sessionStorage); in a tab the email link opened, back to the popup window,
    // which notices the new session by itself.
    if (loadConnectParams()) {
      setStep('done');
      router.replace('/connect');
      return;
    }
    if (takeConnectWaiting()) {
      setStep('connect-elsewhere');
      return;
    }
    setStep('done');
    // A new person lands on business naming (the dashboard sends anyone with no business there), or
    // back on the invite they came from.
    router.replace(takePendingInvite() ?? next);
  }

  // Confirming needs a click: mail scanners that open links must not use up the link.
  async function confirm() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<SessionStart>('/v1/auth/email/verify', {
        method: 'POST',
        json: { token },
        store: false,
      });
      setEmail(res.user.email);
      if (res.hasPasskey) finish();
      else setStep('passkey');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createPasskey() {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey();
      setStep('recovery');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <>
        <p className="login-panel-eyebrow">Email verification</p>
        <h1>This link is incomplete</h1>
        <p className="login-panel-lead">
          Open the link from your email again, or <Link href="/login">ask for a new one</Link>.
        </p>
      </>
    );
  }

  if (step === 'connect-elsewhere') {
    return (
      <>
        <p className="login-panel-eyebrow">Signed in</p>
        <h1>You’re signed in</h1>
        <p className="login-panel-lead">
          Go back to the tendr window you opened from your site to finish connecting it. You can
          close this tab.
        </p>
      </>
    );
  }

  if (step === 'done') {
    return (
      <>
        <p className="login-panel-eyebrow">Signed in</p>
        <h1>You’re signed in</h1>
        <p className="login-panel-lead">Opening your account…</p>
      </>
    );
  }

  if (step === 'recovery') {
    return (
      <div className="stack">
        <LoginRecoveryCodes onUnsavedChange={setRecoveryUnsaved} />
        <p>You can also add a backup passkey from Login recovery in your dashboard.</p>
        <AuthCta onClick={finish} disabled={recoveryUnsaved}>
          Continue to Tendr
        </AuthCta>
      </div>
    );
  }

  if (step === 'passkey') {
    return (
      <>
        <p className="login-panel-eyebrow">Step 2 of 3</p>
        <h1>Create your passkey</h1>
        <div className="login-panel-copy">
          <p>{email ? <strong>{email}</strong> : 'Your email'} is confirmed.</p>
          <p>
            Now make a passkey: it is a quick way to sign in and confirm sensitive account changes.
            Your live wallet uses a separate wallet passkey to approve transfers. You can also sign
            in with an email link.
          </p>
          <p>
            Your device asks for Face ID, Touch ID, Windows Hello or its PIN. There is no password
            to remember.
          </p>
        </div>
        <p className="login-panel-note">
          <Info aria-hidden="true" />
          <span>
            The passkey stays on your device (or in your iCloud / Google account). Tendr never sees
            it.
          </span>
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <AuthCta onClick={createPasskey} disabled={busy}>
          {busy ? 'Waiting for your device…' : 'Create my passkey'}
        </AuthCta>
      </>
    );
  }

  return (
    <>
      <p className="login-panel-eyebrow">Email verification</p>
      <h1>Confirm your email</h1>
      <p className="login-panel-lead">
        Confirm to open your account. New accounts will finish passkey setup.
      </p>
      {error && (
        <Alert tone="danger">
          {error} <Link href="/login">Ask for a new link</Link>.
        </Alert>
      )}
      <AuthCta onClick={confirm} disabled={busy}>
        {busy ? 'Confirming…' : 'Confirm my email'}
      </AuthCta>
    </>
  );
}

export default function VerifyPage() {
  return (
    <AuthStage>
      <Suspense>
        <Verify />
      </Suspense>
    </AuthStage>
  );
}
