'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert } from '@tendr/ui';
import { ArrowLeft, ArrowRight, ExternalLink, SearchCheck } from 'lucide-react';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useLoad } from '@/components/dashboard/common';
import { ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { chainLabel, formatAmount, formatTokenAmount } from '@/lib/assets';
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
    return (
      <>
        <p className="dash-small">
          <Link href="/dashboard/payments" className="dash-text-link dash-btn-icon">
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
            Payments
          </Link>
        </p>
        <PageHeader title="Payment" />
        {detail.error ? (
          <ErrorState message={detail.error} onRetry={() => void detail.reload()} />
        ) : (
          <PageSkeleton label="Loading the payment" />
        )}
      </>
    );
  }
  const p = detail.data;
  const lm = context.livemode;
  const amount = (
    asset: string,
    raw: string | null,
    meta?: { symbol?: string | null; decimals?: number | null } | null,
  ) => (raw === null ? '—' : formatTokenAmount(asset, raw, lm, meta));

  return (
    <>
      <p className="dash-small">
        <Link href="/dashboard/payments" className="dash-text-link dash-btn-icon">
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
          Payments
        </Link>
      </p>
      <PageHeader
        title={`${p.order.amount} ${p.order.currency}`}
        actions={<Status status={p.status} />}
        description={
          <span className="dash-mono">
            {p.id} · session {p.session_id}
            {p.external_ref
              ? ` · order ${p.external_ref}`
              : p.payment_link_id
                ? ` · link ${p.payment_link_id}`
                : ''}
          </span>
        }
      />

      {(p.status === 'HELD' || p.held_reason === 'sanctions') && (
        <Alert tone="danger">
          This payment is held.{' '}
          <Link href="/dashboard/review" className="dash-text-link dash-btn-icon">
            <SearchCheck size={16} strokeWidth={1.75} aria-hidden />
            Open the review queue
          </Link>
          .
        </Alert>
      )}

      <Panel title="Amounts">
        <dl className="dash-facts">
          <div>
            <dt>Order</dt>
            <dd>
              {p.order.amount} {p.order.currency}
            </dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>
              {amount(p.received.asset, p.received.amount, p.received)}
              {p.quote.amount_in_usd && (
                <span className="dash-muted"> ({formatUsd(p.quote.amount_in_usd)} at quote)</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {p.source.symbol ? (
                <>
                  {p.source.symbol}
                  <span className="dash-muted dash-small"> ({p.source.asset})</span>
                </>
              ) : (
                <span className="dash-mono">{p.source.asset}</span>
              )}
              {p.source.chain && <> on {chainLabel(p.source.chain)}</>}
            </dd>
          </div>
          <div>
            <dt>Sender</dt>
            <dd className="dash-mono">
              {p.sender_addresses.join(', ') || p.sender_address || '—'}
            </dd>
          </div>
          <div>
            <dt>Settled to you</dt>
            <dd>{amount(p.settlement.asset, p.settlement.amount_out, p.settlement)}</dd>
          </div>
          <div>
            <dt>Fees paid by</dt>
            <dd>
              {p.fee_payer === 'shopper' ? 'Shopper' : 'You'} · gas{' '}
              {p.gas_payer === 'shopper' ? 'shopper' : 'you (reimbursed)'}
            </dd>
          </div>
          {p.overpaid_amount && (
            <div>
              <dt>Overpaid</dt>
              <dd>
                {amount(p.received.asset, p.overpaid_amount, p.received)}
                {p.kept_small_overpayment && ' (worth under $1: kept)'}
              </dd>
            </div>
          )}
        </dl>
      </Panel>

      <Panel title="Fees">
        {p.fees.length === 0 ? (
          <p className="dash-muted">No fees.</p>
        ) : (
          <ul className="list" data-testid="fees">
            {feeLines(p.fees, lm).map((f) => (
              <li key={f.label}>
                <span className="grow">{f.label}</span>
                <span>{f.usd}</span>
                <span className="dash-muted dash-small">{f.amount}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="dash-muted dash-small">
          {p.fees_recorded ? 'Recorded at settlement' : 'Computed from the quote'}, at quote prices.
          The network fee is an estimate of the shopper&apos;s send fee on the source chain.
        </p>
      </Panel>

      <Panel title="Transactions">
        <ul className="list">
          <TxRow label="Shopper's send" tx={p.transactions.origin} livemode={lm} />
          <TxRow label="Settlement" tx={p.transactions.settlement} livemode={lm} />
          <TxRow label="Payout" tx={p.transactions.payout} livemode={lm} />
        </ul>
      </Panel>

      <Panel title="Refunds">
        {p.refunds.length === 0 ? (
          <p className="dash-muted">None.</p>
        ) : (
          <ul className="list">
            {p.refunds.map((r) => (
              <li key={r.id}>
                <span className="grow">
                  {amount(r.asset, r.amount)} · {r.reason}
                  {r.return_fee && (
                    <span className="dash-muted dash-small">
                      {' '}
                      (return fee {amount(r.asset, r.return_fee)} deducted)
                    </span>
                  )}
                  <br />
                  <span className="dash-muted dash-small dash-mono">
                    {r.destination
                      ? `${chainLabel(r.destination_chain ?? '')}: ${r.destination}`
                      : 'No destination yet'}
                  </span>
                  {r.proposal_id && (
                    <>
                      {' '}
                      <Link
                        href={`/dashboard/approvals/${r.proposal_id}`}
                        className="dash-small dash-text-link dash-btn-icon"
                      >
                        <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
                        proposal
                      </Link>
                    </>
                  )}
                  {r.refund_tx_hash && (
                    <TxLink tx={{ chain: 'near', hash: r.refund_tx_hash }} livemode={lm} />
                  )}
                </span>
                <span className="dash-muted dash-small">{refundStateWords(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function TxLink({ tx, livemode }: { tx: TxRef; livemode: boolean }) {
  const url = explorerTxUrl(tx.chain, tx.hash, livemode);
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="dash-mono dash-small dash-text-link dash-btn-icon"
    >
      <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
      {tx.hash}
    </a>
  ) : (
    <span className="dash-mono dash-small"> {tx.hash}</span>
  );
}

function TxRow({ label, tx, livemode }: { label: string; tx: TxRef | null; livemode: boolean }) {
  return (
    <li>
      <span className="grow">
        {label}
        {tx?.chain && <span className="dash-muted dash-small"> ({chainLabel(tx.chain)})</span>}
      </span>
      {tx ? (
        <TxLink tx={tx} livemode={livemode} />
      ) : (
        <span className="dash-muted dash-small">—</span>
      )}
    </li>
  );
}
