'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { errorMessage } from '@/lib/api';
import { safeNext } from '@/lib/navigation';
import { loginWithPasskey } from '@/lib/webauthn';

function Login() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      router.replace(next);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>Sign in to Tendr</h1>
      <p className="muted">
        Use your passkey: Face ID, Touch ID, Windows Hello or your device PIN. If your passkey is on
        your phone, your browser can show a code to scan with it.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button onClick={signIn} disabled={busy}>
        {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
      </Button>
      <p className="muted small">
        New to Tendr? <Link href="/signup">Create an account</Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
