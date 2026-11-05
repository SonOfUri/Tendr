'use client';

import Link from 'next/link';
import { useState } from 'react';
import { can } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Select,
  TextLink,
} from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import { availabilityWords, linkAmountLabel, linkUsesLabel } from '@/lib/payment-link-form';
import type { PaymentLinkList, PaymentLinkView } from '@/lib/payment-link-types';

export default function PaymentLinksPage() {
  const { store, context, uiPreview } = useDashboard();
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'inactive'>('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [morePages, setMorePages] = useState<PaymentLinkView[][]>([]);
  const [moreHasMore, setMoreHasMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [amountType, setAmountType] = useState<'fixed' | 'open'>('fixed');
  const [amount, setAmount] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const create = useAction();

  const query = (after?: string) => {
    const q = new URLSearchParams({ limit: '50' });
    if (statusFilter) q.set('status', statusFilter);
    if (includeArchived) q.set('include_archived', 'true');
    if (after) q.set('starting_after', after);
    return `/v1/payment_links?${q.toString()}`;
  };
  const key = context
    ? `${context.merchantId}:${context.livemode}:${statusFilter}:${includeArchived}`
    : null;
  const list = useLoad(async () => {
    const r = await api<PaymentLinkList>(query());
    setMorePages([]);
    setMoreError(null);
    return r;
  }, uiPreview ? null : key);

  if (!store || !context) return null;

  const canWrite = can(store.role, 'money:request');
  const links = list.data ? [...list.data.data, ...morePages.flat()] : [];
  const lastPage = morePages.length ? morePages[morePages.length - 1]! : (list.data?.data ?? []);
  const hasMore = morePages.length ? moreHasMore : (list.data?.has_more ?? false);

  async function loadMore() {
    const last = lastPage[lastPage.length - 1];
    if (!last) return;
    try {
      const r = await api<PaymentLinkList>(query(last.id));
      setMorePages((p) => [...p, r.data]);
      setMoreHasMore(r.has_more);
      setMoreError(null);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : 'Could not load more');
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      title: title.trim(),
      amount_type: amountType,
      currency: currency.trim() || 'USD',
      note: 'optional',
    };
    if (amountType === 'fixed') body.amount = amount.trim();
    else if (minAmount.trim()) body.min_amount = minAmount.trim();

    const created = await create.run(() =>
      api<PaymentLinkView>('/v1/payment_links', { method: 'POST', json: body }),
    );
    if (!created) return;
    setTitle('');
    setAmount('');
    setMinAmount('');
    setCreating(false);
    await list.reload();
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* ignore */
    }
  }

  async function setArchived(id: string, archived: boolean) {
    if (
      archived &&
      !window.confirm('Archive this link? It stops taking payments. You can restore it later.')
    ) {
      return;
    }
    const ok = await create.run(() =>
      api<PaymentLinkView>(`/v1/payment_links/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: { archived },
      }),
    );
    if (ok) await list.reload();
  }

  return (
    <>
      <PageHeader
        title="Payment links"
        description={
          <>
            Share a URL or QR for fixed or open-amount checkouts in{' '}
            {context.livemode ? 'live' : 'test'} mode.
          </>
        }
        actions={
          canWrite && !uiPreview ? (
            <Button onClick={() => setCreating((v) => !v)}>
              {creating ? 'Cancel' : 'Create link'}
            </Button>
          ) : null
        }
      />

      {uiPreview ? (
        <Panel>
          <EmptyState
            title="API offline"
            description="Start Postgres, Redis, and the Tendr API to manage payment links."
          />
        </Panel>
      ) : (
        <>
          {creating && canWrite ? (
            <Panel title="New payment link">
              <form className="stack" onSubmit={(e) => void onCreate(e)}>
                <label className="field">
                  <span>Title</span>
                  <input
                    required
                    maxLength={80}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Invoice — spring order"
                  />
                </label>
                <div className="row">
                  <label className="field">
                    <span>Amount type</span>
                    <select
                      value={amountType}
                      onChange={(e) => setAmountType(e.target.value as 'fixed' | 'open')}
                    >
                      <option value="fixed">Fixed</option>
                      <option value="open">Open</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Currency</span>
                    <input
                      required
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      placeholder="USD"
                    />
                  </label>
                  {amountType === 'fixed' ? (
                    <label className="field">
                      <span>Amount</span>
                      <input
                        required
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="25.00"
                      />
                    </label>
                  ) : (
                    <label className="field">
                      <span>Min amount (optional)</span>
                      <input
                        value={minAmount}
                        onChange={(e) => setMinAmount(e.target.value)}
                        placeholder="1.00"
                      />
                    </label>
                  )}
                </div>
                {create.error ? <Alert tone="danger">{create.error}</Alert> : null}
                <div className="actions">
                  <Button type="submit" disabled={create.busy}>
                    {create.busy ? 'Creating…' : 'Create'}
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}

          <Panel title="Filters">
            <div className="dash-filter-bar">
              <label className="field">
                <span>Status</span>
                <Select
                  ariaLabel="Status"
                  className="tendr-select--field"
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v as '' | 'active' | 'inactive')}
                  options={[
                    { value: '', label: 'Any' },
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                  ]}
                />
              </label>
              <label className="field">
                <span>Archived</span>
                <span className="actions">
                  <input
                    type="checkbox"
                    style={{ width: 'auto', minHeight: 0 }}
                    checked={includeArchived}
                    onChange={(e) => setIncludeArchived(e.target.checked)}
                  />
                  <span className="dash-small" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    Include archived
                  </span>
                </span>
              </label>
            </div>
          </Panel>

          <Panel
            title="Your links"
            action={
              links.length ? (
                <span className="dash-muted dash-small">{links.length} shown</span>
              ) : null
            }
          >
            {list.error ? (
              <ErrorState message={list.error} onRetry={() => void list.reload()} />
            ) : !list.data ? (
              <Spinner label="Loading payment links" />
            ) : links.length === 0 ? (
              <EmptyState
                title={statusFilter || includeArchived ? 'No links match' : 'No payment links yet'}
                description={
                  statusFilter || includeArchived
                    ? 'Try clearing the filters.'
                    : 'Create a link to share a checkout URL or QR with a customer.'
                }
                action={
                  canWrite && !statusFilter && !includeArchived ? (
                    <Button variant="secondary" onClick={() => setCreating(true)}>
                      Create your first link
                    </Button>
                  ) : null
                }
              />
            ) : (
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Uses</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((link) => (
                      <tr key={link.id}>
                        <td>
                          <Link href={`/dashboard/payment-links/${encodeURIComponent(link.id)}`}>
                            <strong>{link.title}</strong>
                          </Link>
                          <div className="dash-muted dash-small dash-mono">{link.slug}</div>
                        </td>
                        <td>{linkAmountLabel(link)}</td>
                        <td>
                          <span
                            className="dash-pill"
                            data-tone={link.availability === 'available' ? 'ok' : 'warn'}
                            title={link.availability}
                          >
                            {availabilityWords(link.availability)}
                          </span>
                        </td>
                        <td className="dash-muted">{linkUsesLabel(link)}</td>
                        <td>
                          <div className="actions">
                            <TextLink href={`/dashboard/payment-links/${encodeURIComponent(link.id)}`}>
                              Open
                            </TextLink>
                            <a
                              href={link.qr_url}
                              target="_blank"
                              rel="noreferrer"
                              className="dash-text-link"
                            >
                              QR
                            </a>
                            <Button variant="secondary" onClick={() => void copyUrl(link.url)}>
                              Copy URL
                            </Button>
                            {canWrite ? (
                              link.archived ? (
                                <Button
                                  variant="secondary"
                                  disabled={create.busy}
                                  onClick={() => void setArchived(link.id, false)}
                                >
                                  Restore
                                </Button>
                              ) : (
                                <Button
                                  variant="secondary"
                                  disabled={create.busy}
                                  onClick={() => void setArchived(link.id, true)}
                                >
                                  Archive
                                </Button>
                              )
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {moreError ? <ErrorState message={moreError} /> : null}
            {hasMore ? (
              <div className="actions" style={{ marginTop: '0.85rem' }}>
                <Button variant="secondary" onClick={() => void loadMore()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </Panel>
        </>
      )}
    </>
  );
}
