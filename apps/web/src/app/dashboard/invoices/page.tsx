'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@tendr/ui';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  KeyRound,
  Pause,
  Play,
  Receipt,
  XCircle,
} from 'lucide-react';
import { InvoiceBreakdown } from '@/components/InvoiceBreakdown';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel, Select } from '@/components/dashboard/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { api, type Balances, type StoreContext } from '@/lib/api';
import { formatAmount, formatUnits, chainLabel } from '@/lib/assets';
import { INVOICE_STATUS, formatInvoiceAmount, type InvoiceView } from '@/lib/invoices';
import { signPayout, type NativePayout } from '@/lib/native-wallet';
import { withStepUp } from '@/lib/webauthn';
import { loadIntentsCatalog } from '@/lib/intents-catalog';

type Inbox = { invoices: InvoiceView[]; nextCursor: string | null };

function statusTone(status: InvoiceView['status']): 'ok' | 'warn' | undefined {
  if (status === 'paid') return 'ok';
  if (status === 'open' || status === 'processing' || status === 'payment_review') return 'warn';
  return undefined;
}

export default function InvoicesPage() {
  const { context, store } = useDashboard();
  if (!context || !store) return null;
  if (!context.livemode) {
    return (
      <>
        <PageHeader
          title="Invoices"
          description="Contractor invoices settle from your live wallet. Switch to Live to review and pay."
        />
        <Panel>
          <EmptyState
            title="Live mode required"
            description="Invoicing uses your live native wallet. Switch to Live in the header to enable the page and settle invoices."
            icon={<FileText size={22} />}
          />
        </Panel>
      </>
    );
  }
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

  const invoice = data.data?.inbox.invoices.find((i) => i.id === selected) ?? null;
  const balanceOptions = useMemo(() => {
    const rows = (data.data?.balances ?? []).filter((b) => BigInt(b.amount) > 0n);
    return [
      { value: '', label: 'Choose a wallet balance', disabled: true },
      ...rows.map((b) => ({
        value: b.asset,
        label: sourceAmountLabel(b.asset, b.amount, catalog.data?.tokens),
      })),
    ];
  }, [data.data?.balances, catalog.data?.tokens]);

  function sourceAmountLabel(
    assetId: string,
    amount: string,
    tokens?: { asset: string; decimals: number; symbol: string; chain: string }[],
  ) {
    const token = tokens?.find((t) => t.asset === assetId);
    return token
      ? `${formatUnits(amount, token.decimals)} ${token.symbol} (${chainLabel(token.chain)})`
      : formatAmount(assetId, amount, true);
  }

  function selectInvoice(id: string) {
    setSelected(id);
    setQuote(null);
    setAsset('');
  }

  return (
    <div className="stack">
      <PageHeader
        title="Invoices"
        description="Review contractor invoices and settle from your live wallet with your wallet passkey."
      />
      {data.error ? <ErrorState message={data.error} onRetry={() => void data.reload()} /> : null}
      {!data.data ? (
        <PageSkeleton label="Loading invoices" />
      ) : (
        <>
          <Panel
            title="Invoice page"
            action={
              <span className="dash-pill" data-tone={data.data.settings.enabled ? 'ok' : 'warn'}>
                {data.data.settings.enabled ? 'Accepting' : 'Paused'}
              </span>
            }
          >
            <div className="dash-invoice-page-bar">
              <div className="dash-invoice-page-copy">
                <p className="dash-muted dash-small">
                  {data.data.settings.enabled
                    ? 'Contractors submit here. Only email-verified invoices appear in the inbox.'
                    : 'Enable your page to accept invoices. An active live wallet is required.'}
                </p>
                <a
                  href={data.data.settings.url}
                  target="_blank"
                  rel="noreferrer"
                  className="dash-text-link dash-btn-icon dash-mono dash-small"
                >
                  <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
                  {data.data.settings.url}
                </a>
              </div>
              {owner ? (
                <Button
                  variant="secondary"
                  className="dash-btn-icon"
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
                  {busy ? (
                    data.data.settings.enabled ? (
                      'Pause page'
                    ) : (
                      'Enable page'
                    )
                  ) : data.data.settings.enabled ? (
                    <>
                      <Pause size={16} strokeWidth={1.75} aria-hidden />
                      Pause page
                    </>
                  ) : (
                    <>
                      <Play size={16} strokeWidth={1.75} aria-hidden />
                      Enable page
                    </>
                  )}
                </Button>
              ) : null}
            </div>
          </Panel>

          <div className="dash-invoice-split">
            <Panel title="Inbox">
              {!data.data.inbox.invoices.length ? (
                <EmptyState
                  title="No verified invoices"
                  description={
                    data.data.settings.enabled
                      ? 'Share your invoice page with a contractor. Verified submissions show up here.'
                      : 'Enable your invoice page above so contractors can submit.'
                  }
                  icon={<FileText size={22} />}
                />
              ) : (
                <ul className="dash-invoice-list" role="listbox" aria-label="Invoice inbox">
                  {data.data.inbox.invoices.map((i) => {
                    const active = i.id === selected;
                    return (
                      <li key={i.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          className="dash-invoice-row"
                          data-selected={active ? 'true' : undefined}
                          onClick={() => selectInvoice(i.id)}
                        >
                          <span className="dash-invoice-row-main">
                            <span className="dash-invoice-row-title">
                              {i.reference}
                              <span className="dash-muted"> · {i.contractorName}</span>
                            </span>
                            <span className="dash-invoice-row-meta">
                              {formatInvoiceAmount(i)}
                              {i.dueDate ? ` · Due ${i.dueDate}` : ''}
                            </span>
                          </span>
                          <span className="dash-pill" data-tone={statusTone(i.status)}>
                            {INVOICE_STATUS[i.status]}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {(cursor || data.data.inbox.nextCursor) && (
                <div className="actions" style={{ marginTop: '0.85rem' }}>
                  {cursor ? (
                    <Button
                      variant="secondary"
                      className="dash-btn-icon"
                      disabled={busy}
                      onClick={() => {
                        setCursor(null);
                        setSelected(null);
                        setQuote(null);
                      }}
                    >
                      <ChevronUp size={16} strokeWidth={1.75} aria-hidden />
                      Newest
                    </Button>
                  ) : null}
                  {data.data.inbox.nextCursor ? (
                    <Button
                      variant="secondary"
                      className="dash-btn-icon"
                      disabled={busy}
                      onClick={() => {
                        setCursor(data.data!.inbox.nextCursor);
                        setSelected(null);
                        setQuote(null);
                      }}
                    >
                      <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
                      Older invoices
                    </Button>
                  ) : null}
                </div>
              )}
            </Panel>

            <Panel
              title={invoice ? `Invoice ${invoice.reference}` : 'Settle'}
              action={
                invoice ? (
                  <span className="dash-pill" data-tone={statusTone(invoice.status)}>
                    {INVOICE_STATUS[invoice.status]}
                  </span>
                ) : null
              }
            >
              {!invoice ? (
                <EmptyState
                  title="Select an invoice"
                  description="Choose a row from the inbox to review the breakdown and settle."
                  icon={<FileText size={22} />}
                />
              ) : (
                <div className="stack dash-invoice-detail">
                  <div className="dash-invoice-hero">
                    <p className="dash-invoice-amount">{formatInvoiceAmount(invoice)}</p>
                    <p className="dash-muted dash-small">
                      From {invoice.contractorName} · {invoice.email}
                    </p>
                  </div>

                  <InvoiceBreakdown invoice={invoice} />

                  <dl className="dash-facts">
                    <div>
                      <dt>Receiving network</dt>
                      <dd>{chainLabel(invoice.destinationChain)}</dd>
                    </div>
                    <div>
                      <dt>Receiving wallet</dt>
                      <dd className="dash-mono dash-small">{invoice.destination}</dd>
                    </div>
                  </dl>

                  {invoice.status === 'open' && owner ? (
                    <section className="dash-invoice-settle" aria-label="Settle invoice">
                      <p className="dash-invoice-step">
                        {quote ? '2 · Authorize payout' : '1 · Choose balance & review quote'}
                      </p>

                      <label className="field">
                        <span>Pay from</span>
                        <Select
                          ariaLabel="Pay from wallet balance"
                          className="tendr-select--field"
                          value={asset}
                          disabled={busy || !!quote}
                          options={balanceOptions}
                          onChange={setAsset}
                          placeholder="Choose a wallet balance"
                        />
                      </label>

                      {!quote ? (
                        <div className="actions">
                          <Button
                            className="dash-btn-icon"
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
                            {busy ? (
                              'Preparing…'
                            ) : (
                              <>
                                <Receipt size={16} strokeWidth={1.75} aria-hidden />
                                Review payment quote
                              </>
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            className="dash-btn-icon"
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
                            {busy ? (
                              'Decline'
                            ) : (
                              <>
                                <XCircle size={16} strokeWidth={1.75} aria-hidden />
                                Decline
                              </>
                            )}
                          </Button>
                        </div>
                      ) : (
                        <div className="stack">
                          {quote.quote.tidepoolRoute ? (
                            <p className="dash-muted dash-small">
                              This Test payout uses two swaps. The authorized debit includes both
                              swaps’ fees. If the second swap fails, funds return to your Test
                              wallet in the intermediate token.
                            </p>
                          ) : null}
                          <div className="wallet-quote">
                            <div className="wallet-quote-row">
                              <span className="wallet-quote-label">Authorize up to</span>
                              <strong>
                                {sourceAmountLabel(quote.asset, quote.amount, catalog.data?.tokens)}
                              </strong>
                            </div>
                            <div className="wallet-quote-row">
                              <span className="wallet-quote-label">Contractor receives</span>
                              <strong>
                                {formatUnits(quote.quote.quote.amountOut, invoice.decimals)}{' '}
                                {invoice.symbol}
                              </strong>
                            </div>
                            <div className="wallet-quote-row">
                              <span className="wallet-quote-label">Network</span>
                              <strong>{chainLabel(invoice.destinationChain)}</strong>
                            </div>
                            <div className="wallet-quote-row">
                              <span className="wallet-quote-label">Expires</span>
                              <strong>{new Date(quote.expiresAt).toLocaleString()}</strong>
                            </div>
                          </div>
                          <p className="dash-muted dash-small">
                            {invoice.amountCurrency === 'USD'
                              ? 'The USD invoice total is fixed. This quote locks the receiving token amount at the current rate. '
                              : ''}
                            Transfer costs are included in the debit. Unused input returns to your
                            wallet. Signing uses your wallet passkey.
                          </p>
                          <div className="actions">
                            <Button
                              className="dash-btn-icon"
                              disabled={busy || new Date(quote.expiresAt).getTime() <= Date.now()}
                              onClick={() =>
                                void run(async () => {
                                  await signPayout(context, quote);
                                  setQuote(null);
                                  await data.reload();
                                })
                              }
                            >
                              {busy ? (
                                'Authorizing…'
                              ) : (
                                <>
                                  <KeyRound size={16} strokeWidth={1.75} aria-hidden />
                                  Settle with wallet passkey
                                </>
                              )}
                            </Button>
                            <Button
                              variant="secondary"
                              className="dash-btn-icon"
                              disabled={busy}
                              onClick={() => setQuote(null)}
                            >
                              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
                              Back
                            </Button>
                          </div>
                        </div>
                      )}
                    </section>
                  ) : null}

                  {invoice.status === 'open' && !owner ? (
                    <p className="dash-muted">The wallet owner must approve this invoice.</p>
                  ) : null}

                  {invoice.status === 'processing' ? (
                    <p className="dash-invoice-note" role="status">
                      Payment is confirming. This page refreshes automatically — retrying will not
                      send a second payment.
                    </p>
                  ) : null}

                  {invoice.status === 'payment_review' ? (
                    <p className="dash-invoice-note" role="alert">
                      The payout receipt needs review. Further attempts are blocked. Contact support
                      with invoice <span className="dash-mono">{invoice.id}</span>
                      {invoice.payout?.id ? (
                        <>
                          {' '}
                          and payout <span className="dash-mono">{invoice.payout.id}</span>
                        </>
                      ) : null}
                      .
                    </p>
                  ) : null}

                  {invoice.payout?.providerStatus?.swapDetails?.destinationChainTxHashes?.map(
                    (tx) => (
                      <p
                        className="dash-mono dash-small"
                        style={{ overflowWrap: 'anywhere' }}
                        key={tx.hash}
                      >
                        Tx: {tx.hash}
                      </p>
                    ),
                  )}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
