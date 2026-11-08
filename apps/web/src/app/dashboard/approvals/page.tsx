'use client';

import Link from 'next/link';
import { Alert, Button, Spinner } from '@tendr/ui';
import { CheckCircle2 } from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { countdown, describeAction } from '@/lib/actions';
import { api, type Proposal, type SavedAddress, type Team } from '@/lib/api';
import { cancelProposal } from '@/lib/proposals';

interface Inbox {
  proposals: Proposal[];
  savedAddresses: SavedAddress[];
  team: Team;
}

export default function ApprovalsPage() {
  const { store, context } = useDashboard();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const inbox = useLoad<Inbox>(async () => {
    const [p, s, team] = await Promise.all([
      api<{ proposals: Proposal[] }>('/v1/account/proposals'),
      api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<Team>('/v1/team'),
    ]);
    return { proposals: p.proposals, savedAddresses: s.savedAddresses, team };
  }, key);
  const now = useTick();
  const cancel = useAction();

  if (!store) return null;
  const header = (
    <PageHeader
      title="Approvals"
      description="Everything that moves money or changes the account waits here for signers. Open one to see exactly what it does before you approve it."
    />
  );
  if (!inbox.data) {
    return (
      <>
        {header}
        {inbox.error ? (
          <ErrorState message={inbox.error} onRetry={() => void inbox.reload()} />
        ) : (
          <Spinner label="Loading approvals" />
        )}
      </>
    );
  }

  const ctx = {
    savedAddresses: inbox.data.savedAddresses,
    members: inbox.data.team.members,
    livemode: context?.livemode ?? false,
  };
  const by = (statuses: string[]) =>
    inbox.data!.proposals.filter((p) => statuses.includes(p.status));
  const waiting = by(['draft', 'pending']);
  const timelocked = by(['timelocked']);
  const executing = by(['executing']);
  const history = by(['executed', 'cancelled', 'expired', 'failed']);

  const row = (p: Proposal, extra?: React.ReactNode) => {
    const s = describeAction(p.action, ctx);
    return (
      <li key={p.id} data-testid={`proposal-${p.id}`}>
        <span className="grow">
          <Link href={`/dashboard/approvals/${p.id}`}>{s.title}</Link>
          {s.destination && (
            <span className="dash-muted dash-small dash-mono">
              {' '}
              → {s.destination.chain}: {s.destination.address}
            </span>
          )}
          <br />
          <span className="dash-muted dash-small">
            {new Date(p.createdAt).toLocaleString()} · {p.approvals.length} approval
            {p.approvals.length === 1 ? '' : 's'}
          </span>
        </span>
        {extra}
        <Status status={p.status} />
      </li>
    );
  };

  const none = inbox.data.proposals.length === 0;

  return (
    <div className="stack">
      {header}
      {none ? (
        <EmptyState
          icon={<CheckCircle2 size={22} strokeWidth={1.75} />}
          title="No proposals yet"
          description="Withdrawals, security changes, and other actions appear here once someone asks for them."
          action={
            <Link href="/dashboard/withdraw" className="dash-empty-cta">
              Start a withdrawal
            </Link>
          }
        />
      ) : (
        <>
          <Panel title="Waiting for approval">
            {waiting.length === 0 ? (
              <p className="dash-muted">Nothing is waiting.</p>
            ) : (
              <ul className="list">{waiting.map((p) => row(p))}</ul>
            )}
          </Panel>

          <Panel title="Timelocked">
            <p className="dash-muted dash-small">
              Approved, but held for 24 hours (different-token withdrawals, limit raises, large
              refunds, upgrades, and security changes that add a signer or key, replace the recovery
              kit, lower the approval rule or change origins). Any signer can still cancel.
            </p>
            {timelocked.length === 0 ? (
              <p className="dash-muted">Nothing is timelocked.</p>
            ) : (
              <ul className="list">
                {timelocked.map((p) =>
                  row(
                    p,
                    <>
                      <span className="dash-small">
                        {p.readyAt ? `runs in ${countdown(p.readyAt, now)}` : 'waiting'}
                      </span>
                      {store.isSigner && (
                        <Button
                          variant="secondary"
                          disabled={cancel.busy}
                          onClick={() =>
                            void cancel.run(async () => {
                              await cancelProposal(p);
                              await inbox.reload();
                            })
                          }
                        >
                          Cancel
                        </Button>
                      )}
                    </>,
                  ),
                )}
              </ul>
            )}
          </Panel>

          {executing.length > 0 && (
            <Panel title="In progress">
              <ul className="list">{executing.map((p) => row(p))}</ul>
            </Panel>
          )}

          <Panel title="History">
            {history.length === 0 ? (
              <p className="dash-muted">No history yet.</p>
            ) : (
              <ul className="list">{history.map((p) => row(p))}</ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
