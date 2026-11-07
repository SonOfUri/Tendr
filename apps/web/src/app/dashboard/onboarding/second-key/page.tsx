'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { RecoveryKitCreator } from '@/components/dashboard/RecoveryKitCreator';
import { PageHeader, Panel, Select, TextLink } from '@/components/dashboard/ui';
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
    <>
      <PageHeader
        title="Add a second key"
        description={
          <>
            Before {store.name} can take real money, there must be a second way into the account, so
            losing one phone never locks you out.
          </>
        }
      />

      <Panel title="What counts">
        <ul className="dash-checklist">
          <li data-done="false">
            <span className="dash-checklist-mark" aria-hidden>
              1
            </span>
            <div className="dash-checklist-copy">
              <strong>A recovery kit</strong>
              <span className="dash-muted dash-small">Counts as soon as you confirm it below.</span>
            </div>
          </li>
          <li data-done="false">
            <span className="dash-checklist-mark" aria-hidden>
              2
            </span>
            <div className="dash-checklist-copy">
              <strong>A second signer</strong>
              <span className="dash-muted dash-small">
                Invite someone; once they have joined and created a passkey, choose Make signer on
                the <TextLink href="/dashboard/team">Team</TextLink> page. An invite alone does not
                count.
              </span>
            </div>
          </li>
        </ul>
        <p className="dash-muted dash-small" style={{ marginTop: '0.85rem' }}>
          Adding another device of yours is a good idea too, but it is still you, so it does not
          count on its own.
        </p>
        {ready ? (
          <Alert tone="success">
            You have a second key. <Link href="/dashboard/account">Go to your account</Link> to go live.
          </Alert>
        ) : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
      </Panel>

      <Panel title="Create a recovery kit" id="recovery-kit">
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
          <p className="dash-muted">Only the business owner can create the recovery kit.</p>
        )}
      </Panel>

      <Panel title="Invite another person" id="invite-signer">
        <InviteSigner />
      </Panel>

      <Panel title="Add another device" id="add-device">
        <AddDevice />
      </Panel>
    </>
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

  if (!canInvite) {
    return <p className="dash-muted">Ask the business owner to invite people.</p>;
  }

  const roleOptions = [
    { value: 'admin', label: 'Admin' },
    { value: 'finance', label: 'Finance' },
    ...(store?.role === 'owner' ? [{ value: 'owner', label: 'Owner' }] : []),
  ];

  return (
    <form onSubmit={submit} className="stack">
      <p className="dash-muted">
        A co-owner or colleague with their own passkey. We email them an invite. Joining makes them
        a team member, not yet a signer: once they have created their passkey, choose Make signer
        on the Team page and approve that proposal.
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
          <Select
            ariaLabel="Role"
            className="tendr-select--field"
            value={role}
            onChange={(v) => setRole(v as Role)}
            options={roleOptions}
          />
        </label>
      </div>
      {sent ? <Alert tone="success">Invite sent to {sent}. It works for 7 days.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="actions">
        <Button type="submit" disabled={busy || !email}>
          {busy ? 'Sending…' : 'Send invite'}
        </Button>
      </div>
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
    <div className="stack">
      <p className="dash-muted">
        A passkey on a second phone, laptop or security key, so losing one device doesn’t lock you
        out. It is still you, though: to go live you also need another person or a recovery kit.
      </p>
      {phase === 'idle' ? (
        <div className="actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await stepUp();
                setPhase('confirmed');
              })
            }
          >
            {busy ? 'Waiting for your passkey…' : 'Add a passkey from this browser'}
          </Button>
        </div>
      ) : null}
      {phase === 'confirmed' ? (
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
          <div className="actions">
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await registerPasskey({ deviceLabel: label.trim() || undefined });
                  setPhase('done');
                  await refresh();
                })
              }
            >
              {busy ? 'Waiting for the new device…' : 'Create the new passkey'}
            </Button>
          </div>
        </>
      ) : null}
      {phase === 'done' ? <Alert tone="success">Your new passkey is ready.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {addUrl ? (
        <div className="dash-qr-row">
          <QrImage value={addUrl} label="Link to sign in and add a device" size={140} />
          <p className="dash-muted dash-small">
            Or scan this with your other device, sign in there, and add a passkey on it from this
            page.
          </p>
        </div>
      ) : null}
    </div>
  );
}
