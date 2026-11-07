'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { localMailLink, type LocalMailMessage } from '@/lib/local-mail-policy';

export default function LocalInbox({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [messages, setMessages] = useState<LocalMailMessage[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/dev-mail', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if (!res.ok)
        throw new Error('The local inbox is unavailable. Start the app with npm run dev:console.');
      const data = (await res.json()) as { messages: LocalMailMessage[] };
      setMessages(data.messages);
      setOrigin(window.location.origin);
    } catch (err) {
      if (!signal?.aborted)
        setError(err instanceof Error ? err.message : 'Could not load messages.');
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  const visible = messages.filter((m) => m.to.toLowerCase().includes(email.trim().toLowerCase()));

  return (
    <section className="dash stack">
      <div>
        <p className="step-label">Local testing</p>
        <h1>Local inbox</h1>
        <p>
          Test emails appear here instead of being delivered to your email address. Verification
          links work for 15 minutes.
        </p>
      </div>
      <div className="row">
        <Link href="/settings/api-console">API console</Link>
        <Link href="/signup">Create account</Link>
        <Button variant="secondary" disabled={busy} onClick={() => void load()}>
          Refresh inbox
        </Button>
      </div>
      <label className="field">
        <span>Filter by email</span>
        <input
          type="search"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Your email address"
        />
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      {busy && <Spinner label="Loading local messages" />}
      {!busy && !error && visible.length === 0 && (
        <p>
          No messages found. Submit your email on the signup page, then refresh this inbox. If you
          already have a passkey, use <Link href="/login">Sign in</Link>.
        </p>
      )}
      {visible.map((mail) => {
        const url = localMailLink(mail.data.url, origin);
        const verification = mail.template === 'verify_email';
        const expired = verification && Date.now() - Date.parse(mail.createdAt) > 15 * 60_000;
        return (
          <article className="card stack" key={mail.id}>
            <div>
              <h2>
                {mail.subject ||
                  (verification ? 'Confirm your email' : mail.template.replace(/_/g, ' '))}
              </h2>
              <p>
                To: <strong>{mail.to}</strong>
              </p>
              <time dateTime={mail.createdAt} className="muted small">
                {new Date(mail.createdAt).toLocaleString()}
              </time>
            </div>
            {expired ? (
              <p>
                This verification link has expired. <Link href="/signup">Request a new link</Link>.
              </p>
            ) : (
              url && (
                <p>
                  <Link href={url} prefetch={false} className="link-button">
                    {verification ? 'Verify email and continue' : 'Open email link'}
                  </Link>
                </p>
              )
            )}
            {mail.text && (
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{mail.text}</p>
            )}
            <details>
              <summary>Message details</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(mail.data, null, 2)}
              </pre>
            </details>
          </article>
        );
      })}
    </section>
  );
}
