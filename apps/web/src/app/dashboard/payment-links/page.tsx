'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { can } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  Copy,
  Link2,
  MoreHorizontal,
  QrCode,
  WifiOff,
} from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Select,
} from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import { canNativeShare, sharePaymentLink } from '@/lib/share-link';
import { useOnline } from '@/components/pwa/PwaInstall';
import { availabilityWords, linkAmountLabel, linkUsesLabel } from '@/lib/payment-link-form';
import { PaymentLinkPreview } from '@/components/dashboard/PaymentLinkPreview';
import { SettlementField } from '@/components/dashboard/SettlementField';
import { toast } from '@/components/toast';
import type { PaymentLinkList, PaymentLinkView } from '@/lib/payment-link-types';

export default function PaymentLinksPage() {
  const { store, context, uiPreview } = useDashboard();
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'inactive'>('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [morePages, setMorePages] = useState<PaymentLinkView[][]>([]);
  const [moreHasMore, setMoreHasMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nativeShare, setNativeShare] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const online = useOnline();
  const [title, setTitle] = useState('');
  const [amountType, setAmountType] = useState<'fixed' | 'open'>('fixed');
  const [amount, setAmount] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [settlementAsset, setSettlementAsset] = useState<string | null>(null);
  const create = useAction();

  useEffect(() => {
    setNativeShare(canNativeShare());
  }, []);

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
    if (!navigator.onLine) return;
    const body: Record<string, unknown> = {
      title: title.trim(),
      amount_type: amountType,
      currency: 'USD',
      note: 'optional',
    };
    if (amountType === 'fixed') body.amount = amount.trim();
    else if (minAmount.trim()) body.min_amount = minAmount.trim();
    if (settlementAsset) body.settlement_asset = settlementAsset;

    const created = await create.run(() =>
      api<PaymentLinkView>('/v1/payment_links', { method: 'POST', json: body }),
    );
    if (!created) return;
    toast.success('Payment link created');
    setTitle('');
    setAmount('');
    setMinAmount('');
    setSettlementAsset(null);
    setCreating(false);
    await list.reload();
  }

  async function sendUrl(link: PaymentLinkView) {
    const result = await sharePaymentLink(link.url, link.title);
    if (result === 'cancelled') return;
    if (result === 'failed') {
      toast.error('Could not copy the link. Select the URL and copy it manually.');
      return;
    }
    toast.success(result === 'shared' ? 'Opened share sheet' : 'Link copied');
    setSentId(link.id);
    window.setTimeout(() => setSentId((current) => (current === link.id ? null : current)), 2000);
  }

  async function setArchived(id: string, archived: boolean) {
    if (!navigator.onLine) return;
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
    if (!ok) return;
    toast.success(archived ? 'Link archived' : 'Link restored');
    await list.reload();
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
            <Button disabled={!online} onClick={() => setCreating((v) => !v)}>
              {creating ? 'Cancel' : 'Create link'}
            </Button>
          ) : null
        }
      />

      {uiPreview ? (
        <Panel>
          <EmptyState
            icon={<WifiOff size={22} strokeWidth={1.75} />}
            title="API offline"
            description="Start Postgres, Redis, and the Tendr API to manage payment links."
          />
        </Panel>
      ) : (
        <>
          {creating && canWrite ? (
            <Panel title="New payment link">
              {!online ? (
                <Alert tone="info">You’re offline. Reconnect to create a payment link.</Alert>
              ) : null}
              <div className="dash-link-editor">
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
                      <Select
                        ariaLabel="Amount type"
                        className="tendr-select--field"
                        value={amountType}
                        onChange={(v) => setAmountType(v as 'fixed' | 'open')}
                        options={[
                          { value: 'fixed', label: 'Fixed' },
                          { value: 'open', label: 'Open' },
                        ]}
                      />
                    </label>
                    <label className="field">
                      <span>Currency</span>
                      <Select
                        ariaLabel="Currency"
                        className="tendr-select--field"
                        value="USD"
                        disabled
                        onChange={() => {}}
                        options={[{ value: 'USD', label: 'USD' }]}
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
                  <SettlementField value={settlementAsset} onChange={setSettlementAsset} disabled={!online} />
                  <div className="actions">
                    <Button type="submit" disabled={create.busy || !online}>
                      {create.busy ? 'Creating…' : 'Create'}
                    </Button>
                  </div>
                </form>
                <PaymentLinkPreview
                  merchantName={store.name}
                  title={title}
                  amountType={amountType}
                  amount={amount}
                  minAmount={minAmount}
                />
              </div>
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
              <PageSkeleton label="Loading payment links" />
            ) : links.length === 0 ? (
              <EmptyState
                icon={<Link2 size={22} strokeWidth={1.75} />}
                title={statusFilter || includeArchived ? 'No links match' : 'No payment links yet'}
                description={
                  statusFilter || includeArchived
                    ? 'Try clearing the filters.'
                    : 'Create a link to share a checkout URL or QR with a customer.'
                }
                action={
                  canWrite && !statusFilter && !includeArchived ? (
                    <button type="button" className="dash-empty-cta" onClick={() => setCreating(true)}>
                      Create link
                    </button>
                  ) : null
                }
              />
            ) : (
              <div className="dash-table-wrap">
                <table className="dash-table dash-links-table">
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
                            className="dash-pill dash-links-status"
                            data-tone={link.availability === 'available' ? 'ok' : 'warn'}
                            title={link.availability}
                          >
                            {availabilityWords(link.availability)}
                          </span>
                        </td>
                        <td className="dash-muted">{linkUsesLabel(link)}</td>
                        <td>
                          <LinkRowActions
                            link={link}
                            canWrite={canWrite}
                            busy={create.busy}
                            shareLabel={
                              sentId === link.id
                                ? nativeShare
                                  ? 'Shared'
                                  : 'Copied'
                                : nativeShare
                                  ? 'Share'
                                  : 'Copy'
                            }
                            copied={sentId === link.id}
                            onShare={() => void sendUrl(link)}
                            onArchive={() => void setArchived(link.id, !link.archived)}
                          />
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

function LinkRowActions({
  link,
  canWrite,
  busy,
  shareLabel,
  copied,
  onShare,
  onArchive,
}: {
  link: PaymentLinkView;
  canWrite: boolean;
  busy: boolean;
  shareLabel: string;
  copied: boolean;
  onShare: () => void;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const href = `/dashboard/payment-links/${encodeURIComponent(link.id)}`;
  const archiveLabel = link.archived ? 'Restore' : 'Archive';

  useEffect(() => {
    if (!open) return;
    function place() {
      const el = buttonRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const width = 196;
      const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
      setMenuStyle({ top: box.bottom + 6, left, width });
    }
    place();
    function onPointer(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.dash-links-menu')) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="dash-links-actions" ref={rootRef}>
      <div className="dash-links-icons">
        <Link href={href} className="dash-links-icon" aria-label="Open" title="Open">
          <ArrowUpRight size={16} strokeWidth={1.75} />
        </Link>
        <button
          type="button"
          className="dash-links-icon"
          aria-label={shareLabel}
          title={shareLabel}
          onClick={onShare}
        >
          {copied ? <Check size={16} strokeWidth={1.75} /> : <Copy size={16} strokeWidth={1.75} />}
        </button>
        <a
          href={link.qr_url}
          target="_blank"
          rel="noreferrer"
          className="dash-links-icon"
          aria-label="QR"
          title="QR"
        >
          <QrCode size={16} strokeWidth={1.75} />
        </a>
        {canWrite ? (
          <button
            type="button"
            className="dash-links-icon"
            aria-label={archiveLabel}
            title={archiveLabel}
            disabled={busy}
            onClick={onArchive}
          >
            {link.archived ? (
              <ArchiveRestore size={16} strokeWidth={1.75} />
            ) : (
              <Archive size={16} strokeWidth={1.75} />
            )}
          </button>
        ) : null}
      </div>
      <div className="dash-links-more">
        <button
          ref={buttonRef}
          type="button"
          className="dash-links-icon"
          aria-label="Actions"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={16} strokeWidth={1.75} />
        </button>
        {open
          ? createPortal(
              <div className="dash-links-menu" role="menu" style={menuStyle}>
                <Link href={href} role="menuitem" onClick={() => setOpen(false)}>
                  <ArrowUpRight size={16} strokeWidth={1.75} /> Open
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onShare();
                    setOpen(false);
                  }}
                >
                  {copied ? <Check size={16} strokeWidth={1.75} /> : <Copy size={16} strokeWidth={1.75} />}{' '}
                  {shareLabel}
                </button>
                <a
                  href={link.qr_url}
                  target="_blank"
                  rel="noreferrer"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                >
                  <QrCode size={16} strokeWidth={1.75} /> QR
                </a>
                {canWrite ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => {
                      onArchive();
                      setOpen(false);
                    }}
                  >
                    {link.archived ? (
                      <ArchiveRestore size={16} strokeWidth={1.75} />
                    ) : (
                      <Archive size={16} strokeWidth={1.75} />
                    )}{' '}
                    {archiveLabel}
                  </button>
                ) : null}
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}
