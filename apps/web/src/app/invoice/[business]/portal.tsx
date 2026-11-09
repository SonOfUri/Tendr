'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { publicEnv } from '@/lib/env';
import { formatUnits, chainLabel } from '@/lib/assets';
import { INVOICE_STATUS, type InvoiceView } from '@/lib/invoices';
import styles from './portal.module.css';

type Token = { assetId: string; symbol: string; decimals: number; blockchain: string };
type Business = { business: { name: string; slug: string }; tokens: Token[] };
export function InvoicePortal({ business }: { business: string }) {
  const [data, setData] = useState<Business | null>(null);
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);
  const [token, setToken] = useState('');
  const [chain, setChain] = useState('');
  const [asset, setAsset] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const base = `${publicEnv.apiBaseUrl}/v1/invoices/public/${encodeURIComponent(business)}`;
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
    setError('');
    const load = secret
      ? request<InvoiceView>('/status', { token: secret }).then((v) => {
          if (active) setInvoice(v);
        })
      : request<Business>().then((v) => {
          if (active) setData(v);
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
        description: form.get('description'),
        amount: form.get('amount'),
        destination: form.get('destination'),
        destinationAsset: asset,
        ...(form.get('dueDate') ? { dueDate: form.get('dueDate') } : {}),
      });
      setSent(true);
    });
  }
  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <p className={styles.brand}>
          Tendr <span>INVOICES</span>
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
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
              <dt>For</dt>
              <dd className={styles.description}>{invoice.description}</dd>
              {invoice.dueDate && (
                <>
                  <dt>Due date</dt>
                  <dd>{invoice.dueDate}</dd>
                </>
              )}
              <dt>Receiving network</dt>
              <dd>{chainLabel(invoice.destinationChain)}</dd>
              <dt>Receiving wallet</dt>
              <dd className={styles.address}>{invoice.destination}</dd>
              <dt>Asset identifier</dt>
              <dd className={styles.address}>{invoice.destinationAsset}</dd>
            </dl>
            {invoice.status === 'awaiting_verification' ? (
              <>
                <p>
                  Confirm these details to send your invoice to the business. The amount and
                  receiving wallet cannot be changed after confirmation.
                </p>
                <button
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
                <p>
                  {invoice.status === 'paid'
                    ? 'The payout provider has confirmed delivery to your wallet.'
                    : invoice.status === 'payment_review'
                      ? 'The business needs to review the payment receipt. Do not submit a duplicate invoice.'
                      : 'Keep the link in your email to check this invoice. The business must approve payment.'}
                </p>
                <button
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
            <h1>Check your email</h1>
            <p>
              Open the private link to review and confirm your invoice. It appears in the business’s
              inbox after confirmation.
            </p>
            <p>
              Already submitted this reference? Use your existing email link. To resend an
              unverified invoice, submit the same email and reference again; its original details
              are kept.
            </p>
          </>
        ) : data ? (
          <>
            <p className={styles.eyebrow}>BILL TO {data.business.name}</p>
            <h1>Send an invoice</h1>
            <p>
              Get paid directly to your crypto wallet. Verify your email to submit; no Tendr account
              required.
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
              <label>
                What is this invoice for?
                <textarea name="description" required maxLength={2000} rows={3} />
              </label>
              <div className={styles.row}>
                <label>
                  Receiving network
                  <select
                    value={chain}
                    required
                    onChange={(e) => {
                      setChain(e.target.value);
                      setAsset('');
                    }}
                  >
                    <option value="">Choose a network</option>
                    {[...new Set(data.tokens.map((t) => t.blockchain))].sort().map((c) => (
                      <option key={c} value={c}>
                        {chainLabel(c)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Receiving token
                  <select
                    value={asset}
                    required
                    disabled={!chain}
                    onChange={(e) => setAsset(e.target.value)}
                  >
                    <option value="">Choose a token</option>
                    {data.tokens
                      .filter((t) => t.blockchain === chain)
                      .map((t) => (
                        <option key={t.assetId} value={t.assetId}>
                          {t.symbol} · {t.assetId.replace('nep141:', '')}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label>
                Amount to receive (in the selected token)
                <input
                  name="amount"
                  inputMode="decimal"
                  placeholder="100.00"
                  required
                  pattern="[0-9]+([.][0-9]+)?"
                />
              </label>
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
              <p>
                Use a wallet on the selected network. Addresses requiring a memo or destination tag
                are not supported. The business covers the quoted transfer cost.
              </p>
              <button type="submit" disabled={busy || !asset}>
                {busy ? 'Sending…' : 'Email me a verification link'}
              </button>
            </form>
          </>
        ) : (
          !error && <p role="status">Loading business…</p>
        )}
        <p className={styles.footer}>Payments approved by the business. Powered by Tendr.</p>
      </div>
    </div>
  );
}
