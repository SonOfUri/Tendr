'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { api, errorMessage } from '@/lib/api';
import { takePendingInvite } from '@/lib/navigation';
import { registerPasskey, type SessionStart } from '@/lib/webauthn';

type Step = 'confirm' | 'passkey' | 'done';

function Verify() {
  const router = useRouter();
  const params = useSearchParams();
  // Read once, then dropped from the address bar so it is not kept in history or referrers.
  const [token] = useState(() => params.get('token'));
  const [step, setStep] = useState<Step>('confirm');
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.get('token')) window.history.replaceState(null, '', '/verify');
  }, [params]);

  function finish() {
    setStep('done');
    // A new person lands on store naming (the dashboard sends anyone with no store there), or
    // back on the invite they came from.
    router.replace(takePendingInvite() ?? '/dashboard');
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
      finish();
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
          Open the link from your email again, or <Link href="/signup">ask for a new one</Link>.
        </p>
      </div>
    );
  }

  if (step === 'passkey' || step === 'done') {
    return (
      <div className="card">
        <p className="step-label">Step 2 of 3</p>
        <h1>Create your passkey</h1>
        <p>
          {email ? <strong>{email}</strong> : 'Your email'} is confirmed. Now make a passkey: it is
          how you sign in and approve money leaving your store. Your device asks for Face ID, Touch
          ID, Windows Hello or its PIN — there is no password to remember.
        </p>
        <p className="muted small">
          The passkey stays on your device (or in your iCloud / Google account). Tendr never sees
          it.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button onClick={createPasskey} disabled={busy || step === 'done'}>
          {busy ? 'Waiting for your device…' : 'Create my passkey'}
        </Button>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Confirm your email</h1>
      <p className="muted">One click and you’re in. Then you’ll create your passkey.</p>
      {error && (
        <Alert tone="danger">
          {error} <Link href="/signup">Ask for a new link</Link>.
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
