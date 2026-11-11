'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
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
    // A new person lands on store naming (the dashboard sends anyone with no store there), or
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
      <div className="card">
        <h1>This link is incomplete</h1>
        <p className="muted">
          Open the link from your email again, or <Link href="/login">ask for a new one</Link>.
        </p>
      </div>
    );
  }

  if (step === 'connect-elsewhere') {
    return (
      <div className="card">
        <h1>You’re signed in</h1>
        <p>
          Go back to the tendr window you opened from your site to finish connecting it. You can
          close this tab.
        </p>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="card">
        <h1>You’re signed in</h1>
        <p>Opening your account…</p>
      </div>
    );
  }

  if (step === 'recovery') {
    return (
      <div className="stack">
        <LoginRecoveryCodes onUnsavedChange={setRecoveryUnsaved} />
        <p>You can also add a backup passkey from Login recovery in your dashboard.</p>
        <Button onClick={finish} disabled={recoveryUnsaved}>
          Continue to Tendr
        </Button>
      </div>
    );
  }

  if (step === 'passkey') {
    return (
      <div className="card">
        <p className="step-label">Step 2 of 3</p>
        <h1>Create your passkey</h1>
        <p>
          {email ? <strong>{email}</strong> : 'Your email'} is confirmed. Now make a passkey: it is
          a quick way to sign in and confirm sensitive account changes. Your live wallet uses a
          separate wallet passkey to approve transfers. You can also sign in with an email link.
        </p>
        <p className="muted small">
          The passkey stays on your device (or in your iCloud / Google account). Tendr never sees
          it.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button onClick={createPasskey} disabled={busy}>
          {busy ? 'Waiting for your device…' : 'Create my passkey'}
        </Button>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Confirm your email</h1>
      <p className="muted">Confirm to open your account. New accounts will finish passkey setup.</p>
      {error && (
        <Alert tone="danger">
          {error} <Link href="/login">Ask for a new link</Link>.
        </Alert>
      )}
      <Button onClick={confirm} disabled={busy}>
        {busy ? 'Confirming…' : 'Confirm my email'}
      </Button>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
