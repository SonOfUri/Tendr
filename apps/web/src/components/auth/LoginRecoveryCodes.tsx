'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@tendr/ui';
import { AuthCta as Button } from '@/components/login/AuthCta';
import styles from './login-recovery.module.css';
import { api, errorMessage } from '@/lib/api';
import { withStepUp } from '@/lib/webauthn';

export default function LoginRecoveryCodes({
  onUnsavedChange,
}: { onUnsavedChange?: (unsaved: boolean) => void } = {}) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const unsaved = codes.length > 0 && !saved;
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  useEffect(() => {
    let active = true;
    void api<{ remaining: number }>('/v1/auth/login-recovery/codes', { store: false })
      .then((r) => {
        if (active) setRemaining(r.remaining);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  async function generate() {
    setBusy(true);
    setError('');
    try {
      const r = await withStepUp(() =>
        api<{ codes: string[]; remaining: number }>('/v1/auth/login-recovery/codes', {
          method: 'POST',
          json: {},
          store: false,
        }),
      );
      setCodes(r.codes);
      setRemaining(r.remaining);
      setSaved(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const blob = new Blob(
      [
        'Tendr login recovery codes\n\nKeep these private and separate from your device. Each code works once with an email recovery link. These do not recover your wallet signing key.\n\n' +
          codes.join('\n') +
          '\n',
      ],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tendr-login-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className={styles.panel} aria-label="Login recovery codes">
      <h2>Save your login recovery codes</h2>
      <p>
        Use a saved code and email verification if you lose every login passkey. Keep a copy
        somewhere you can reach without this device, such as a password manager or printed backup.
      </p>
      <p className="muted">
        These codes recover your Tendr login. Your wallet needs its own signing passkey.
      </p>
      {remaining !== null && (
        <p>
          {remaining > 0
            ? `${remaining} unused recovery codes available.`
            : 'Recovery codes are not set up.'}
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {codes.length ? (
        <>
          <Alert tone="warning">
            These codes are shown only now. Tendr cannot display them again.
          </Alert>
          <pre
            aria-label="Your recovery codes"
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {codes.join('\n')}
          </pre>
          <Button type="button" onClick={download}>
            Download recovery codes
          </Button>
          <label>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I
            saved my codes somewhere safe.
          </label>
          <Button type="button" disabled={!saved} onClick={() => setCodes([])}>
            Hide saved codes
          </Button>
        </>
      ) : (
        <>
          {!!remaining && (
            <p>Generating a new set immediately invalidates all previous recovery codes.</p>
          )}
          <Button
            type="button"
            disabled={busy || remaining === null}
            onClick={() => void generate()}
          >
            {busy
              ? 'Confirming your passkey…'
              : remaining
                ? 'Generate new recovery codes'
                : 'Generate recovery codes'}
          </Button>
        </>
      )}
    </section>
  );
}
