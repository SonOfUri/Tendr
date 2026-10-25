'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { api, errorMessage } from '@/lib/api';
import { parseRecoveryKit, signRecovery } from '@/lib/recovery-kit';

const SESSION_DOMAIN = 'tendr-recovery-session-v1';

/**
 * Lost every passkey: prove the store's recovery kit (it signs a one-time server challenge here,
 * in the browser), then finish with the link we email you to create a new passkey. The kit never
 * leaves this page and is cleared after signing.
 */
export default function RecoverPage() {
  const [merchant, setMerchant] = useState('');
  const [email, setEmail] = useState('');
  const [kit, setKit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const slug = merchant.trim().toLowerCase();
      const who = email.trim().toLowerCase();
      const opt = await api<{ challenge: string; accountId: string; message: string }>(
        '/v1/auth/recovery-session/options',
        { method: 'POST', store: false, json: { merchant: slug, email: who } },
      );
      // Sign only the message we expect (built here), never an arbitrary server string.
      const message = `${SESSION_DOMAIN}:${opt.accountId}:${who}:${opt.challenge}`;
      if (opt.message !== message) throw new Error('Unexpected recovery challenge. Try again.');
      const secret = parseRecoveryKit(kit);
      let signature: string;
      try {
        signature = signRecovery(secret, new TextEncoder().encode(message));
      } finally {
        secret.fill(0);
        setKit('');
      }
      await api('/v1/auth/recovery-session/verify', {
        method: 'POST',
        store: false,
        json: { merchant: slug, email: who, challenge: opt.challenge, signature },
      });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="card">
        <h1>Check your email</h1>
        <p className="muted">
          Your recovery kit checked out. We sent a link to {email.trim()}: open it on this device
          within 15 minutes to create your new passkey. Everyone who approves payments for the store
          has been told.
        </p>
      </div>
    );
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h1>Lost your passkeys?</h1>
      <p className="muted">
        If you no longer have any passkey for Tendr, your store’s recovery kit and your email can
        set up a new one. The other signers are told.
      </p>
      <label className="field">
        <span>Store address</span>
        <input
          required
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          placeholder="your-store"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Your email</span>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Recovery kit</span>
        <textarea
          required
          rows={3}
          value={kit}
          onChange={(e) => setKit(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABCD-EFGH-…"
        />
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Continue'}
      </Button>
      <p className="muted small">
        Still have a passkey? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
