'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { api, errorMessage } from '@/lib/api';

export default function SignupForm({ localMail }: { localMail: boolean }) {
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
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <p className="step-label">Step 1 of 3</p>
      <h1>Create your Tendr account</h1>
      {sent ? (
        <>
          <Alert tone="success">
            {localMail ? (
              <>
                This test setup keeps emails in the local inbox. If <strong>{email}</strong> can
                sign up, its verification link is there. Nothing was sent to your email address.
              </>
            ) : (
              <>
                Check your inbox. If <strong>{email}</strong> can sign up, we sent it a link.
              </>
            )}{' '}
            The link works for 15 minutes.
          </Alert>
          {localMail && (
            <p>
              <Link
                href={`/settings/local-mail?email=${encodeURIComponent(email)}`}
                className="link-button"
              >
                Open local inbox
              </Link>
            </p>
          )}
          <p className="muted">
            {localMail
              ? 'No message yet? Refresh the local inbox, or '
              : 'Didn’t get it? Check spam, or '}
            <button type="button" className="link-button" onClick={() => setSent(false)}>
              try again
            </button>
            .
          </p>
        </>
      ) : (
        <form onSubmit={submit} className="form">
          <p className="muted">
            {localMail
              ? 'Enter your email. Your verification link will appear in the local test inbox, then'
              : 'Enter your email. We’ll send a link to confirm it, then'}{' '}
            you’ll set up a passkey — the Face ID, Touch ID, Windows Hello or PIN you already use to
            unlock this device.
          </p>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
            />
          </label>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" disabled={busy || !email}>
            {busy ? 'Sending…' : 'Send me a link'}
          </Button>
        </form>
      )}
      <p className="muted small">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </div>
  );
}
