'use client';

import { useEffect, useRef, useState } from 'react';
import { LINK_DESCRIPTION_MAX, LINK_TITLE_MAX } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { api, errorMessage, type StoreContext } from '@/lib/api';
import {
  linkBody,
  linkFields,
  type DashboardPaymentLink,
  type LinkFields,
} from '@/lib/dashboard-payment-links';
import styles from './links.module.css';
import { SettlementSelector } from './SettlementSelector';

export function PaymentLinkForm({
  context,
  existing,
  onSaved,
  onCancel,
}: {
  context: StoreContext;
  existing?: DashboardPaymentLink;
  onSaved(link: DashboardPaymentLink): void;
  onCancel(): void;
}) {
  const [fields, setFields] = useState(() => linkFields(existing));
  const [customSettlement, setCustomSettlement] = useState(Boolean(existing?.settlement_asset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleInput.current?.focus();
  }, []);
  const set = <K extends keyof LinkFields>(key: K, value: LinkFields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (customSettlement && !fields.settlementAsset)
        throw new Error('Choose a chain and token to receive.');
      const json = linkBody(fields, existing);
      const serialized = JSON.stringify(json);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      const result = await api<DashboardPaymentLink>(
        existing ? `/v1/payment_links/${existing.id}` : '/v1/payment_links',
        {
          method: existing ? 'PATCH' : 'POST',
          store: context,
          json,
          // Reuse the key if the response is lost and the same create is retried.
          headers: existing ? undefined : { 'Idempotency-Key': attempt.current.key },
        },
      );
      onSaved(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="link-form-title">
      <h2 id="link-form-title">{existing ? 'Edit payment link' : 'New payment link'}</h2>
      <p className="muted small">
        {context.livemode ? 'Live' : 'Test'} mode · Amounts are priced in your chosen currency.
        Customers choose a supported crypto asset at checkout.
      </p>
      <form onSubmit={submit} className="form">
        <fieldset disabled={busy} className={`${styles.fields} form`}>
          <legend className="sr-only">Payment link details</legend>
          <label className="field">
            <span>Title</span>
            <input
              ref={titleInput}
              required
              maxLength={LINK_TITLE_MAX}
              value={fields.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Coffee subscription"
            />
          </label>
          <label className="field">
            <span>Description (optional)</span>
            <textarea
              rows={3}
              maxLength={LINK_DESCRIPTION_MAX}
              value={fields.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>
          <div className={styles.columns}>
            <label className="field">
              <span>Amount type</span>
              <select
                value={fields.amountType}
                onChange={(e) => set('amountType', e.target.value as LinkFields['amountType'])}
              >
                <option value="fixed">Fixed amount</option>
                <option value="open">Customer chooses amount</option>
              </select>
            </label>
            <label className="field">
              <span>Currency</span>
              <input
                required
                minLength={3}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                value={fields.currency}
                onChange={(e) => set('currency', e.target.value.toUpperCase())}
                placeholder="USD"
                aria-describedby="link-currency-hint"
              />
            </label>
            {fields.amountType === 'fixed' ? (
              <label className="field">
                <span>Amount</span>
                <input
                  required
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]+)?"
                  value={fields.amount}
                  onChange={(e) => set('amount', e.target.value)}
                  placeholder="25.00"
                />
              </label>
            ) : (
              <label className="field">
                <span>Minimum amount (optional)</span>
                <input
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]+)?"
                  value={fields.minimum}
                  onChange={(e) => set('minimum', e.target.value)}
                  placeholder="1.00"
                />
              </label>
            )}
          </div>
          <p id="link-currency-hint" className="muted small">
            Use a supported three-letter currency code, such as USD, NGN or EUR. Payments must be
            worth at least USD 1.00; open amounts also follow this minimum.
          </p>
          <SettlementSelector
            context={context}
            custom={customSettlement}
            value={fields.settlementAsset}
            existing={existing}
            onMode={(custom) => {
              setCustomSettlement(custom);
              if (!custom) set('settlementAsset', '');
            }}
            onChange={(asset) => set('settlementAsset', asset)}
          />
          <div className={styles.columns}>
            <label className="field">
              <span>Customer note</span>
              <select
                value={fields.note}
                onChange={(e) => set('note', e.target.value as LinkFields['note'])}
              >
                <option value="optional">Allow an optional note</option>
                <option value="off">No note</option>
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select
                value={fields.status}
                onChange={(e) => set('status', e.target.value as LinkFields['status'])}
              >
                <option value="active">Active</option>
                <option value="inactive">Paused</option>
              </select>
            </label>
          </div>
          <details>
            <summary>Link options</summary>
            <div className="form">
              {!existing && (
                <label className="field">
                  <span>URL name (optional)</span>
                  <input
                    value={fields.slug}
                    minLength={3}
                    maxLength={60}
                    onChange={(e) => set('slug', e.target.value)}
                    placeholder="coffee-subscription"
                  />
                  <span className="muted small">
                    Leave blank to generate from the title. The URL name cannot be edited later.
                  </span>
                </label>
              )}
              <div className={styles.columns}>
                <label className="field">
                  <span>Expires at (your local time, optional)</span>
                  <input
                    type="datetime-local"
                    value={fields.expires}
                    onChange={(e) => set('expires', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Maximum payments (optional)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={fields.maxUses}
                    onChange={(e) => set('maxUses', e.target.value)}
                    placeholder="Unlimited"
                  />
                </label>
              </div>
            </div>
          </details>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : existing ? 'Save changes' : 'Create link'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
