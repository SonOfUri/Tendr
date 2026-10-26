'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useLoad } from '@/components/dashboard/common';
import { chainLabel, formatAmount } from '@/lib/assets';
import { api } from '@/lib/api';
import {
  explorerTxUrl,
  feeLines,
  formatUsd,
  refundStateWords,
  type PaymentDetail,
  type TxRef,
} from '@/lib/payments';

export default function PaymentPage() {
  const { id } = useParams<{ id: string }>();
  const { store, context } = useDashboard();
  const key = context && id ? `${context.merchantId}:${context.livemode}:${id}` : null;
  const detail = useLoad(() => api<PaymentDetail>(`/v1/payments/${encodeURIComponent(id)}`), key);
  if (!store || !context) return null;
  if (!detail.data) {
    return detail.error ? (
      <Alert tone="danger">{detail.error}</Alert>
    ) : (
      <Spinner label="Loading the payment" />
    );
  }
  const p = detail.data;
  const lm = context.livemode;
  const amount = (asset: string, raw: string | null) =>
    raw === null ? '—' : formatAmount(asset, raw, lm);

  return (
    <div className="stack">
      <div>
        <p className="small">
          <Link href="/dashboard/payments">← Payments</Link>
        </p>
        <h1>
          {p.order.amount} {p.order.currency} <Status status={p.status} />
        </h1>
        <p className="muted small address">
          {p.id} · session {p.session_id}
          {p.external_ref ? ` · order ${p.external_ref}` : ''}
        </p>
      </div>

      {(p.status === 'HELD' || p.held_reason === 'sanctions') && (
        <Alert tone="danger">
          This payment is held. <Link href="/dashboard/review">Open the review queue</Link>.
        </Alert>
      )}

      <section className="card">
        <h2>Amounts</h2>
        <dl className="kv">
          <dt>Order</dt>
          <dd>
            {p.order.amount} {p.order.currency}
          </dd>
          <dt>Received</dt>
          <dd>
            {amount(p.received.asset, p.received.amount)}
            {p.quote.amount_in_usd && (
              <span className="muted"> ({formatUsd(p.quote.amount_in_usd)} at quote)</span>
            )}
          </dd>
          <dt>Source</dt>
          <dd>
            <span className="address">{p.source.asset}</span>
            {p.source.chain && <> on {chainLabel(p.source.chain)}</>}
          </dd>
          <dt>Sender</dt>
          <dd className="address">{p.sender_addresses.join(', ') || p.sender_address || '—'}</dd>
          <dt>Settled to you</dt>
          <dd>{amount(p.settlement.asset, p.settlement.amount_out)}</dd>
          <dt>Fees paid by</dt>
          <dd>
            {p.fee_payer === 'shopper' ? 'Shopper' : 'You'} · gas{' '}
            {p.gas_payer === 'shopper' ? 'shopper' : 'you (reimbursed)'}
          </dd>
          {p.overpaid_amount && (
            <>
              <dt>Overpaid</dt>
              <dd>
                {amount(p.received.asset, p.overpaid_amount)}
                {p.kept_small_overpayment && ' (worth under $1: kept)'}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="card">
        <h2>Fees</h2>
        {p.fees.length === 0 ? (
          <p className="muted">No fees.</p>
        ) : (
          <ul className="list" data-testid="fees">
            {feeLines(p.fees, lm).map((f) => (
              <li key={f.label}>
                <span className="grow">{f.label}</span>
                <span>{f.usd}</span>
                <span className="muted small">{f.amount}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">
          {p.fees_recorded ? 'Recorded at settlement' : 'Computed from the quote'}, at quote prices.
          The network fee is an estimate of the shopper&apos;s send fee on the source chain.
        </p>
      </section>

      <section className="card">
        <h2>Transactions</h2>
        <ul className="list">
          <TxRow label="Shopper's send" tx={p.transactions.origin} livemode={lm} />
          <TxRow label="Settlement" tx={p.transactions.settlement} livemode={lm} />
          <TxRow label="Payout" tx={p.transactions.payout} livemode={lm} />
        </ul>
      </section>

      <section className="card">
        <h2>Refunds</h2>
        {p.refunds.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="list">
            {p.refunds.map((r) => (
              <li key={r.id}>
                <span className="grow">
                  {amount(r.asset, r.amount)} · {r.reason}
                  {r.return_fee && (
                    <span className="muted small">
                      {' '}
                      (return fee {amount(r.asset, r.return_fee)} deducted)
                    </span>
                  )}
                  <br />
                  <span className="muted small address">
                    {r.destination
                      ? `${chainLabel(r.destination_chain ?? '')}: ${r.destination}`
                      : 'No destination yet'}
                  </span>
                  {r.proposal_id && (
                    <>
                      {' '}
                      <Link href={`/dashboard/approvals/${r.proposal_id}`} className="small">
                        proposal
                      </Link>
                    </>
                  )}
                  {r.refund_tx_hash && (
                    <TxLink tx={{ chain: 'near', hash: r.refund_tx_hash }} livemode={lm} />
                  )}
                </span>
                <span className="muted small">{refundStateWords(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TxLink({ tx, livemode }: { tx: TxRef; livemode: boolean }) {
  const url = explorerTxUrl(tx.chain, tx.hash, livemode);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer noopener" className="address small">
      {' '}
      {tx.hash}
    </a>
  ) : (
    <span className="address small"> {tx.hash}</span>
  );
}

function TxRow({ label, tx, livemode }: { label: string; tx: TxRef | null; livemode: boolean }) {
  return (
    <li>
      <span className="grow">
        {label}
        {tx?.chain && <span className="muted small"> ({chainLabel(tx.chain)})</span>}
      </span>
      {tx ? <TxLink tx={tx} livemode={livemode} /> : <span className="muted small">—</span>}
    </li>
  );
}
