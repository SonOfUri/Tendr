'use client';
import { useEffect, useState } from 'react';
import { Button } from '@tendr/ui';
import { InvoiceBreakdown } from '@/components/InvoiceBreakdown';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { PageHeader, Panel, ErrorState } from '@/components/dashboard/ui';
import { api, type Balances, type StoreContext } from '@/lib/api';
import { formatAmount, formatUnits, chainLabel } from '@/lib/assets';
import { INVOICE_STATUS, type InvoiceView } from '@/lib/invoices';
import { signPayout, type NativePayout } from '@/lib/native-wallet';
import { withStepUp } from '@/lib/webauthn';
import { loadIntentsCatalog } from '@/lib/intents-catalog';

type Inbox = { invoices: InvoiceView[]; nextCursor: string | null };
export default function InvoicesPage() {
  const { context, store } = useDashboard();
  if (!context || !store) return null;
  if (!context.livemode)
    return (
      <>
        <PageHeader title="Invoices" />
        <Panel>Switch to Live to receive and settle contractor invoices from your wallet.</Panel>
      </>
    );
  return <Inbox key={context.merchantId} context={context} owner={store.role === 'owner'} />;
}
function Inbox({ context, owner }: { context: StoreContext; owner: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [asset, setAsset] = useState('');
  const [quote, setQuote] = useState<NativePayout | null>(null);
  const { busy, run } = useAction();
  const data = useLoad(
    async () => {
      const [settings, inbox, balances] = await Promise.all([
        api<{ enabled: boolean; url: string }>('/v1/invoices/settings', { store: context }),
        api<Inbox>(`/v1/invoices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
          store: context,
        }),
        owner
          ? api<Balances>('/v1/account/balances', { store: context })
          : Promise.resolve({ balances: [] }),
      ]);
      return { settings, inbox, balances: balances.balances };
    },
    `${context.merchantId}:${cursor ?? ''}`,
  );
  const catalog = useLoad(() => loadIntentsCatalog(), context.merchantId);
  const reload = data.reload;
  useEffect(() => {
    const timer = setInterval(() => {
      void reload();
    }, 10_000);
    return () => clearInterval(timer);
  }, [reload]);
  const invoice = data.data?.inbox.invoices.find((i) => i.id === selected);
  function sourceAmount(asset: string, amount: string) {
    const token = catalog.data?.tokens.find((t) => t.asset === asset);
    return token
      ? `${formatUnits(amount, token.decimals)} ${token.symbol} (${chainLabel(token.chain)})`
      : formatAmount(asset, amount, true);
  }
  return (
    <div className="stack">
      <PageHeader
        title="Invoices"
        description="Review contractor invoices and pay from your live wallet with your wallet passkey."
      />
      {data.error && <ErrorState message={data.error} onRetry={() => void data.reload()} />}
      {!data.data ? (
        <p role="status">Loading invoices…</p>
      ) : (
        <>
          <Panel title="Your invoice page">
            <div className="stack">
              <p>
                {data.data.settings.enabled
                  ? 'Contractors can send invoices at:'
                  : 'Enable your page to accept invoices. An active live wallet is required.'}
              </p>
              <a href={data.data.settings.url} target="_blank" rel="noreferrer">
                {data.data.settings.url}
              </a>
              {owner && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await withStepUp(() =>
                        api('/v1/invoices/settings', {
                          method: 'PUT',
                          json: { enabled: !data.data!.settings.enabled },
                          store: context,
                        }),
                      );
                      await data.reload();
                    })
                  }
                >
                  {data.data.settings.enabled ? 'Pause new invoices' : 'Enable invoice page'}
                </Button>
              )}
            </div>
          </Panel>
          <Panel title="Inbox">
            <div className="stack">
              {!data.data.inbox.invoices.length && (
                <p>No verified invoices yet. Share your invoice page with a contractor.</p>
              )}
              {data.data.inbox.invoices.map((i) => (
                <button
                  key={i.id}
                  className="dash-panel"
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => {
                    setSelected(i.id);
                    setQuote(null);
                    setAsset('');
                  }}
                >
                  <strong>
                    {i.reference} · {i.contractorName}
                  </strong>
                  <p>
                    {formatUnits(i.amount, i.decimals)} {i.symbol} on{' '}
                    {chainLabel(i.destinationChain)} · {INVOICE_STATUS[i.status]}
                  </p>
                  {i.dueDate && <small>Due {i.dueDate}</small>}
                </button>
              ))}
              <div>
                {cursor && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setCursor(null);
                      setSelected(null);
                      setQuote(null);
                    }}
                  >
                    Newest
                  </Button>
                )}
                {data.data.inbox.nextCursor && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setCursor(data.data!.inbox.nextCursor);
                      setSelected(null);
                      setQuote(null);
                    }}
                  >
                    Older invoices
                  </Button>
                )}
              </div>
            </div>
          </Panel>
          {invoice && (
            <Panel title={`Invoice ${invoice.reference}`}>
              <div className="stack">
                <p>
                  <strong>
                    {formatUnits(invoice.amount, invoice.decimals)} {invoice.symbol}
                  </strong>{' '}
                  · {INVOICE_STATUS[invoice.status]}
                </p>
                <p>
                  From {invoice.contractorName} ({invoice.email}) · Email verified
                </p>
                <InvoiceBreakdown invoice={invoice} />
                <p>Receiving network: {chainLabel(invoice.destinationChain)}</p>
                <p style={{ overflowWrap: 'anywhere' }}>
                  Receiving wallet: <code>{invoice.destination}</code>
                </p>
                <p style={{ overflowWrap: 'anywhere' }}>
                  Receiving asset: <code>{invoice.destinationAsset}</code>
                </p>
                {invoice.status === 'open' && owner && (
                  <>
                    <label className="stack">
                      Pay from
                      <select
                        className="input"
                        value={asset}
                        disabled={busy || !!quote}
                        onChange={(e) => setAsset(e.target.value)}
                      >
                        <option value="">Choose a wallet balance</option>
                        {data.data.balances
                          .filter((b) => BigInt(b.amount) > 0n)
                          .map((b) => (
                            <option key={b.asset} value={b.asset}>
                              {sourceAmount(b.asset, b.amount)}
                            </option>
                          ))}
                      </select>
                    </label>
                    {!quote ? (
                      <Button
                        disabled={busy || !asset}
                        onClick={() =>
                          void run(async () => {
                            setQuote(
                              await withStepUp(() =>
                                api<NativePayout>(`/v1/invoices/${invoice.id}/payout`, {
                                  method: 'POST',
                                  json: { asset },
                                  store: context,
                                }),
                              ),
                            );
                          })
                        }
                      >
                        {busy ? 'Preparing…' : 'Review payment quote'}
                      </Button>
                    ) : (
                      <div className="stack">
                        <p>
                          You authorize up to{' '}
                          <strong>{sourceAmount(quote.asset, quote.amount)}</strong> from your
                          wallet. The contractor receives{' '}
                          <strong>
                            {formatUnits(invoice.amount, invoice.decimals)} {invoice.symbol}
                          </strong>{' '}
                          on {chainLabel(invoice.destinationChain)}. The quoted debit includes
                          transfer costs; any unused input is returned to your wallet.
                        </p>
                        <p>Quote expires: {new Date(quote.expiresAt).toLocaleString()}</p>
                        <Button
                          disabled={busy || new Date(quote.expiresAt).getTime() <= Date.now()}
                          onClick={() =>
                            void run(async () => {
                              await signPayout(context, quote);
                              setQuote(null);
                              await data.reload();
                            })
                          }
                        >
                          {busy ? 'Authorizing…' : 'Settle invoice with wallet passkey'}
                        </Button>
                        <Button disabled={busy} onClick={() => setQuote(null)}>
                          Back to invoice
                        </Button>
                      </div>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            'Decline this invoice? Its payment quote will be cancelled.',
                          )
                        )
                          return;
                        void run(async () => {
                          await withStepUp(() =>
                            api(`/v1/invoices/${invoice.id}/reject`, {
                              method: 'POST',
                              json: {},
                              store: context,
                            }),
                          );
                          setQuote(null);
                          await data.reload();
                        });
                      }}
                    >
                      Decline invoice
                    </Button>
                  </>
                )}
                {invoice.status === 'processing' && (
                  <p>
                    Payment is being confirmed. This page refreshes automatically. Retrying will not
                    send a second payment.
                  </p>
                )}
                {invoice.status === 'payment_review' && (
                  <p>
                    The payout receipt needs review. Further payment attempts are blocked. Contact
                    support with invoice {invoice.id} and payout {invoice.payout?.id}.
                  </p>
                )}
                {invoice.payout?.providerStatus?.swapDetails?.destinationChainTxHashes?.map(
                  (tx) => (
                    <p style={{ overflowWrap: 'anywhere' }} key={tx.hash}>
                      Transaction: <code>{tx.hash}</code>
                    </p>
                  ),
                )}
                {!owner && <p>The wallet owner must approve this invoice.</p>}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
