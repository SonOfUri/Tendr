'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { RecoveryKitCreator } from '@/components/dashboard/RecoveryKitCreator';
import { QrImage } from '@/components/QrImage';
import { api, errorMessage, type GoLiveStatus, type Role } from '@/lib/api';
import { registerPasskey, stepUp, withStepUp } from '@/lib/webauthn';

export default function SecondKeyPage() {
  const { store, context, refresh } = useDashboard();
  const [status, setStatus] = useState<GoLiveStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!context) return;
    try {
      setStatus(await api<GoLiveStatus>('/v1/account/go-live', { livemode: false }));
    } catch {
      setStatus(null);
    }
  }, [context]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!store) return null;
  const isOwner = store.role === 'owner';
  const ready = status && !status.checklist.missing.includes('second_key');

  return (
    <div className="stack">
      <div>
        <h1>Add a second key</h1>
        <p className="lead muted">
          Before {store.name} can take real money, there must be a second way into the account, so
          losing one phone never locks you out. Two things count as a second key:
        </p>
        <ul className="muted">
          <li>
            <strong>A recovery kit</strong> — counts as soon as you confirm it below.
          </li>
          <li>
            <strong>A second signer</strong> — invite someone; once they have joined and created a
            passkey, choose <em>Make signer</em> for them on the{' '}
            <Link href="/dashboard/team">Team</Link> page. That is a proposal you approve, and it
            counts once it has executed. An invite on its own does not count.
          </li>
        </ul>
        <p className="muted small">
          Adding another device of yours is a good idea too, but it is still you, so it does not
          count on its own.
        </p>
        {ready && (
          <Alert tone="success">
            You have a second key. <Link href="/dashboard">Go to your account</Link> to go live.
          </Alert>
        )}
        {notice && <Alert tone="success">{notice}</Alert>}
      </div>

      <section className="card" id="recovery-kit">
        <h2>Create a recovery kit</h2>
        {isOwner ? (
          <RecoveryKitCreator
            storeName={store.name}
            storeSlug={store.slug}
            replacing={status?.checklist.recoveryKeySet ?? false}
            onRegistered={(r) => {
              setNotice(
                r.stored
                  ? 'Your recovery kit is on. Keep it somewhere safe.'
                  : 'Your new recovery kit is waiting for your signers to approve the change.',
              );
              void load();
              void refresh();
            }}
          />
        ) : (
          <p className="muted">Only the store owner can create the recovery kit.</p>
        )}
      </section>

      <section className="card" id="invite-signer">
        <h2>Invite another person</h2>
        <InviteSigner />
      </section>

      <section className="card" id="add-device">
        <h2>Add another device</h2>
        <AddDevice />
      </section>
    </div>
  );
}

function InviteSigner() {
  const { store } = useDashboard();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('admin');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canInvite = store?.role === 'owner' || store?.role === 'admin';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await withStepUp(() =>
        api('/v1/team/invites', { method: 'POST', json: { email, role }, livemode: false }),
      );
      setSent(email);
      setEmail('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canInvite) return <p className="muted">Ask the store owner to invite people.</p>;

  return (
    <form onSubmit={submit} className="form">
      <p className="muted">
        A co-owner or colleague with their own passkey. We email them an invite. Joining makes them
        a team member, not yet a signer: once they have created their passkey, choose{' '}
        <em>Make signer</em> for them on the Team page and approve that proposal. They count as your
        second key only after it executes.
      </p>
      <div className="row">
        <label className="field grow">
          <span>Their email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">Admin</option>
            <option value="finance">Finance</option>
            {store?.role === 'owner' && <option value="owner">Owner</option>}
          </select>
        </label>
      </div>
      {sent && <Alert tone="success">Invite sent to {sent}. It works for 7 days.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={busy || !email}>
        {busy ? 'Sending…' : 'Send invite'}
      </Button>
    </form>
  );
}

function AddDevice() {
  const { refresh } = useDashboard();
  const [phase, setPhase] = useState<'idle' | 'confirmed' | 'done'>('idle');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addUrl, setAddUrl] = useState<string | null>(null);

  useEffect(() => {
    setAddUrl(
      `${window.location.origin}/login?next=${encodeURIComponent(
        '/dashboard/onboarding/second-key#add-device',
      )}`,
    );
  }, []);

  // Two clicks: each passkey prompt needs its own tap (browsers refuse a second prompt that was
  // not started by the person).
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <p className="muted">
        A passkey on a second phone, laptop or security key, so losing one device doesn’t lock you
        out. It is still you, though: to go live you also need another person or a recovery kit.
      </p>
      {phase === 'idle' && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await stepUp();
              setPhase('confirmed');
            })
          }
        >
          {busy ? 'Waiting for your passkey…' : 'Add a passkey from this browser'}
        </Button>
      )}
      {phase === 'confirmed' && (
        <>
          <label className="field">
            <span>Name this device (optional)</span>
            <input
              value={label}
              maxLength={64}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Work laptop"
            />
          </label>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await registerPasskey({ deviceLabel: label.trim() || undefined });
                setPhase('done');
                await refresh();
              })
            }
          >
            {busy ? 'Waiting for the new device…' : 'Create the new passkey'}
          </Button>
        </>
      )}
      {phase === 'done' && <Alert tone="success">Your new passkey is ready.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {addUrl && (
        <div className="qr-row">
          <QrImage value={addUrl} label="Link to sign in and add a device" size={140} />
          <p className="muted small">
            Or scan this with your other device, sign in there, and add a passkey on it from this
            page.
          </p>
        </div>
      )}
    </div>
  );
}
