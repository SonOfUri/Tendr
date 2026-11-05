'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert } from '@tendr/ui';
import { AuthCta } from '@/components/login/AuthCta';
import { AuthStage } from '@/components/login/AuthStage';
import { toast } from '@/components/toast';
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
      const message = errorMessage(err);
      setError(message);
      toast.error(message);
      setBusy(false);
    }
  }

  return (
    <AuthStage>
      <p className="login-panel-eyebrow">Merchant access</p>
      <h1>Sign in to Tendr</h1>
      <p className="login-panel-lead">
        Use your passkey — Face ID, Touch ID, Windows Hello, or your device PIN. If it lives on your
        phone, your browser can show a code to scan.
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      <AuthCta onClick={() => void signIn()} disabled={busy}>
        {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
      </AuthCta>

      <p className="login-panel-foot">
        New to Tendr? <Link href="/signup">Create an account</Link>
      </p>
      <p className="login-panel-foot login-panel-foot--muted">
        Lost every passkey? <Link href="/recover">Use your recovery kit</Link>
      </p>
    </AuthStage>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
