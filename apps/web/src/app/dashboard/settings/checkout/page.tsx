'use client';

import { useEffect, useState } from 'react';
import { MAX_CHECKOUT_DOMAINS } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { api } from '@/lib/api';
import { CHECKOUT_DEFAULTS_SCOPE_NOTE, type CheckoutSettings } from '@/lib/payments';
import { withStepUp } from '@/lib/webauthn';

type Payer = CheckoutSettings['default_fee_payer'];

export default function CheckoutSettingsPage() {
  const { store, context } = useDashboard();
  const canManage = store?.role === 'owner' || store?.role === 'admin';
  const settings = useLoad(
    () => api<CheckoutSettings>('/v1/settings/checkout'),
    context && canManage ? context.merchantId : null,
  );
  const [domains, setDomains] = useState('');
  const [feePayer, setFeePayer] = useState<Payer>('merchant');
  const [gasPayer, setGasPayer] = useState<Payer>('shopper');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!settings.data) return;
    setDomains(settings.data.checkout_domains.join('\n'));
    setFeePayer(settings.data.default_fee_payer);
    setGasPayer(settings.data.default_gas_payer);
  }, [settings.data]);

  if (!store || !context) return null;
  if (!canManage) {
    return <Alert tone="info">Only owners and admins change checkout settings.</Alert>;
  }
  if (!settings.data) {
    return settings.error ? (
      <Alert tone="danger">{settings.error}</Alert>
    ) : (
      <Spinner label="Loading checkout settings" />
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const list = domains
      .split(/[\n,]/)
      .map((d) => d.trim())
      .filter(Boolean);
    const res = await run(() =>
      withStepUp(() =>
        api<CheckoutSettings>('/v1/settings/checkout', {
          method: 'PATCH',
          json: {
            checkout_domains: list,
            default_fee_payer: feePayer,
            default_gas_payer: gasPayer,
          },
        }),
      ),
    );
    if (res) {
      settings.setData(res);
      setSaved(true);
    }
  }

  return (
    <div className="stack">
      <div>
        <h1>Checkout settings</h1>
        <p className="muted">These apply to both test and live mode.</p>
      </div>
      <form onSubmit={save} className="card form">
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
        <p className="muted small">
          The sites allowed to show the checkout in a frame (modal or widget), one origin per line —
          scheme and host, no path. Up to {MAX_CHECKOUT_DOMAINS}; <code>https://</code> only in
          production.
        </p>
        <div className="row">
          <label className="field">
            <span>Who pays fees by default</span>
            <select
              name="fee-payer"
              value={feePayer}
              onChange={(e) => setFeePayer(e.target.value as Payer)}
            >
              <option value="merchant">You — the shopper pays exactly the order total</option>
              <option value="shopper">The shopper — you receive the full order total</option>
            </select>
          </label>
          <label className="field">
            <span>Who pays gas by default</span>
            <select
              name="gas-payer"
              value={gasPayer}
              onChange={(e) => setGasPayer(e.target.value as Payer)}
            >
              <option value="shopper">The shopper</option>
              <option value="merchant">You — reimbursed from what you receive, capped</option>
            </select>
          </label>
        </div>
        <p className="muted small">
          <strong>{CHECKOUT_DEFAULTS_SCOPE_NOTE}</strong> A session or payment link can override
          these defaults.
        </p>
        {saved && <Alert tone="success">Saved.</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </div>
  );
}
