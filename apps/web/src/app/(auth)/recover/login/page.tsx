'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { Alert, Button } from '@tendr/ui';
import { api, errorMessage, setCsrfToken } from '@/lib/api';

export default function RecoverLogin() {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (value) {
      setToken(value);
      window.history.replaceState(null, '', '/recover/login');
    }
  }, []);
  async function requestEmail() {
    setBusy(true);
    setError('');
    try {
      await api('/v1/auth/login-recovery/start', { method: 'POST', json: { email }, store: false });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    setBusy(true);
    setError('');
    try {
      const json = { token, recoveryCode: code };
      const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(
        '/v1/auth/login-recovery/options',
        { method: 'POST', json, store: false },
      );
      const response = await startRegistration({ optionsJSON });
      await api('/v1/auth/login-recovery/verify', {
        method: 'POST',
        json: { ...json, response },
        store: false,
      });
      setCode('');
      setToken('');
      setCsrfToken(null);
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card stack">
      <h1>Recover your Tendr login</h1>
      <p>
        Keep your existing account and stores when you lose access to every login passkey. You need
        access to your verified email and a recovery code saved before the loss.
      </p>
      <p className="muted">
        This replaces login passkeys only. It does not recover your wallet signing key or move
        funds.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {done ? (
        <>
          <Alert tone="success">
            Your new login passkey is ready. Previous login passkeys and sessions have been revoked.
            The recovery code you used no longer works.
          </Alert>
          <Link href="/login?next=/settings/login-recovery">Sign in with your new passkey</Link>
        </>
      ) : token ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void recover();
          }}
        >
          <label className="field">
            <span>Saved recovery code</span>
            <input
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              required
            />
          </label>
          <p>
            Completing recovery removes all previous login passkeys and signs out every device. Your
            new passkey will be used to sign in afterward.
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating your replacement passkey…' : 'Replace lost login passkeys'}
          </Button>
        </form>
      ) : sent ? (
        <Alert>
          If recovery codes are enabled for that account, a recovery link has been sent. Open it and
          enter one of your saved codes. The link expires in 15 minutes.
        </Alert>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void requestEmail();
          }}
        >
          <label className="field">
            <span>Account email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              maxLength={254}
              required
            />
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Requesting recovery…' : 'Email a recovery link'}
          </Button>
        </form>
      )}
      <p>
        If you still have a synced passkey or another registered device, use it to sign in instead.
        Without a saved code, email sign-in can open your account but cannot replace the missing
        passkey.
      </p>
      <Link href="/login">Back to sign in</Link>
    </div>
  );
}
