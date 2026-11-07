'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { can } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { WifiOff } from 'lucide-react';
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
import { canNativeShare, sharePaymentLink } from '@/lib/share-link';
import { useOnline } from '@/components/pwa/PwaInstall';
import { SettlementField } from '@/components/dashboard/SettlementField';
import { toast } from '@/components/toast';
import {
  availabilityWords,
  buildLinkPatch,
  formFromLink,
  linkAmountLabel,
  linkUsesLabel,
  type LinkForm,
} from '@/lib/payment-link-form';
import type { PaymentLinkView } from '@/lib/payment-link-types';
import { formatUsd } from '@/lib/payments';

type ThemeOption = { id: string; name: string; is_default: boolean };
type ThemeList = { data: ThemeOption[]; has_more: boolean };

const PAYER_OPTIONS = (storeDefault: string) => [
  { value: '', label: storeDefault },
  { value: 'merchant', label: 'Merchant' },
  { value: 'shopper', label: 'Shopper' },
];

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function PaymentLinkDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { store, context, uiPreview } = useDashboard();
  const key = context && id ? `${context.merchantId}:${context.livemode}:${id}` : null;
  const themeKey = context ? `${context.merchantId}:themes` : null;

  const detail = useLoad(
    () => api<PaymentLinkView>(`/v1/payment_links/${encodeURIComponent(id)}`),
    uiPreview ? null : key,
  );
  const themes = useLoad(() => api<ThemeList>('/v1/themes?limit=50'), uiPreview ? null : themeKey);

  const save = useAction();
  const archive = useAction();
  const [form, setForm] = useState<LinkForm | null>(null);
  const [sent, setSent] = useState<'shared' | 'copied' | null>(null);
  const [nativeShare, setNativeShare] = useState(false);
  const online = useOnline();

  const link = detail.data;
  // Reset the form whenever a different version of the link arrives (load, save, restore).
  useEffect(() => {
    setForm(link ? formFromLink(link) : null);
  }, [link]);

  useEffect(() => {
    setNativeShare(canNativeShare());
  }, []);

  if (!store || !context) return null;
  const canWrite = can(store.role, 'money:request');

  const back = (
    <p className="small">
      <Link href="/dashboard/payment-links">← Payment links</Link>
    </p>
  );

  if (uiPreview) {
    return (
      <>
        {back}
        <PageHeader title="Payment link" />
        <Panel>
          <EmptyState
            icon={<WifiOff size={22} strokeWidth={1.75} />}
            title="API offline"
            description="Start Postgres, Redis, and the Tendr API to manage payment links."
          />
        </Panel>
      </>
    );
  }

  if (!link || !form) {
    return (
      <>
        {back}
        <PageHeader title="Payment link" />
        {detail.error ? (
          <ErrorState message={detail.error} onRetry={() => void detail.reload()} />
        ) : (
          <Spinner label="Loading the payment link" />
        )}
      </>
    );
  }

  const set = <K extends keyof LinkForm>(k: K, v: LinkForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const themeList = themes.data?.data ?? [];
  const themeName = (themeId: string | null) => {
    if (!themeId) return 'Business default';
    return themeList.find((t) => t.id === themeId)?.name ?? themeId;
  };
  const themeOptions = [
    { value: '', label: 'Business default' },
    ...themeList.map((t) => ({ value: t.id, label: t.is_default ? `${t.name} (default)` : t.name })),
  ];
  // A link may still name a theme the list did not return (paged out); keep it selectable.
  if (form.themeId && !themeOptions.some((o) => o.value === form.themeId)) {
    themeOptions.push({ value: form.themeId, label: form.themeId });
  }

  async function patch(body: Record<string, unknown>, action: typeof save) {
    const updated = await action.run(() =>
      api<PaymentLinkView>(`/v1/payment_links/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: body,
      }),
    );
    if (updated) detail.setData(updated);
    return updated;
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!online || !link || !form) return;
    const built = buildLinkPatch(link, form);
    if ('error' in built) {
      toast.error(built.error);
      return;
    }
    if (Object.keys(built.body).length === 0) {
      toast.info('No changes to save.');
      return;
    }
    const updated = await patch(built.body, save);
    if (updated) toast.success('Saved.');
  }

  async function onArchive(archived: boolean) {
    if (!online) return;
    if (
      archived &&
      !window.confirm(
        'Archive this link? It stops taking payments and leaves the default list. You can restore it later.',
      )
    ) {
      return;
    }
    const updated = await patch({ archived }, archive);
    if (updated) toast.success(archived ? 'Archived.' : 'Restored.');
  }

  async function sendUrl() {
    const result = await sharePaymentLink(link!.url, link!.title);
    if (result === 'cancelled' || result === 'failed') return;
    setSent(result);
    window.setTimeout(() => setSent(null), 2000);
  }

  const fixed = form.amountType === 'fixed';
  const busy = save.busy || archive.busy;
  const paymentsHref = `/dashboard/payments?payment_link_id=${encodeURIComponent(link.id)}`;
  const sendLabel =
    sent === 'shared' ? 'Shared' : sent === 'copied' ? 'Copied' : nativeShare ? 'Share' : 'Copy URL';

  return (
    <>
      {back}
      <PageHeader
        title={link.title}
        description={
          <>
            <span className="dash-mono">{link.id}</span> ·{' '}
            {context.livemode ? 'live' : 'test'} mode
          </>
        }
        actions={
          <div className="actions">
            <span
              className="dash-pill"
              data-tone={link.availability === 'available' ? 'ok' : 'warn'}
              title={link.availability}
            >
              {availabilityWords(link.availability)}
            </span>
            <Button variant="secondary" onClick={() => void sendUrl()}>
              {sendLabel}
            </Button>
            <TextLink href={paymentsHref}>View payments</TextLink>
            {canWrite ? (
              link.archived ? (
                <Button disabled={busy || !online} onClick={() => void onArchive(false)}>
                  {archive.busy ? 'Restoring…' : 'Restore'}
                </Button>
              ) : (
                <Button variant="secondary" disabled={busy || !online} onClick={() => void onArchive(true)}>
                  {archive.busy ? 'Archiving…' : 'Archive'}
                </Button>
              )
            ) : null}
          </div>
        }
      />

      {link.archived ? (
        <Alert tone="info">
          This link is archived: it takes no payments and is hidden from the default list.
          {canWrite ? ' Restore it to use it again.' : ''}
        </Alert>
      ) : null}

      <Panel title="Overview">
        <div className="dash-account-grid">
          <dl className="kv">
            <dt>Title</dt>
            <dd>{link.title}</dd>
            <dt>Description</dt>
            <dd>{link.description ?? '—'}</dd>
            <dt>Slug</dt>
            <dd className="dash-mono">{link.slug}</dd>
            <dt>URL</dt>
            <dd>
              <a href={link.url} target="_blank" rel="noreferrer" className="dash-text-link dash-mono">
                {link.url}
              </a>
            </dd>
            <dt>Availability</dt>
            <dd>
              {availabilityWords(link.availability)}{' '}
              <span className="dash-muted dash-small">({link.availability})</span>
            </dd>
            <dt>Status</dt>
            <dd>
              {link.status}
              {link.archived ? ' · archived' : ''}
            </dd>
            <dt>Amount</dt>
            <dd>{linkAmountLabel(link)}</dd>
            <dt>Amount type</dt>
            <dd>{link.amount_type}</dd>
            <dt>Currency</dt>
            <dd>{link.currency}</dd>
            <dt>Min amount</dt>
            <dd>{link.min_amount ? `${link.min_amount} ${link.currency}` : '—'}</dd>
            <dt>Payer note</dt>
            <dd>{link.note === 'optional' ? 'Optional' : 'Off'}</dd>
          </dl>
          <dl className="kv">
            <dt>Uses</dt>
            <dd>{linkUsesLabel(link)}</dd>
            <dt>Total paid</dt>
            <dd>
              {link.total_paid} {link.currency}
              <span className="dash-muted dash-small"> · {formatUsd(link.total_paid_usd)}</span>
            </dd>
            <dt>Total refunded</dt>
            <dd>
              {link.total_refunded} {link.currency}
              <span className="dash-muted dash-small"> · {formatUsd(link.total_refunded_usd)}</span>
            </dd>
            <dt>Expires</dt>
            <dd>{fmtDate(link.expires_at)}</dd>
            <dt>Fee payer</dt>
            <dd>{link.fee_payer ?? 'Business default'}</dd>
            <dt>Gas payer</dt>
            <dd>{link.gas_payer ?? 'Business default'}</dd>
            <dt>Settlement token</dt>
            <dd>
              {link.settlement_symbol
                ? `${link.settlement_symbol}${link.settlement_chain ? ` · ${link.settlement_chain}` : ''}`
                : 'Business default'}
            </dd>
            <dt>Gas cap (USD)</dt>
            <dd>{link.gas_max_usd ?? '—'}</dd>
            <dt>Theme</dt>
            <dd>
              {themeName(link.theme_id)}
              {link.theme_id ? (
                <span className="dash-muted dash-small dash-mono"> · {link.theme_id}</span>
              ) : null}
            </dd>
            <dt>Created</dt>
            <dd>{fmtDate(link.created_at)}</dd>
            <dt>Updated</dt>
            <dd>{fmtDate(link.updated_at)}</dd>
          </dl>
          <div className="stack">
            <span className="dash-muted dash-small">QR code</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={link.qr_url}
              alt={`QR code for ${link.title}`}
              width={176}
              height={176}
              style={{ background: '#fff', padding: 8, borderRadius: 10 }}
            />
            <a
              href={link.qr_url}
              target="_blank"
              rel="noreferrer"
              className="dash-text-link dash-small"
            >
              Open QR image
            </a>
          </div>
        </div>
      </Panel>

      {canWrite ? (
        <Panel title="Edit link">
          <form className="stack" onSubmit={(e) => void onSave(e)}>
            <label className="field">
              <span>Title</span>
              <input
                required
                maxLength={80}
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                rows={3}
                maxLength={500}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </label>
            <div className="row">
              <label className="field">
                <span>Amount type</span>
                <Select
                  ariaLabel="Amount type"
                  className="tendr-select--field"
                  value={form.amountType}
                  onChange={(v) => set('amountType', v as LinkForm['amountType'])}
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
                  value={form.currency}
                  disabled
                  onChange={() => {}}
                  options={[{ value: form.currency, label: form.currency }]}
                />
              </label>
              {fixed ? (
                <label className="field">
                  <span>Amount</span>
                  <input
                    required
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(e) => set('amount', e.target.value)}
                    placeholder="25.00"
                  />
                </label>
              ) : (
                <label className="field">
                  <span>Min amount (optional)</span>
                  <input
                    inputMode="decimal"
                    value={form.minAmount}
                    onChange={(e) => set('minAmount', e.target.value)}
                    placeholder="1.00"
                  />
                </label>
              )}
            </div>
            <div className="row">
              <label className="field">
                <span>Status</span>
                <Select
                  ariaLabel="Status"
                  className="tendr-select--field"
                  value={form.status}
                  onChange={(v) => set('status', v as LinkForm['status'])}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive (switched off)' },
                  ]}
                />
              </label>
              <label className="field">
                <span>Payer note</span>
                <Select
                  ariaLabel="Payer note"
                  className="tendr-select--field"
                  value={form.note}
                  onChange={(v) => set('note', v as LinkForm['note'])}
                  options={[
                    { value: 'optional', label: 'Optional' },
                    { value: 'off', label: 'Off' },
                  ]}
                />
              </label>
              <label className="field">
                <span>Expires at</span>
                <input
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(e) => set('expiresAt', e.target.value)}
                />
              </label>
              <label className="field">
                <span>Max uses</span>
                <input
                  inputMode="numeric"
                  value={form.maxUses}
                  onChange={(e) => set('maxUses', e.target.value)}
                  placeholder="Unlimited"
                />
              </label>
            </div>
            <div className="row">
              <label className="field">
                <span>Fee payer</span>
                <Select
                  ariaLabel="Fee payer"
                  className="tendr-select--field"
                  value={form.feePayer}
                  onChange={(v) => set('feePayer', v as LinkForm['feePayer'])}
                  options={PAYER_OPTIONS('Business default')}
                />
              </label>
              <label className="field">
                <span>Gas payer</span>
                <Select
                  ariaLabel="Gas payer"
                  className="tendr-select--field"
                  value={form.gasPayer}
                  onChange={(v) => set('gasPayer', v as LinkForm['gasPayer'])}
                  options={PAYER_OPTIONS('Business default')}
                />
              </label>
              <label className="field">
                <span>Gas cap (USD)</span>
                <input
                  inputMode="decimal"
                  value={form.gasMaxUsd}
                  onChange={(e) => set('gasMaxUsd', e.target.value)}
                  placeholder="No cap"
                />
              </label>
              <label className="field">
                <span>Theme</span>
                <Select
                  ariaLabel="Theme"
                  className="tendr-select--field"
                  value={form.themeId}
                  onChange={(v) => set('themeId', v)}
                  options={themeOptions}
                />
              </label>
            </div>
            <SettlementField
              value={form.settlementAsset}
              onChange={(asset) => set('settlementAsset', asset)}
              disabled={!online}
            />
            {themes.error ? (
              <p className="dash-muted dash-small">Themes could not be loaded: {themes.error}</p>
            ) : null}
            <p className="dash-muted dash-small">
              The slug <span className="dash-mono">{link.slug}</span> is part of the shared URL and
              can never change.
            </p>
            {!online ? (
              <Alert tone="info">You’re offline. Reconnect to save this payment link.</Alert>
            ) : null}
            <div className="actions">
              <Button type="submit" disabled={busy || !online}>
                {save.busy ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setForm(formFromLink(link))}
              >
                Reset
              </Button>
            </div>
          </form>
        </Panel>
      ) : (
        <p className="dash-muted dash-small">Your role can view this link but not change it.</p>
      )}
    </>
  );
}
