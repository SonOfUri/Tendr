'use client';

import { useState, type ComponentType } from 'react';
import { Alert, type ButtonProps } from '@tendr/ui';
import { AuthCta } from '@/components/login/AuthCta';
import { api, errorMessage } from '@/lib/api';
import { safeNext } from '@/lib/navigation';
import { Mail, Send } from 'lucide-react';

type EmailSubmitProps = ButtonProps & {
  icon?: React.ReactNode;
  tone?: 'dark' | 'yellow';
};

/** Email access restores the person; it does not assert a login or wallet passkey. */
export function EmailSignInForm({
  next,
  disabled = false,
  className = 'form',
  SubmitButton = AuthCta,
}: {
  next?: string;
  disabled?: boolean;
  className?: string;
  SubmitButton?: ComponentType<EmailSubmitProps>;
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

  const Submit = SubmitButton;

  return (
    <form onSubmit={submit} className={className} aria-label="Sign in with email">
      <label className="field">
        <span>Email</span>
        <span className="login-field-input">
          <Mail className="login-field-icon" size={17} strokeWidth={2} aria-hidden />
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
        </span>
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <Submit
        type="submit"
        disabled={busy || disabled || !email.trim()}
        tone="yellow"
        icon={<Send size={18} strokeWidth={2} aria-hidden />}
      >
        {busy ? 'Sending sign-in link…' : 'Email me a sign-in link'}
      </Submit>
    </form>
  );
}
