'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert } from '@tendr/ui';
import { EmailSignInForm } from '@/components/auth/EmailSignInForm';
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
        Use your login passkey or verify your email to access your existing account on this device.
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      <AuthCta onClick={() => void signIn()} disabled={busy}>
        {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
      </AuthCta>

      <p className="login-panel-lead">Or sign in with email</p>
      <EmailSignInForm
        next={next}
        disabled={busy}
        className="login-panel-form"
        SubmitButton={AuthCta}
      />

      <p className="login-panel-foot">
        New to Tendr? <Link href="/signup">Create an account</Link>
      </p>
      <p className="login-panel-foot login-panel-foot--muted">
        Recovering a shared contract account? <Link href="/recover">Use your recovery kit</Link>
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
