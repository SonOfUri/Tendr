'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { invoiceBreakdown, MAX_INVOICE_ITEMS } from '@tendr/contracts';
import { InvoiceBreakdown } from '@/components/InvoiceBreakdown';
import { TendrLogo } from '@/components/TendrLogo';
import { DemoAssetModal } from '@/components/demo/DemoAssetModal';
import '@/components/demo/demo-playground.css';
import type { Token } from '@/lib/checkout/api';
import { buildDemoAssetOptions } from '@/lib/demo-assets';
import { publicEnv } from '@/lib/env';
import { formatUnits, chainLabel } from '@/lib/assets';
import { INVOICE_STATUS, type InvoiceView } from '@/lib/invoices';
import styles from './portal.module.css';

type PortalToken = { assetId: string; symbol: string; decimals: number; blockchain: string };
type Business = { business: { name: string; slug: string }; tokens: PortalToken[] };

function toCheckoutTokens(tokens: PortalToken[]): Token[] {
  return tokens.map((t) => ({
    asset_id: t.assetId,
    symbol: t.symbol,
    blockchain: t.blockchain,
    decimals: t.decimals,
    price_usd: null,
    popular: false,
  }));
}

export function InvoicePortal({ business }: { business: string }) {
  const [data, setData] = useState<Business | null>(null);
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);
  const [token, setToken] = useState('');
  const [asset, setAsset] = useState('');
  const [items, setItems] = useState([{ id: 0, description: '', amount: '' }]);
  const nextItemId = useRef(1);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const base = `${publicEnv.apiBaseUrl}/v1/invoices/public/${encodeURIComponent(business)}`;
  const receivingToken = data?.tokens.find((t) => t.assetId === asset);
  const assetOptions = useMemo(
    () => buildDemoAssetOptions(toCheckoutTokens(data?.tokens ?? [])),
    [data?.tokens],
  );
  const total = (() => {
    if (!receivingToken) return { amount: '0', error: '' };
    const entered = items.filter((item) => item.amount !== '');
    if (!entered.length) return { amount: '0', error: '' };
    try {
      return { amount: invoiceBreakdown(entered, receivingToken.decimals).amount, error: '' };
    } catch (e) {
      return { amount: '0', error: (e as Error).message };
    }
  })();

  function changeItem(id: number, field: 'description' | 'amount', value: string) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    );
  }

  async function request<T>(path = '', body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'omit',
      cache: 'no-store',
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Could not load this invoice. Try again.');
    return json;
  }

  useEffect(() => {
    let active = true;
    const secret = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    setToken(secret);
    setInvoice(null);
    setData(null);
    setAsset('');
    setError('');
    const load = secret
      ? request<InvoiceView>('/status', { token: secret }).then((v) => {
          if (active) setInvoice(v);
        })
      : request<Business>().then((v) => {
          if (!active) return;
          setData(v);
          const first = v.tokens[0]?.assetId ?? '';
          setAsset(first);
        });
    void load.catch((e: Error) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
    // The base URL captures only this route's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business]);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void action(async () => {
      await request('', {
        contractorName: form.get('name'),
        email: form.get('email'),
        reference: form.get('reference'),
        items: items.map(({ description, amount }) => ({ description, amount })),
        destination: form.get('destination'),
        destinationAsset: asset,
        ...(form.get('dueDate') ? { dueDate: form.get('dueDate') } : {}),
      });
      setSent(true);
    });
  }

  return (
    <div className={`${styles.shell} dash-demo-asset-field`}>
      <div className={styles.card}>
        <p className={styles.brand}>
          <TendrLogo size={26} tone="white" />
          Tendr <span>INVOICES</span>
        </p>

        {error && (invoice || sent || data) ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}

        {invoice ? (
          <>
            <p className={styles.eyebrow}>{INVOICE_STATUS[invoice.status]}</p>
            <h1>Invoice {invoice.reference}</h1>
            <p className={styles.total}>
              {formatUnits(invoice.amount, invoice.decimals)} {invoice.symbol}
            </p>
            <dl>
              <dt>From</dt>
              <dd>
                {invoice.contractorName} · {invoice.email}
              </dd>
              <dt>Business</dt>
              <dd>{business}</dd>
              {invoice.dueDate ? (
                <>
                  <dt>Due date</dt>
                  <dd>{invoice.dueDate}</dd>
                </>
              ) : null}
              <dt>Receiving network</dt>
              <dd>{chainLabel(invoice.destinationChain)}</dd>
              <dt>Receiving wallet</dt>
              <dd className={styles.address}>{invoice.destination}</dd>
              <dt>Asset</dt>
              <dd className={styles.address}>{invoice.destinationAsset}</dd>
            </dl>
            <InvoiceBreakdown invoice={invoice} />
            {invoice.status === 'awaiting_verification' ? (
              <>
                <p className={styles.lead}>
                  Confirm these details to send your invoice to the business. The amount and
                  receiving wallet cannot be changed after confirmation.
                </p>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy}
                  onClick={() =>
                    void action(async () => setInvoice(await request('/verify', { token })))
                  }
                >
                  {busy ? 'Confirming…' : 'Verify email & send invoice'}
                </button>
              </>
            ) : (
              <>
                <p className={styles.lead}>
                  {invoice.status === 'paid'
                    ? 'The payout provider has confirmed delivery to your wallet.'
                    : invoice.status === 'payment_review'
                      ? 'The business needs to review the payment receipt. Do not submit a duplicate invoice.'
                      : 'Keep the link in your email to check this invoice. The business must approve payment.'}
                </p>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy}
                  onClick={() =>
                    void action(async () => setInvoice(await request('/status', { token })))
                  }
                >
                  {busy ? 'Refreshing…' : 'Refresh status'}
                </button>
              </>
            )}
            {invoice.payout?.providerStatus?.swapDetails?.destinationChainTxHashes?.map((tx) => (
              <p className={styles.address} key={tx.hash}>
                Transaction: {tx.hash}
              </p>
            ))}
          </>
        ) : sent ? (
          <>
            <p className={styles.eyebrow}>Almost there</p>
            <h1>Check your email</h1>
            <p className={styles.lead}>
              Open the private link to review and confirm your invoice. It appears in the business’s
              inbox after confirmation.
            </p>
            <p className={styles.hint}>
              Already submitted this reference? Use your existing email link. To resend an
              unverified invoice, submit the same email and reference again; its original details
              are kept.
            </p>
          </>
        ) : data ? (
          <>
            <p className={styles.eyebrow}>Bill to {data.business.name}</p>
            <h1>Send an invoice</h1>
            <p className={styles.lead}>
              Get paid directly to your crypto wallet. Verify your email to submit — no Tendr
              account required.
            </p>
            <form onSubmit={submit} className={styles.form}>
              <label>
                Your name or business
                <input name="name" required maxLength={120} autoComplete="name" />
              </label>
              <label>
                Email
                <input name="email" type="email" required maxLength={254} autoComplete="email" />
              </label>
              <div className={styles.row}>
                <label>
                  Invoice reference
                  <input name="reference" placeholder="INV-001" required maxLength={80} />
                </label>
                <label>
                  Due date (optional)
                  <input name="dueDate" type="date" />
                </label>
              </div>

              <div className={styles.assetField}>
                <span>Receiving token</span>
                {assetOptions.length ? (
                  <DemoAssetModal
                    options={assetOptions}
                    value={asset}
                    disabled={busy}
                    onChange={setAsset}
                  />
                ) : (
                  <p className={styles.hint}>No receiving tokens are available for this business.</p>
                )}
                {receivingToken ? (
                  <p className={styles.hint}>
                    Network: {chainLabel(receivingToken.blockchain)}
                  </p>
                ) : null}
              </div>

              <fieldset className={styles.breakdown} disabled={busy}>
                <legend>Payment breakdown</legend>
                <p>List each service or expense. All amounts use the selected receiving token.</p>
                {items.map((item, index) => (
                  <div className={styles.lineItem} key={item.id}>
                    <label>
                      Description
                      <input
                        aria-label={`Item ${index + 1} description`}
                        value={item.description}
                        onChange={(e) => changeItem(item.id, 'description', e.target.value)}
                        required
                        maxLength={200}
                        placeholder="e.g. Design work"
                      />
                    </label>
                    <label>
                      Amount{receivingToken ? ` (${receivingToken.symbol})` : ''}
                      <input
                        aria-label={`Item ${index + 1} amount`}
                        value={item.amount}
                        onChange={(e) => changeItem(item.id, 'amount', e.target.value)}
                        inputMode="decimal"
                        required
                        maxLength={70}
                        pattern="[0-9]+([.][0-9]+)?"
                        placeholder="0.00"
                      />
                    </label>
                    <button
                      type="button"
                      className={styles.secondary}
                      aria-label={`Remove item ${index + 1}`}
                      disabled={items.length === 1}
                      onClick={() => setItems((current) => current.filter((i) => i.id !== item.id))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={items.length >= MAX_INVOICE_ITEMS}
                  onClick={() => {
                    const id = nextItemId.current++;
                    setItems((current) => [...current, { id, description: '', amount: '' }]);
                  }}
                >
                  Add line item
                </button>
                {total.error ? (
                  <p role="alert" className={styles.error}>
                    {total.error}
                  </p>
                ) : null}
                <div className={styles.totalRow}>
                  <strong>Total</strong>
                  <output aria-label="Invoice total" aria-live="polite">
                    {receivingToken && !total.error
                      ? `${formatUnits(total.amount, receivingToken.decimals)} ${receivingToken.symbol}`
                      : '—'}
                  </output>
                </div>
              </fieldset>

              <label>
                Receiving wallet address
                <input
                  name="destination"
                  required
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p className={styles.hint}>
                Use a wallet on the selected network. Addresses requiring a memo or destination tag
                are not supported. The business covers the quoted transfer cost.
              </p>
              <button
                type="submit"
                disabled={
                  busy ||
                  !asset ||
                  !!total.error ||
                  items.some((item) => !item.description.trim() || !item.amount)
                }
              >
                {busy ? 'Sending…' : 'Email me a verification link'}
              </button>
            </form>
          </>
        ) : error ? (
          <div className={styles.stateBlock}>
            <h1>Invoice page unavailable</h1>
            <p>
              {/paused|disabled|not accepting/i.test(error)
                ? 'This business has paused new invoices. Ask them to enable their invoice page, then try again.'
                : /expired|invalid|replaced/i.test(error)
                  ? 'This email link is no longer valid. Request a new verification email by submitting the same reference again, or ask the business for help.'
                  : error}
            </p>
          </div>
        ) : (
          <p role="status">Loading business…</p>
        )}

        <p className={styles.footer}>
          <TendrLogo size={16} tone="white" />
          Payments approved by the business · Powered by Tendr
        </p>
      </div>
    </div>
  );
}
