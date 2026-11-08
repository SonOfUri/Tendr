'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { MAX_CHECKOUT_DOMAINS, type ConnectedSite } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { ErrorState, PageHeader, Panel, Select } from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import { domainsUsedByConnections } from '@/lib/connect';
import { keepUnsavedEdits, notificationEmailStatus } from '@/lib/notification-email';
import { CHECKOUT_DEFAULTS_SCOPE_NOTE, type CheckoutSettings } from '@/lib/payments';
import { withStepUp } from '@/lib/webauthn';

type Payer = CheckoutSettings['default_fee_payer'];

const patchSettings = (json: Partial<CheckoutSettings>) =>
  withStepUp(() => api<CheckoutSettings>('/v1/settings/checkout', { method: 'PATCH', json }));

export default function CheckoutSettingsPage() {
  const { store, context } = useDashboard();
  const canManage = store?.role === 'owner' || store?.role === 'admin';
  const key = context && canManage ? context.merchantId : null;
  const settings = useLoad(() => api<CheckoutSettings>('/v1/settings/checkout'), key);
  // Only to warn before a save drops a domain a connected site uses; the page works without it.
  const connections = useLoad(() => api<{ connections: ConnectedSite[] }>('/v1/connections'), key);
  const [domains, setDomains] = useState('');
  const [feePayer, setFeePayer] = useState<Payer>('merchant');
  const [gasPayer, setGasPayer] = useState<Payer>('shopper');
  const [saved, setSaved] = useState(false);
  // The connected-site domains the person has agreed to remove (the warning shown once).
  const [confirmedRemoval, setConfirmedRemoval] = useState<string | null>(null);
  const { busy, run } = useAction();

  // The server copy the form was last filled from. When the notification form below saves, the
  // server copy changes under this form: keep what the person typed here (C13).
  const shown = useRef<{ domains: string; feePayer: Payer; gasPayer: Payer } | null>(null);
  useEffect(() => {
    if (!settings.data) return;
    const server = {
      domains: settings.data.checkout_domains.join('\n'),
      feePayer: settings.data.default_fee_payer,
      gasPayer: settings.data.default_gas_payer,
    };
    const next = shown.current
      ? keepUnsavedEdits({ domains, feePayer, gasPayer }, shown.current, server)
      : server;
    shown.current = server;
    setDomains(next.domains);
    setFeePayer(next.feePayer);
    setGasPayer(next.gasPayer);
    // Only when the server copy changes; the form's own values are read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);

  const header = (
    <PageHeader title="Checkout settings" description="These apply to both test and live mode." />
  );

  if (!store || !context) return null;
  if (!canManage) {
    return (
      <div className="stack">
        {header}
        <Alert tone="info">Only owners and admins change checkout settings.</Alert>
      </div>
    );
  }
  if (!settings.data) {
    return (
      <div className="stack">
        {header}
        {settings.error ? (
          <ErrorState message={settings.error} onRetry={() => void settings.reload()} />
        ) : (
          <PageSkeleton label="Loading checkout settings" />
        )}
      </div>
    );
  }

  const list = domains
    .split(/[\n,]/)
    .map((d) => d.trim())
    .filter(Boolean);
  const dropped = domainsUsedByConnections(
    settings.data.checkout_domains,
    list,
    connections.data?.connections ?? [],
  );
  const droppedKey = dropped.map((d) => d.origin).join(' ');
  const needsConfirm = dropped.length > 0 && confirmedRemoval !== droppedKey;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (needsConfirm) {
      setConfirmedRemoval(droppedKey);
      return;
    }
    const res = await run(() =>
      patchSettings({
        checkout_domains: list,
        default_fee_payer: feePayer,
        default_gas_payer: gasPayer,
      }),
    );
    if (res) {
      // This form's own save: show exactly what the server kept.
      shown.current = null;
      settings.setData(res);
      setConfirmedRemoval(null);
      setSaved(true);
    }
  }

  return (
    <div className="stack">
      {header}
      <Panel title="Domains and defaults">
        <form onSubmit={save} className="form">
          <label className="field">
            <span>Checkout domains</span>
            <textarea
              name="checkout-domains"
              rows={5}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="https://shop.example"
            />
          </label>
          <p className="dash-muted dash-small">
            The sites allowed to show the checkout in a frame (modal or widget), one origin per line
            — scheme and host, no path. Up to {MAX_CHECKOUT_DOMAINS};{' '}
            <code className="dash-mono">https://</code> only in production. A site you connect with
            the tendr plugin is added here for you.
          </p>
          {dropped.length > 0 && (
            <Alert tone="warning">
              {dropped.map((d) => d.origin).join(', ')} {dropped.length === 1 ? 'is' : 'are'} used
              by a <Link href="/dashboard/settings/connected-sites">connected site</Link>. Without
              it, that site’s checkout can’t open in its page.{' '}
              {needsConfirm ? 'Save again to remove it anyway.' : 'Saving removes it.'}
            </Alert>
          )}
          <div className="row">
            <label className="field" style={{ flex: '1 1 18rem' }}>
              <span>Who pays fees by default</span>
              <Select
                ariaLabel="Who pays fees by default"
                className="tendr-select--field"
                value={feePayer}
                onChange={(v) => setFeePayer(v as Payer)}
                options={[
                  { value: 'merchant', label: 'You — the shopper pays exactly the order total' },
                  { value: 'shopper', label: 'The shopper — you receive the full order total' },
                ]}
              />
            </label>
            <label className="field" style={{ flex: '1 1 18rem' }}>
              <span>Who pays gas by default</span>
              <Select
                ariaLabel="Who pays gas by default"
                className="tendr-select--field"
                value={gasPayer}
                onChange={(v) => setGasPayer(v as Payer)}
                options={[
                  { value: 'shopper', label: 'The shopper' },
                  { value: 'merchant', label: 'You — reimbursed from what you receive, capped' },
                ]}
              />
            </label>
          </div>
          <p className="dash-muted dash-small">
            <strong>{CHECKOUT_DEFAULTS_SCOPE_NOTE}</strong> A session or payment link can override
            these defaults.
          </p>
          {saved && <Alert tone="success">Saved.</Alert>}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </Panel>
      <NotificationEmail settings={settings.data} onSaved={settings.setData} />
    </div>
  );
}

/** The address for payment and refund notices, and the "You got paid" switch. */
function NotificationEmail({
  settings,
  onSaved,
}: {
  settings: CheckoutSettings;
  onSaved: (s: CheckoutSettings) => void;
}) {
  const [email, setEmail] = useState(settings.notification_email ?? '');
  const [paymentEmails, setPaymentEmails] = useState(settings.payment_emails_enabled);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, run } = useAction();
  const status = notificationEmailStatus(settings);

  useEffect(() => {
    setEmail(settings.notification_email ?? '');
    setPaymentEmails(settings.payment_emails_enabled);
  }, [settings.notification_email, settings.payment_emails_enabled]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const next = email.trim() === '' ? null : email.trim();
    const changed = next !== settings.notification_email;
    const res = await run(() =>
      patchSettings({
        payment_emails_enabled: paymentEmails,
        ...(changed ? { notification_email: next } : {}),
      }),
    );
    if (res) {
      onSaved(res);
      setNotice(
        changed && next !== null && res.notification_email_pending
          ? 'Saved. We sent a link to the new address: notices go there once it is confirmed. The current address was told about the change.'
          : 'Saved.',
      );
    }
  }

  async function resend() {
    if (!settings.notification_email_pending) return;
    setNotice(null);
    const res = await run(() =>
      patchSettings({ notification_email: settings.notification_email_pending }),
    );
    if (res) {
      onSaved(res);
      setNotice('We sent a new link. Earlier links no longer work.');
    }
  }

  return (
    <Panel title="Notification email">
      <form onSubmit={save} className="form">
        <p className="dash-muted dash-small">
          Where payment and refund notices go, for payments from every site, API and payment link.
          Applies to both test and live mode.
        </p>
        <dl className="dash-facts">
          <div>
            <dt>Notices go to</dt>
            <dd>{status.current}</dd>
          </div>
        </dl>
        {status.pending && (
          <Alert tone="info">
            {status.pending}.{' '}
            <button type="button" className="link-button" onClick={resend} disabled={busy}>
              Resend the link
            </button>
          </Alert>
        )}
        <label className="field">
          <span>Address (leave empty to use the owners’ emails)</span>
          <input
            type="email"
            name="notification-email"
            maxLength={254}
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="orders@shop.example"
          />
        </label>
        <p className="dash-muted dash-small">
          A new address takes effect only after someone clicks the link we send to it.
        </p>
        <label className="row">
          <input
            type="checkbox"
            name="payment-emails"
            checked={paymentEmails}
            onChange={(e) => setPaymentEmails(e.target.checked)}
          />
          <span>Email me when a payment arrives (“You got paid”)</span>
        </label>
        {notice && <Alert tone="success">{notice}</Alert>}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
