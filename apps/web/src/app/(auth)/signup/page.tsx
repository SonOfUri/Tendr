'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@tendr/ui';
import { AuthCta } from '@/components/login/AuthCta';
import { AuthStage } from '@/components/login/AuthStage';
import { toast } from '@/components/toast';
import { api, errorMessage } from '@/lib/api';
import { Mail, Send } from 'lucide-react';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/email/start', { method: 'POST', json: { email }, store: false });
      setSent(true);
      toast.success('Check your inbox for the confirmation link.');
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthStage>
      <p className="login-panel-eyebrow">Step 1 of 3</p>
      <h1>Create your Tendr account</h1>

      {sent ? (
        <>
          <Alert tone="success">
            Check your inbox. If <strong>{email}</strong> can sign up, we sent it a link. The link
            works for 15 minutes.
          </Alert>
          <p className="login-panel-lead">
            Didn’t get it? Check spam, or{' '}
            <button type="button" className="link-button" onClick={() => setSent(false)}>
              try again
            </button>
            .
          </p>
        </>
      ) : (
        <form onSubmit={submit} className="login-panel-form">
          <p className="login-panel-lead">
            Enter your email. We’ll send a link to confirm it, then you’ll set up a passkey — Face
            ID, Touch ID, Windows Hello, or the PIN you already use.
          </p>
          <label className="field">
            <span>Email</span>
            <span className="login-field-input">
              <Mail className="login-field-icon" size={17} strokeWidth={2} aria-hidden />
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                placeholder="you@company.com"
              />
            </span>
          </label>
          {error && <Alert tone="danger">{error}</Alert>}
          <AuthCta
            type="submit"
            disabled={busy || !email}
            tone="yellow"
            icon={<Send size={18} strokeWidth={2} aria-hidden />}
          >
            {busy ? 'Sending…' : 'Send me a link'}
          </AuthCta>
        </form>
      )}

      <p className="login-panel-foot">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </AuthStage>
  );
}
