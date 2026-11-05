'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { api, errorMessage, type StoreSummary } from '@/lib/api';

type Created = StoreSummary & { testAccount: { nearAccountId: string; status: string } };
type Phase = 'welcome' | 'ask' | 'done';

const WELCOME_SEEN = 'tendr.biz-welcome-seen';
const WELCOME_MS = 2600;

export default function StoreNamePage() {
  const router = useRouter();
  const { me, refresh, selectStore } = useDashboard();
  const firstBusiness = me.stores.length === 0;
  const [phase, setPhase] = useState<Phase>(firstBusiness ? 'welcome' : 'ask');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!firstBusiness || phase !== 'welcome') return;
    try {
      if (sessionStorage.getItem(WELCOME_SEEN) === '1') {
        setPhase('ask');
        return;
      }
    } catch {
      // Storage unavailable: play the welcome once for this visit.
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => finishWelcome(), reduce ? 280 : WELCOME_MS);
    return () => window.clearTimeout(timer);
  }, [firstBusiness, phase]);

  function finishWelcome() {
    try {
      sessionStorage.setItem(WELCOME_SEEN, '1');
    } catch {
      // The welcome can play again on the next visit.
    }
    setPhase((current) => (current === 'welcome' ? 'ask' : current));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<Created>('/v1/merchants', {
        method: 'POST',
        json: { name: name.trim() },
        store: false,
      });
      selectStore({ merchantId: res.id, livemode: false });
      await refresh();
      setCreated(res);
      setPhase('done');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`biz-welcome${phase === 'welcome' ? ' is-intro' : ' is-ask'}`}
      aria-label={phase === 'welcome' ? 'Welcome to Tendr' : undefined}
      onClick={phase === 'welcome' ? finishWelcome : undefined}
      onKeyDown={
        phase === 'welcome'
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') finishWelcome();
            }
          : undefined
      }
    >
      <div className="biz-welcome-logo" aria-hidden={phase !== 'welcome'}>
        <span className="biz-welcome-ring" />
        <img className="biz-welcome-mark biz-welcome-mark--on-dark" src="/logo-with-watermark-white.png" alt="" />
        <img
          className="biz-welcome-mark biz-welcome-mark--on-light"
          src="/logo-with-watermark-dark.png"
          alt=""
        />
      </div>

      {phase === 'ask' ? (
        <form className="biz-welcome-form" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
          <h1>What’s your business called?</h1>
          <p>This is the name your customers and your team will see.</p>
          <label className="biz-welcome-field">
            <span>Business name</span>
            <input
              required
              autoFocus
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme"
              autoComplete="organization"
            />
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <button className="biz-welcome-cta" type="submit" disabled={busy || !name.trim()}>
            <span>{busy ? 'Creating…' : 'Continue'}</span>
          </button>
        </form>
      ) : null}

      {phase === 'done' && created ? (
        <div className="biz-welcome-form">
          <h1>{created.name} is ready</h1>
          <p>
            You can try a payment in test mode now. Before you take real money, add a second way
            into this account.
          </p>
          <button
            className="biz-welcome-cta"
            type="button"
            onClick={() => router.push('/dashboard/onboarding/second-key')}
          >
            <span>Add a second key</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
