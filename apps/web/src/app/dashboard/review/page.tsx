'use client';

import Link from 'next/link';
import { useState } from 'react';
import { HOLD_NOTICE, LEGAL_ACK_PHRASE } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useAction, useLoad } from '@/components/dashboard/common';
import { AssetGridPicker } from '@/components/dashboard/AssetGridPicker';
import { EmptyState, ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { chainLabel, formatAmount } from '@/lib/assets';
import { chainSelectOptions } from '@/components/dashboard/asset-logos';
import { SearchCheck } from 'lucide-react';
import { api } from '@/lib/api';
import {
  heldReturnForms,
  canCancelStoreRefund,
  isClosedMerchantRefund,
  refundStateWords,
  returnLabel,
  type Refund,
  type ReturnItem,
  type ReviewItem,
  type ReviewQueue,
} from '@/lib/payments';
import { withStepUp } from '@/lib/webauthn';

// The review queue. There is deliberately no "release" action for held funds: a hold is a notice
// (Tendr cannot freeze money in your account), and the only way funds leave is a refund proposal
// that signers approve — for held funds only after an owner's typed legal acknowledgement, and
// never back to the sanctioned sender.
export default function ReviewPage() {
  const { store, context } = useDashboard();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const queue = useLoad(() => api<ReviewQueue>('/v1/review'), key);
  if (!store || !context) return null;
  const header = (
    <PageHeader
      title="Review"
      description={
        <>
          Payments and returns that need a decision from your team in{' '}
          {context.livemode ? 'live' : 'test'} mode.
        </>
      }
    />
  );
  if (!queue.data) {
    return (
      <>
        {header}
        {queue.error ? (
          <ErrorState message={queue.error} onRetry={() => void queue.reload()} />
        ) : (
          <PageSkeleton label="Loading the review queue" />
        )}
      </>
    );
  }
  const q = queue.data;
  const reload = () => void queue.reload();
  const empty =
    q.held.length + q.screening_unresolved.length + q.returns.length + q.needs_address.length === 0;

  return (
    <div className="stack">
      {header}
      {empty && (
        <EmptyState
          icon={<SearchCheck size={22} strokeWidth={1.75} />}
          title="Nothing needs review"
          description="Held payments, returns, and screening issues show up here when your team needs to act."
        />
      )}

      {q.held.length > 0 && (
        <section className="stack" aria-labelledby="held">
          <h2 id="held" className="dash-panel-title">
            Held payments
          </h2>
          {q.held.map((item) => (
            <HeldCard
              key={item.payment_id}
              item={item}
              isOwner={store.role === 'owner'}
              livemode={context.livemode}
              onChanged={reload}
            />
          ))}
        </section>
      )}

      {q.screening_unresolved.length > 0 && (
        <Panel title="Screening couldn't complete">
          <p className="dash-muted dash-small">
            We could not check these senders against sanctions lists for 6 hours, so these payments
            are not marked paid. This is not a hold; we keep retrying. Contact support if it stays
            here.
          </p>
          <ul className="list">
            {q.screening_unresolved.map((item) => (
              <li key={item.payment_id}>
                <span className="grow">
                  <Link href={`/dashboard/payments/${item.payment_id}`}>
                    {formatAmount(item.source_asset, item.amount_received, context.livemode)}
                  </Link>
                  <span className="dash-muted dash-small dash-mono"> from {item.sender_address ?? '—'}</span>
                </span>
                <Status status={item.status} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {q.returns.length > 0 && (
        <Panel title="Return to sender">
          <ul className="list">
            {q.returns.map((r) => (
              <ReturnRow key={r.id} r={r} livemode={context.livemode} onChanged={reload} />
            ))}
          </ul>
        </Panel>
      )}

      {q.needs_address.length > 0 && (
        <Panel title="Waiting for an address">
          <p className="dash-muted dash-small">
            These came from an exchange, so they cannot go back to the sending address. The shopper
            was asked where to send them; you can also give an address they sent you.
          </p>
          <ul className="list">
            {q.needs_address.map((r) => (
              <ReturnRow key={r.id} r={r} livemode={context.livemode} onChanged={reload} />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function RefundLine({ r, livemode }: { r: Refund; livemode: boolean }) {
  return (
    <>
      {formatAmount(r.asset, r.amount, livemode)} · {r.reason} ·{' '}
      <span className="dash-muted dash-small">{refundStateWords(r)}</span>
      {r.proposal_id && (
        <>
          {' '}
          <Link href={`/dashboard/approvals/${r.proposal_id}`} className="dash-small">
            View the proposal
          </Link>
        </>
      )}
    </>
  );
}

/** "Cancel refund" for a store refund with no proposal yet (W14; dashboard route, step-up). */
function CancelStoreRefund({ r, onChanged }: { r: Refund; onChanged: () => void }) {
  const cancel = useAction();
  if (!canCancelStoreRefund(r)) return null;
  async function run() {
    const ok = await cancel.run(() =>
      withStepUp(() =>
        api(`/v1/review/refunds/${encodeURIComponent(r.id)}/cancel`, { method: 'POST', json: {} }),
      ),
    );
    if (ok !== undefined) onChanged();
  }
  return (
    <>
      <Button variant="secondary" onClick={() => void run()} disabled={cancel.busy}>
        {cancel.busy ? 'Cancelling…' : 'Cancel refund'}
      </Button>
    </>
  );
}

function HeldCard({
  item,
  isOwner,
  livemode,
  onChanged,
}: {
  item: ReviewItem;
  isOwner: boolean;
  livemode: boolean;
  onChanged: () => void;
}) {
  const [phrase, setPhrase] = useState('');
  const ack = useAction();
  // One form per return still waiting for a destination, each with its own refund_id (C41).
  const forms = heldReturnForms(item);

  async function acknowledge(e: React.FormEvent) {
    e.preventDefault();
    const ok = await ack.run(() =>
      withStepUp(() =>
        api(`/v1/review/${encodeURIComponent(item.payment_id)}/acknowledge-legal`, {
          method: 'POST',
          json: { phrase },
        }),
      ),
    );
    if (ok !== undefined) onChanged();
  }

  return (
    <Panel>
      <Alert tone="danger">{HOLD_NOTICE}</Alert>
      <p>
        <Link href={`/dashboard/payments/${item.payment_id}`}>
          {formatAmount(item.source_asset, item.amount_received, livemode)}
        </Link>{' '}
        <Status status={item.status} />
        <br />
        <span className="dash-muted dash-small dash-mono">
          Sender: {item.sender_addresses.join(', ') || item.sender_address || '—'}
          {item.sender_chain ? ` (${chainLabel(item.sender_chain)})` : ''}
        </span>
      </p>
      {item.refunds.length > 0 && (
        <ul className="list">
          {item.refunds.map((r) => (
            <li key={r.id} data-testid={`held-refund-${r.id}`}>
              <span className="grow">
                <strong>{returnLabel(r.reason)}</strong> · <RefundLine r={r} livemode={livemode} />
              </span>
              <CancelStoreRefund r={r} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}

      {!item.legal_ack_at ? (
        isOwner ? (
          <form onSubmit={acknowledge} className="form">
            <p className="dash-small">
              To return these funds (never to the sanctioned sender), an owner must confirm legal
              clearance. Type exactly: <strong>{LEGAL_ACK_PHRASE}</strong>
            </p>
            <label className="field">
              <span>Acknowledgement</span>
              <input
                name="legal-ack"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
              />
            </label>
            <Button type="submit" disabled={ack.busy || phrase !== LEGAL_ACK_PHRASE}>
              {ack.busy ? 'Confirming…' : 'Confirm legal clearance'}
            </Button>
          </form>
        ) : (
          <p className="dash-muted dash-small">
            An owner must confirm legal clearance before these funds can be returned.
          </p>
        )
      ) : (
        <>
          <p className="dash-muted dash-small">
            Legal clearance confirmed {new Date(item.legal_ack_at).toLocaleString()}.
          </p>
          {forms.map((f) => (
            <div key={f.refundId ?? 'order'} className="stack">
              <h3 className="dash-small">{f.label}</h3>
              <DestinationForm
                paymentId={item.payment_id}
                {...(f.refundId ? { refundId: f.refundId } : {})}
                required
                label={`Draft the refund: ${f.label.toLowerCase()}`}
                onDone={onChanged}
              />
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}

function ReturnRow({
  r,
  livemode,
  onChanged,
}: {
  r: ReturnItem;
  livemode: boolean;
  onChanged: () => void;
}) {
  const redo = useAction();
  const [give, setGive] = useState(false);
  const canRedraft =
    !r.proposal_id && !!r.review_reason && !!r.destination && !isClosedMerchantRefund(r);

  async function redraft() {
    const ok = await redo.run(() =>
      withStepUp(() =>
        api(`/v1/review/${encodeURIComponent(r.payment_id)}/refund`, {
          method: 'POST',
          json: { refund_id: r.id },
        }),
      ),
    );
    if (ok !== undefined) onChanged();
  }

  return (
    <li>
      <span className="grow">
        <Link href={`/dashboard/payments/${r.payment_id}`}>{r.external_ref ?? r.payment_id}</Link> ·{' '}
        <RefundLine r={r} livemode={livemode} />
        <br />
        <span className="dash-muted dash-small dash-mono">
          {r.destination
            ? `To ${chainLabel(r.destination_chain ?? '')}: ${r.destination}`
            : 'No destination yet'}
        </span>
        {give && (
          <DestinationForm
            paymentId={r.payment_id}
            refundId={r.id}
            label="Use this address"
            onDone={onChanged}
          />
        )}
      </span>
      {canRedraft && (
        <Button variant="secondary" onClick={() => void redraft()} disabled={redo.busy}>
          {redo.busy ? 'Drafting…' : 'Draft again'}
        </Button>
      )}
      <CancelStoreRefund r={r} onChanged={onChanged} />
      {!r.proposal_id && !give && (
        <button type="button" className="link-button dash-small" onClick={() => setGive(true)}>
          Send to another address
        </button>
      )}
    </li>
  );
}

function DestinationForm({
  paymentId,
  refundId,
  required,
  label,
  onDone,
}: {
  paymentId: string;
  refundId?: string;
  required?: boolean;
  label: string;
  onDone: () => void;
}) {
  const [address, setAddress] = useState('');
  const [chain, setChain] = useState('near');
  const { busy, run } = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      withStepUp(() =>
        api(`/v1/review/${encodeURIComponent(paymentId)}/refund`, {
          method: 'POST',
          json: { ...(refundId ? { refund_id: refundId } : {}), destination: address, chain },
        }),
      ),
    );
    if (ok !== undefined) onDone();
  }

  return (
    <form onSubmit={submit} className="form">
      {required && (
        <p className="dash-muted dash-small">
          Give the address the funds should go to. It is checked against sanctions lists, and your
          signers approve the refund before anything moves. The return fee is deducted; under $1 is
          not returned.
        </p>
      )}
      <div className="row">
        <label className="field">
          <span>Network</span>
          <AssetGridPicker
            ariaLabel="Network"
            title="Chain"
            value={chain}
            onChange={setChain}
            options={chainSelectOptions()}
          />
        </label>
        <label className="field grow">
          <span>Address</span>
          <input
            name="refund-address"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <Button type="submit" disabled={busy || !address}>
        {busy ? 'Drafting…' : label}
      </Button>
    </form>
  );
}
