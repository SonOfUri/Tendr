'use client';

import Link from 'next/link';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useAction, useLoad, useTick } from '@/components/dashboard/common';
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
  if (!inbox.data) {
    return inbox.error ? (
      <Alert tone="danger">{inbox.error}</Alert>
    ) : (
      <Spinner label="Loading approvals" />
    );
  }

  const ctx = { savedAddresses: inbox.data.savedAddresses, members: inbox.data.team.members };
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
            <span className="muted small address">
              {' '}
              → {s.destination.chain}: {s.destination.address}
            </span>
          )}
          <br />
          <span className="muted small">
            {new Date(p.createdAt).toLocaleString()} · {p.approvals.length} approval
            {p.approvals.length === 1 ? '' : 's'}
          </span>
        </span>
        {extra}
        <Status status={p.status} />
      </li>
    );
  };

  return (
    <div className="stack">
      <div>
        <h1>Approvals</h1>
        <p className="muted">
          Everything that moves money or changes the account waits here for signers. Open one to see
          exactly what it does before you approve it.
        </p>
        {cancel.error && <Alert tone="danger">{cancel.error}</Alert>}
      </div>

      <section className="card">
        <h2>Waiting for approval</h2>
        {waiting.length === 0 ? (
          <p className="muted">Nothing is waiting.</p>
        ) : (
          <ul className="list">{waiting.map((p) => row(p))}</ul>
        )}
      </section>

      <section className="card">
        <h2>Timelocked</h2>
        <p className="muted small">
          Approved, but held for 24 hours (different-token withdrawals, limit raises, large
          refunds). Any signer can still cancel.
        </p>
        {timelocked.length === 0 ? (
          <p className="muted">Nothing is timelocked.</p>
        ) : (
          <ul className="list">
            {timelocked.map((p) =>
              row(
                p,
                <>
                  <span className="small">
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
      </section>

      {executing.length > 0 && (
        <section className="card">
          <h2>In progress</h2>
          <ul className="list">{executing.map((p) => row(p))}</ul>
        </section>
      )}

      <section className="card">
        <h2>History</h2>
        {history.length === 0 ? (
          <p className="muted">No history yet.</p>
        ) : (
          <ul className="list">{history.map((p) => row(p))}</ul>
        )}
      </section>
    </div>
  );
}
