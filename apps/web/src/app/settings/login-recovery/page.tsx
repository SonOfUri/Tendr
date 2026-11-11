'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import LoginRecoveryCodes from '@/components/auth/LoginRecoveryCodes';
import { api, errorMessage, type Me } from '@/lib/api';
import { registerPasskey, withStepUp } from '@/lib/webauthn';

export default function LoginRecoverySettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reload() {
    setMe(await api<Me>('/v1/me', { store: false }));
  }
  useEffect(() => {
    void reload().catch((e) => setError(errorMessage(e)));
  }, []);
  async function change(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await withStepUp(fn);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <div className="stack">
        <h1>Login security and recovery</h1>
        {error && <Alert tone="danger">{error}</Alert>}
        {!me ? (
          <>
            <p>
              <Link href="/login?next=/settings/login-recovery">
                Sign in to manage login recovery
              </Link>
            </p>
            {!error && <Spinner label="Loading login security" />}
          </>
        ) : (
          <>
            <p>
              Signed in as {me.user.email}. These settings apply to your login across all your
              stores.
            </p>
            <section className="card stack">
              <h2>Backup login passkeys</h2>
              <p>
                Add a passkey on another device or in a separate credential provider while you still
                have access. A synced copy of the same passkey may not appear as a second entry.
              </p>
              <ul>
                {me.passkeys.map((p) => (
                  <li key={p.id}>
                    {p.deviceLabel || 'Login passkey'}{' '}
                    <Button
                      type="button"
                      disabled={busy || me.passkeys.length < 2}
                      onClick={() =>
                        void change(() =>
                          api(`/v1/auth/passkeys/${p.id}`, { method: 'DELETE', store: false }),
                        )
                      }
                    >
                      Remove {p.deviceLabel || 'passkey'}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change(() => registerPasskey({ deviceLabel: 'Backup login passkey' }))
                }
              >
                Add a login passkey
              </Button>
            </section>
            {me.passkeys.length > 0 && <LoginRecoveryCodes />}
            <p>
              <Link href="/recover/login">Lost all login passkeys?</Link>
            </p>
          </>
        )}
        <p>
          <Link href="/dashboard">Back to dashboard</Link>
        </p>
      </div>
    </div>
  );
}
