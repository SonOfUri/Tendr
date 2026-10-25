'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { DestinationBox, Status, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { countdown, describeAction } from '@/lib/actions';
import { api, type Proposal, type SavedAddress, type Team } from '@/lib/api';
import { approveProposal, cancelProposal, STATUS_WORDS } from '@/lib/proposals';

interface Detail {
  proposal: Proposal;
  savedAddresses: SavedAddress[];
  team: Team;
}

export default function ProposalPage() {
  const { id } = useParams<{ id: string }>();
  const { store, context, me } = useDashboard();
  const key = context && id ? `${context.merchantId}:${context.livemode}:${id}` : null;
  const detail = useLoad<Detail>(async () => {
    const [proposal, s, team] = await Promise.all([
      api<Proposal>(`/v1/account/proposals/${encodeURIComponent(id)}`),
      api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<Team>('/v1/team'),
    ]);
    return { proposal, savedAddresses: s.savedAddresses, team };
  }, key);
  const now = useTick(15_000);
  const action = useAction();

  // A withdrawal or refund settles in a callback: check again while it is executing.
  const executing = detail.data?.proposal.status === 'executing';
  const { reload } = detail;
  useEffect(() => {
    if (!executing) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [executing, reload]);

  if (!store) return null;
  if (!detail.data) {
    return detail.error ? (
      <Alert tone="danger">{detail.error}</Alert>
    ) : (
      <Spinner label="Loading the proposal" />
    );
  }

  const { proposal: p, savedAddresses, team } = detail.data;
  const summary = describeAction(p.action, { savedAddresses, members: team.members });
  const creator = team.members.find((m) => m.userId === p.createdByUserId);
  const approvedByMe = p.approvals.some((a) => a.userId === me.user.id);
  const open = ['draft', 'pending', 'timelocked'].includes(p.status);
  const canApprove =
    store.isSigner && !approvedByMe && (p.status === 'draft' || p.status === 'pending');
  const canCancel =
    p.status === 'draft'
      ? store.isSigner || p.createdByUserId === me.user.id
      : open && store.isSigner;

  async function approve() {
    await action.run(async () => {
      detail.setData({ ...detail.data!, proposal: await approveProposal(p.id) });
    });
  }
  async function cancel() {
    await action.run(async () => {
      detail.setData({ ...detail.data!, proposal: await cancelProposal(p) });
    });
  }

  return (
    <div className="stack">
      <p className="small">
        <Link href="/dashboard/approvals">← Approvals</Link>
      </p>
      <div className="card-head">
        <h1>{summary.title}</h1>
        <Status status={p.status} />
      </div>
      <p className="muted" data-testid="proposal-status-words">
        {STATUS_WORDS[p.status] ?? p.status} · {context?.livemode ? 'Live' : 'Test'} account
      </p>

      {summary.destination && <DestinationBox destination={summary.destination} />}
      {summary.warnings.map((w) => (
        <Alert key={w} tone="warning">
          {w}
        </Alert>
      ))}

      <section className="card">
        <dl className="facts">
          {summary.rows.map((r) => (
            <div key={r.label} style={{ display: 'contents' }}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
          <dt>Asked by</dt>
          <dd>{creator?.email ?? p.createdByUserId ?? 'Unknown (created on chain)'}</dd>
          <dt>Created</dt>
          <dd>{new Date(p.createdAt).toLocaleString()}</dd>
          {p.readyAt && (
            <>
              <dt>Runs</dt>
              <dd>
                {new Date(p.readyAt).toLocaleString()}
                {p.status === 'timelocked' && ` (in ${countdown(p.readyAt, now)})`}
              </dd>
            </>
          )}
          <dt>Proposal id</dt>
          <dd>
            <code>{p.onchainId}</code>
          </dd>
        </dl>
      </section>

      <section className="card">
        <h2>Approvals</h2>
        {p.approvals.length === 0 ? (
          <p className="muted">No signer has approved yet.</p>
        ) : (
          <ul className="list">
            {p.approvals.map((a) => (
              <li key={`${a.userId}:${a.signerEpoch}`}>
                <span className="grow">
                  {team.members.find((m) => m.userId === a.userId)?.email ?? a.userId}
                </span>
                <span className="muted small">{new Date(a.approvedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        {action.error && <Alert tone="danger">{action.error}</Alert>}
        <div className="cta-row">
          {canApprove && (
            <Button onClick={() => void approve()} disabled={action.busy}>
              {action.busy ? 'Waiting for your passkey…' : 'Approve with passkey'}
            </Button>
          )}
          {canCancel && (
            <Button variant="secondary" onClick={() => void cancel()} disabled={action.busy}>
              {p.status === 'draft' ? 'Cancel request' : 'Cancel with passkey'}
            </Button>
          )}
        </div>
        {!store.isSigner && open && <p className="muted small">Only signers can approve this.</p>}
        {approvedByMe && open && (
          <p className="muted small">You approved this. It needs the other signers now.</p>
        )}
      </section>
    </div>
  );
}
