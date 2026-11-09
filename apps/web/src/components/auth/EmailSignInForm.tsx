'use client';

import { useState, type ComponentType } from 'react';
import { Alert, Button, type ButtonProps } from '@tendr/ui';
import { api, errorMessage } from '@/lib/api';
import { safeNext } from '@/lib/navigation';

/** Email access restores the person; it does not assert a login or wallet passkey. */
export function EmailSignInForm({
  next,
  disabled = false,
  className = 'form',
  SubmitButton = Button,
}: {
  next?: string;
  disabled?: boolean;
  className?: string;
  SubmitButton?: ComponentType<ButtonProps>;
}) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/email/start', {
        method: 'POST',
        json: { email: email.trim(), next: safeNext(next) },
        store: false,
      });
      setSentTo(email.trim());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="stack">
        <Alert tone="success">
          Check <strong>{sentTo}</strong> for your sign-in link. It works once and expires in 15
          minutes. Using your existing email returns you to the same account.
        </Alert>
        <button type="button" className="link-button" onClick={() => setSentTo(null)}>
          Use another email or request a new link
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={className} aria-label="Sign in with email">
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          maxLength={254}
          value={email}
          disabled={busy || disabled}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
        />
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <SubmitButton type="submit" disabled={busy || disabled || !email.trim()}>
        {busy ? 'Sending sign-in link…' : 'Email me a sign-in link'}
      </SubmitButton>
    </form>
  );
}
