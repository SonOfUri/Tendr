'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useLoad } from '@/components/dashboard/common';
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

export default function PaymentsPage() {
  const { store, context } = useDashboard();
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pages, setPages] = useState<PaymentSummary[][]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const query = (after?: string) => {
    const q = new URLSearchParams({ limit: '50' });
    if (status) q.set('status', status);
    const f = dayStart(from);
    const t = dayAfter(to);
    if (f) q.set('created_from', f);
    if (t) q.set('created_to', t);
    if (after) q.set('starting_after', after);
    return `/v1/payments?${q.toString()}`;
  };
  const key = context ? `${context.merchantId}:${context.livemode}:${status}:${from}:${to}` : null;
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
    <div className="stack">
      <div>
        <h1>Payments</h1>
        <p className="muted">
          Checkout payments in {context.livemode ? 'live' : 'test'} mode. Open one for its fees,
          transactions and refunds.
        </p>
      </div>

      <form className="row" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          <span>Status</span>
          <select name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
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

      <section className="card">
        {first.error && <Alert tone="danger">{first.error}</Alert>}
        {!first.data ? (
          !first.error && <Spinner label="Loading payments" />
        ) : rows.length === 0 ? (
          <p className="muted">No payments match.</p>
        ) : (
          <ul className="list" data-testid="payments">
            {rows.map((p) => (
              <li key={p.id}>
                <span className="grow">
                  <Link href={`/dashboard/payments/${p.id}`}>
                    {p.order.amount} {p.order.currency}
                  </Link>
                  {p.external_ref && <span className="muted small"> · {p.external_ref}</span>}
                  <br />
                  <span className="muted small">
                    {new Date(p.created_at).toLocaleString()} · received{' '}
                    {formatAmount(p.received.asset, p.received.amount, context.livemode)}
                    {p.source.chain ? ` on ${p.source.chain}` : ''}
                    {p.is_late ? ' · late' : ''}
                  </span>
                </span>
                <Status status={p.status} />
              </li>
            ))}
          </ul>
        )}
        {moreError && <Alert tone="danger">{moreError}</Alert>}
        {cursor && (
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load more
          </Button>
        )}
      </section>
    </div>
  );
}
