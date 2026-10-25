'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { errorMessage } from '@/lib/api';
import { registerPasskey } from '@/lib/webauthn';

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

  useEffect(() => {
    if (params.get('token')) window.history.replaceState(null, '', '/recover/passkey');
  }, [params]);

  async function create() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await registerPasskey({ recoveryToken: token });
      setDone(true);
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
          Open the link from your email again, or <Link href="/recover">start over</Link>.
        </p>
      </div>
    );
  }
  if (done) {
    return (
      <div className="card">
        <h1>Your new passkey is ready</h1>
        <p className="muted">
          Sign in with it. If your team lost every passkey, you can then start a recovery of the
          live account from the dashboard.
        </p>
        <Link href="/login?next=/dashboard/recovery">Sign in</Link>
      </div>
    );
  }
  return (
    <div className="card">
      <h1>Create your new passkey</h1>
      <p className="muted">
        Use this same browser you started from. Your device will ask for Face ID, Touch ID, Windows
        Hello or its PIN.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button onClick={() => void create()} disabled={busy}>
        {busy ? 'Waiting for your device…' : 'Create my passkey'}
      </Button>
    </div>
  );
}

export default function RecoverPasskeyPage() {
  return (
    <Suspense>
      <RecoverPasskey />
    </Suspense>
  );
}
