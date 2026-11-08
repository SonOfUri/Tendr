'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { DestinationBox, Status, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { NativeWalletPanel } from '@/components/dashboard/NativeWallet';
import { countdown, describeAction } from '@/lib/actions';
import { api, type AccountView, type Proposal, type SavedAddress, type Team } from '@/lib/api';
import { approveProposal, approvedAtEpoch, cancelProposal, STATUS_WORDS } from '@/lib/proposals';

interface Detail {
  native: boolean;
  /** The account's current signer epoch (approvals from an older epoch no longer count). */
  signerEpoch: string | null;
  threshold: number | undefined;
  releaseCodeHash: string | null;
  proposal: Proposal;
  savedAddresses: SavedAddress[];
  team: Team;
}

export default function ProposalPage() {
  const { id } = useParams<{ id: string }>();
  const { store, context, me } = useDashboard();
  const key = context && id ? `${context.merchantId}:${context.livemode}:${id}` : null;
  const detail = useLoad<Detail>(async () => {
    const account = await api<AccountView>('/v1/account');
    const native = account.account?.kind === 'native_intents';
    const [proposal, s, team] = await Promise.all([
      api<Proposal>(`/v1/account/proposals/${encodeURIComponent(id)}`),
      native
        ? Promise.resolve({ savedAddresses: [] as SavedAddress[] })
        : api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<Team>('/v1/team'),
    ]);
    return {
      native,
      proposal,
      savedAddresses: s.savedAddresses,
      team,
      signerEpoch: account.account?.signerEpoch ?? null,
      threshold: account.account?.threshold,
      releaseCodeHash: account.releaseCodeHash ?? null,
    };
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
      <ErrorState message={detail.error} onRetry={() => void detail.reload()} />
    ) : (
      <PageSkeleton label="Loading the proposal" />
    );
  }

  const {
    proposal: p,
    savedAddresses,
    team,
    signerEpoch,
    threshold,
    releaseCodeHash,
  } = detail.data;
  if (detail.data.native) {
    if (p.kind !== 'refund') {
      return <Alert tone="info">This action is unavailable for a single-owner wallet.</Alert>;
    }
    const refundOpen = ['draft', 'pending', 'timelocked'].includes(p.status);
    const canCancelRefund =
      p.status === 'draft'
        ? store.isSigner || p.createdByUserId === me.user.id
        : refundOpen && store.isSigner;
    return (
      <div className="stack">
        <p className="dash-small">
          <Link href="/dashboard/approvals">← Approvals</Link>
        </p>
        {canCancelRefund ? (
          <Panel title="Before you sign">
            <p className="dash-muted">
              You can cancel this refund proposal until the payout is signed. A signed payout cannot
              be cancelled.
            </p>
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  detail.setData({ ...detail.data!, proposal: await cancelProposal(p) });
                })
              }
            >
              Cancel proposal
            </Button>
          </Panel>
        ) : null}
        <NativeWalletPanel
          merchantId={store.id}
          userId={me.user.id}
          isOwner={store.role === 'owner'}
          proposalId={p.id}
        />
      </div>
    );
  }
  const summary = describeAction(p.action, {
    savedAddresses,
    members: team.members,
    livemode: context?.livemode ?? false,
    threshold,
    releaseCodeHash,
  });
  const creator = team.members.find((m) => m.userId === p.createdByUserId);
  // Only an approval at the current signer epoch counts: after a signer change, approve again.
  const approvedByMe = approvedAtEpoch(p, me.user.id, signerEpoch);
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
    <>
      <p className="dash-small">
        <Link href="/dashboard/approvals">← Approvals</Link>
      </p>
      <PageHeader
        title={summary.title}
        actions={<Status status={p.status} />}
        description={
          <span data-testid="proposal-status-words">
            {STATUS_WORDS[p.status] ?? p.status} · {context?.livemode ? 'Live' : 'Test'} account
          </span>
        }
      />

      {summary.destination && <DestinationBox destination={summary.destination} />}
      {summary.warnings.map((w) => (
        <Alert key={w} tone="warning">
          {w}
        </Alert>
      ))}

      <Panel title="Details">
        <dl className="dash-facts">
          {summary.rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
          <div>
            <dt>Asked by</dt>
            <dd>{creator?.email ?? p.createdByUserId ?? 'Unknown (created on chain)'}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{new Date(p.createdAt).toLocaleString()}</dd>
          </div>
          {p.readyAt && (
            <div>
              <dt>Runs</dt>
              <dd>
                {new Date(p.readyAt).toLocaleString()}
                {p.status === 'timelocked' && ` (in ${countdown(p.readyAt, now)})`}
              </dd>
            </div>
          )}
          <div>
            <dt>Proposal id</dt>
            <dd>
              <code className="dash-mono">{p.onchainId}</code>
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Approvals">
        {p.approvals.length === 0 ? (
          <p className="dash-muted">No signer has approved yet.</p>
        ) : (
          <ul className="list">
            {p.approvals.map((a) => (
              <li key={`${a.userId}:${a.signerEpoch}`}>
                <span className="grow">
                  {team.members.find((m) => m.userId === a.userId)?.email ?? a.userId}
                </span>
                <span className="dash-muted dash-small">
                  {new Date(a.approvedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
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
        {!store.isSigner && open && (
          <p className="dash-muted dash-small">Only signers can approve this.</p>
        )}
        {approvedByMe && open && (
          <p className="dash-muted dash-small">
            {threshold != null && threshold <= 1
              ? 'You approved this. If it stays pending, cancel it and try the payout again.'
              : 'You approved this. It needs the other signers now.'}
          </p>
        )}
      </Panel>
    </>
  );
}
