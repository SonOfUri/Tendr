'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { PageHeader, Panel, Select } from '@/components/dashboard/ui';
import { api, type MemberKeys, type Role, type Team, type TeamMember } from '@/lib/api';
import { draftProposal } from '@/lib/proposals';
import { withStepUp } from '@/lib/webauthn';

const ROLE_WORDS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  finance: 'Finance',
  viewer: 'Viewer',
};

export default function TeamPage() {
  const { store, context, me } = useDashboard();
  const team = useLoad(() => api<Team>('/v1/team'), context ? context.merchantId : null);
  if (!store || !context) return null;
  const canManage = store.role === 'owner' || store.role === 'admin';
  const isOwner = store.role === 'owner';

  return (
    <div className="stack">
      <PageHeader
        title="Team"
        description={
          <>
            People who can use {store.name}. Roles decide what someone can ask for; moving money or
            changing security also needs signers to approve it with their passkeys.
          </>
        }
      />

      {canManage && (
        <Panel title="Invite someone">
          <InviteForm onSent={() => void team.reload()} />
        </Panel>
      )}

      <Panel title="Members">
        {!team.data ? (
          <Spinner label="Loading the team" />
        ) : (
          <ul className="list">
            {team.data.members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                self={m.userId === me.user.id}
                canManage={canManage}
                isOwner={isOwner}
                livemode={context.livemode}
                onChanged={() => void team.reload()}
              />
            ))}
          </ul>
        )}
        <p className="dash-muted dash-small">
          A signer approves money going out and security changes. Making someone a signer is a
          proposal on the {context.livemode ? 'live' : 'test'} account: it takes effect 24 hours
          after the current signers approve it, and any signer can cancel it in that time.
        </p>
      </Panel>

      {team.data && team.data.invites.length > 0 && (
        <Panel title="Invites waiting">
          <ul className="list">
            {team.data.invites.map((i) => (
              <li key={i.id}>
                <span className="grow">{i.email}</span>
                <span className="dash-muted dash-small">
                  {ROLE_WORDS[i.role]} · expires {new Date(i.expiresAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function InviteForm({ onSent }: { onSent: () => void }) {
  const { store } = useDashboard();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('finance');
  const [sent, setSent] = useState<string | null>(null);
  const { busy, run } = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      withStepUp(() => api('/v1/team/invites', { method: 'POST', json: { email, role } })),
    );
    if (ok !== undefined) {
      setSent(email);
      setEmail('');
      onSent();
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <div className="row">
        <label className="field grow">
          <span>Email</span>
          <input
            type="email"
            name="invite-email"
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
            options={[
              { value: 'viewer', label: 'Viewer — sees the account' },
              { value: 'finance', label: 'Finance — asks for withdrawals and refunds' },
              { value: 'admin', label: 'Admin — team and money settings' },
              ...(store?.role === 'owner' ? [{ value: 'owner', label: 'Owner — security' }] : []),
            ]}
          />
        </label>
      </div>
      {sent && <Alert tone="success">Invite sent to {sent}. It works for 7 days.</Alert>}
      <Button type="submit" disabled={busy || !email}>
        {busy ? 'Sending…' : 'Send invite'}
      </Button>
    </form>
  );
}

function MemberRow({
  member,
  self,
  canManage,
  isOwner,
  livemode,
  onChanged,
}: {
  member: TeamMember;
  self: boolean;
  canManage: boolean;
  isOwner: boolean;
  livemode: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  const { busy, run } = useAction();
  const canEditRole = canManage && !self && (isOwner || member.role !== 'owner');

  async function changeRole(role: Role) {
    const ok = await run(() =>
      withStepUp(() => api(`/v1/team/${member.id}`, { method: 'PATCH', json: { role } })),
    );
    if (ok !== undefined) onChanged();
  }

  // "Make signer": an `add_signer` draft carrying the person's active passkey keys (each of their
  // devices), approved on the detail page.
  async function makeSigner() {
    const proposal = await run(async () => {
      const { keys } = await api<MemberKeys>(`/v1/team/${member.id}/signer-keys`);
      if (keys.length === 0) {
        throw new Error(`${member.email} has no passkey yet. Ask them to sign in and create one.`);
      }
      return draftProposal({ add_signer: { id: member.userId, keys } });
    });
    if (proposal) router.push(`/dashboard/approvals/${proposal.id}`);
  }

  return (
    <li data-testid={`member-${member.email}`}>
      <span className="grow">
        <strong>{member.email}</strong>
        {self && <span className="dash-muted dash-small"> (you)</span>}
        {member.isSigner && (
          <span className="status" data-status="active" style={{ marginLeft: '0.5rem' }}>
            signer
          </span>
        )}
      </span>
      {canEditRole ? (
        <Select
          ariaLabel={`Role of ${member.email}`}
          value={member.role}
          disabled={busy}
          onChange={(v) => void changeRole(v as Role)}
          options={(['viewer', 'finance', 'admin', ...(isOwner ? ['owner'] : [])] as Role[]).map(
            (r) => ({ value: r, label: ROLE_WORDS[r] }),
          )}
        />
      ) : (
        <span className="dash-muted dash-small">{ROLE_WORDS[member.role]}</span>
      )}
      {isOwner && !member.isSigner && member.role !== 'viewer' && (
        <Button variant="secondary" disabled={busy} onClick={() => void makeSigner()}>
          {busy ? 'Working…' : `Make signer${livemode ? '' : ' (test)'}`}
        </Button>
      )}
    </li>
  );
}
