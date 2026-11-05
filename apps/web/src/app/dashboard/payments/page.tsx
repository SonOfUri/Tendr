'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useLoad } from '@/components/dashboard/common';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Select,
} from '@/components/dashboard/ui';
import { formatAmount } from '@/lib/assets';
import { api } from '@/lib/api';
import { PAYMENT_STATUSES, type PaymentList, type PaymentSummary } from '@/lib/payments';

/** The day's start (local time) as ISO, or undefined for an empty date input. */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayAfter = (d: string) => {
  if (!d) return undefined;
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + 1);
  return t.toISOString();
};

/** `useSearchParams` needs a Suspense boundary above it. */
export default function PaymentsPage() {
  return (
    <Suspense fallback={<Spinner label="Loading payments" />}>
      <PaymentsContent />
    </Suspense>
  );
}

function PaymentsContent() {
  const { store, context } = useDashboard();
  const paymentLinkId = useSearchParams().get('payment_link_id')?.trim() || '';
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pages, setPages] = useState<PaymentSummary[][]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const query = (after?: string) => {
    const q = new URLSearchParams({ limit: '50' });
    if (status) q.set('status', status);
    if (paymentLinkId) q.set('payment_link_id', paymentLinkId);
    const f = dayStart(from);
    const t = dayAfter(to);
    if (f) q.set('created_from', f);
    if (t) q.set('created_to', t);
    if (after) q.set('starting_after', after);
    return `/v1/payments?${q.toString()}`;
  };
  const key = context ? `${context.merchantId}:${context.livemode}:${status}:${from}:${to}:${paymentLinkId}` : null;
  const first = useLoad(async () => {
    const r = await api<PaymentList>(query());
    setPages([]);
    setCursor(r.next_cursor);
    return r;
  }, key);

  async function loadMore() {
    if (!cursor) return;
    try {
      const r = await api<PaymentList>(query(cursor));
      setPages((p) => [...p, r.payments]);
      setCursor(r.next_cursor);
      setMoreError(null);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : 'Could not load more');
    }
  }

  if (!store || !context) return null;
  const rows = first.data ? [...first.data.payments, ...pages.flat()] : [];

  return (
    <>
      <PageHeader
        title="Payments"
        description={
          <>
            Checkout payments in {context.livemode ? 'live' : 'test'} mode. Open one for fees,
            transactions and refunds.
          </>
        }
      />

      <Panel title="Filters">
        {paymentLinkId ? (
          <div className="actions" data-testid="payment-link-filter" style={{ marginBottom: '0.85rem' }}>
            <span className="dash-pill" data-tone="ok">
              Payment link: <span className="dash-mono">{paymentLinkId}</span>
            </span>
            <Link
              href={`/dashboard/payment-links/${encodeURIComponent(paymentLinkId)}`}
              className="dash-text-link dash-small"
            >
              View link
            </Link>
            <Link href="/dashboard/payments" className="dash-text-link dash-small">
              Clear filter
            </Link>
          </div>
        ) : null}
        <form className="dash-filter-bar" onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            <span>Status</span>
            <Select
              ariaLabel="Status"
              className="tendr-select--field"
              value={status}
              onChange={setStatus}
              options={[
                { value: '', label: 'Any' },
                ...PAYMENT_STATUSES.map((s) => ({ value: s, label: s })),
              ]}
            />
          </label>
          <label className="field">
            <span>From</span>
            <input type="date" name="from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" name="to" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </form>
      </Panel>

      <Panel title="Results" action={rows.length ? <span className="dash-muted dash-small">{rows.length} shown</span> : null}>
        {first.error ? (
          <ErrorState message={first.error} onRetry={() => void first.reload()} />
        ) : !first.data ? (
          <Spinner label="Loading payments" />
        ) : rows.length === 0 ? (
          <EmptyState title="No payments match"
            description={
              paymentLinkId
                ? 'No payments yet for this payment link. Try clearing the filters.'
                : 'Try clearing filters or wait for the next checkout.'
            }
          />
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table" data-testid="payments">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Received</th>
                  <th>When</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/dashboard/payments/${p.id}`}>
                        <strong>
                          {p.order.amount} {p.order.currency}
                        </strong>
                      </Link>
                      {p.external_ref ? (
                        <div className="dash-muted dash-small">{p.external_ref}</div>
                      ) : null}
                      {p.payment_link_id && !paymentLinkId ? (
                        <div className="dash-small">
                          <Link
                            href={`/dashboard/payment-links/${encodeURIComponent(p.payment_link_id)}`}
                            className="dash-text-link"
                          >
                            via payment link
                          </Link>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {formatAmount(p.received.asset, p.received.amount, context.livemode)}
                      {p.source.chain ? (
                        <div className="dash-muted dash-small">on {p.source.chain}</div>
                      ) : null}
                      {p.is_late ? <div className="dash-muted dash-small">late</div> : null}
                    </td>
                    <td className="dash-muted dash-small">{new Date(p.created_at).toLocaleString()}</td>
                    <td>
                      <Status status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moreError ? <ErrorState message={moreError} /> : null}
        {cursor ? (
          <div className="actions" style={{ marginTop: '0.85rem' }}>
            <Button variant="secondary" onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
