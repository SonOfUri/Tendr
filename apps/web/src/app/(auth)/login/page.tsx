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
import { UserRoundKey } from 'lucide-react';

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

      <AuthCta
        onClick={() => void signIn()}
        disabled={busy}
        icon={<UserRoundKey size={18} strokeWidth={2} aria-hidden />}
      >
        {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
      </AuthCta>

      <div className="login-panel-divider" role="separator" aria-label="or continue with email">
        <span>or continue with email</span>
      </div>

      <EmailSignInForm next={next} disabled={busy} className="login-panel-form" />

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
