'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { CircleCheck } from 'lucide-react';
import { ChainLogo, TokenLogo } from '@/components/dashboard/asset-logos';
import { AssetGridPicker } from '@/components/dashboard/AssetGridPicker';
import { Panel } from '@/components/dashboard/ui';
import { assetInfo, chainLabel, formatAmount, formatUnits, parseUnits } from '@/lib/assets';
import {
  api,
  errorMessage,
  type AccountView,
  type Balances,
  type GoLiveStatus,
  type StoreContext,
} from '@/lib/api';
import { toast } from '@/components/toast';
import { withStepUp } from '@/lib/webauthn';
import {
  activateWallet,
  registerWallet,
  signPayout,
  type NativePayout,
} from '@/lib/native-wallet';

type WalletData = {
  view: AccountView;
  status: GoLiveStatus;
  balances: Balances;
  tokens: SettlementToken[];
  payouts: NativePayout[];
};

type SettlementToken = { asset: string; symbol: string; chain: string; decimals: number };

const PCTS = [25, 50, 75, 100] as const;

export function NativeWalletSetup({
  view,
  status,
  store,
  userId,
  isOwner,
  onDone,
}: {
  view: AccountView;
  status: GoLiveStatus;
  store: StoreContext;
  userId: string;
  isOwner: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const wallet = view.nativeWallet;
  const mine = isOwner && (!wallet || wallet.ownerUserId === userId);
  const active = view.account?.status === 'active';
  const closed = status.checklist.missing.includes('live_mode_unavailable');

  async function setup() {
    setBusy(true);
    try {
      if (!wallet) await registerWallet(store);
      await activateWallet(store);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return <Alert tone="info">Live mode is turned off for this platform right now.</Alert>;
  }
  if (active) {
    return (
      <div className="dash-golive-ready">
        <span className="dash-golive-ready-mark" aria-hidden>
          <CircleCheck size={22} strokeWidth={1.85} />
        </span>
        <div className="dash-golive-ready-copy">
          <strong>Wallet activated</strong>
          <p className="dash-muted dash-small">
            Settlement and withdrawals are on the{' '}
            <Link href="/dashboard/wallet">wallet page</Link>.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="dash-muted">
        {wallet
          ? 'This wallet exists but is not active yet. Finish activation with its passkey. That does not move any money.'
          : 'Create the wallet passkey, then activate the wallet. Activation does not move any money, and it sets the store default to NEAR USDC until you change it.'}
      </p>
      <div>
        <Button disabled={!mine || busy} onClick={() => void setup()}>
          {busy ? 'Waiting for your passkey…' : wallet ? 'Finish wallet activation' : 'Create wallet passkey and activate'}
        </Button>
      </div>
      {!mine ? (
        <p className="dash-muted dash-small">
          Only the store owner who holds this wallet passkey can finish setup.
        </p>
      ) : null}
    </div>
  );
}

export function NativeWalletPanel({
  merchantId,
  userId,
  isOwner,
  proposalId,
}: {
  merchantId: string;
  userId: string;
  isOwner: boolean;
  proposalId?: string;
}) {
  const store: StoreContext = { merchantId, livemode: true };
  const [data, setData] = useState<WalletData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settlement, setSettlement] = useState('');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [destinationAsset, setDestinationAsset] = useState('');
  const [destination, setDestination] = useState('');
  const [review, setReview] = useState<NativePayout | null>(null);

  async function load() {
    const [view, status, balances] = await Promise.all([
      api<AccountView>('/v1/account', { store }),
      api<GoLiveStatus>('/v1/account/go-live', { store }),
      api<Balances>('/v1/account/balances', { store }),
    ]);
    const native =
      view.account?.kind === 'native_intents' ||
      (!view.account && status.accountKind === 'native_intents');
    if (view.account?.kind === 'contract' || !native) {
      setData({ view, status, balances, tokens: [], payouts: [] });
      return;
    }
    const active = view.account?.status === 'active';
    const [options, history] = await Promise.all([
      active
        ? api<{ tokens: SettlementToken[] }>('/v1/payment_links/settlement-options', { store })
        : Promise.resolve({ tokens: [] as SettlementToken[] }),
      active
        ? api<{ payouts: NativePayout[] }>('/v1/account/native/payouts', { store })
        : Promise.resolve({ payouts: [] as NativePayout[] }),
    ]);
    setData({ view, status, balances, tokens: options.tokens, payouts: history.payouts });
  }

  useEffect(() => {
    const controller = new AbortController();
    void load()
      .then(() => {
        if (!controller.signal.aborted) setLoadFailed(false);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
          toast.error(errorMessage(err));
        }
      });
    return () => controller.abort();
    // store identity is merchant id; livemode is always live here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  const pending = data?.payouts.some((p) => p.status === 'submitting' || p.status === 'submitted');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void load().catch((err) => toast.error(errorMessage(err)));
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, merchantId]);

  async function run(op: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await op();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return loadFailed ? (
      <p className="dash-muted">Couldn’t load the wallet. Try again in a moment.</p>
    ) : (
      <PageSkeleton label="Loading wallet" rows={3} />
    );
  }

  const native =
    data.view.account?.kind === 'native_intents' ||
    (!data.view.account && data.status.accountKind === 'native_intents');
  if (!native) {
    return (
      <Alert tone="info">
        This store uses a shared contract account. Withdrawals and settlement changes go through
        approvals, not a single wallet passkey.
      </Alert>
    );
  }

  const active = data.view.account?.status === 'active';
  const mine =
    isOwner && (!data.view.nativeWallet || data.view.nativeWallet.ownerUserId === userId);
  const tokenOptions = data.tokens.map((token) => ({
    value: token.asset,
    label: `${token.symbol} · ${chainLabel(token.chain)}`,
    icon: <TokenLogo symbol={token.symbol} assetId={token.asset} />,
  }));

  function tokenMeta(id: string): { symbol: string; decimals: number; chain: string } {
    const token = data!.tokens.find((t) => t.asset === id);
    if (token) return { symbol: token.symbol, decimals: token.decimals, chain: token.chain };
    const info = assetInfo(id, true);
    return {
      symbol: info.symbol,
      decimals: info.decimals,
      chain: id.startsWith('nep141:') ? 'near' : '',
    };
  }

  function showAmount(id: string, raw: string) {
    const meta = tokenMeta(id);
    if (data!.tokens.some((t) => t.asset === id) || assetInfo(id, true).known) {
      return `${formatUnits(raw, meta.decimals)} ${meta.symbol}`;
    }
    return formatAmount(id, raw, true);
  }

  function selectBalance(id: string) {
    setAsset(id);
    setPct(null);
    setAmount('');
  }

  function applyPct(n: number) {
    if (!asset) return;
    const bal = data!.balances.balances.find((b) => b.asset === asset);
    if (!bal) return;
    const { decimals } = tokenMeta(asset);
    const slice = ((BigInt(bal.amount) * BigInt(n)) / 100n).toString();
    const human = formatUnits(slice, decimals);
    // Round-trip through parseUnits so the field matches what quote will accept.
    const raw = parseUnits(human, decimals);
    setAmount(raw != null ? formatUnits(raw, decimals) : human);
    setPct(n);
  }

  async function quote() {
    await run(async () => {
      const { decimals } = tokenMeta(asset);
      const raw = asset ? parseUnits(amount, decimals) : null;
      if (!proposalId && (raw === null || BigInt(raw) <= 0n)) {
        throw new Error('Enter a valid amount for the selected token.');
      }
      const payout = await withStepUp(() =>
        api<NativePayout>('/v1/account/native/payouts', {
          method: 'POST',
          store,
          json: proposalId
            ? { proposalId }
            : {
                asset,
                amount: raw ?? undefined,
                destinationAsset,
                destination: destination.trim(),
              },
        }),
      );
      setReview(payout);
    });
  }

  const funded = data.balances.balances.filter((b) => {
    try {
      return BigInt(b.amount) > 0n;
    } catch {
      return false;
    }
  });

  return (
    <div className="stack wallet-layout">
      <NativeWalletSetup
        view={data.view}
        status={data.status}
        store={store}
        userId={userId}
        isOwner={isOwner}
        onDone={() => void load().catch((err) => toast.error(errorMessage(err)))}
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {active ? (
        <>
          {!mine ? (
            <Alert tone="info">
              You can view this wallet. Only its owner can change settlement or authorize payouts.
            </Alert>
          ) : null}
          <Panel title="Balances">
            {funded.length ? (
              <div className="wallet-balances" role="listbox" aria-label="Balances">
                {funded.map((b) => {
                  const meta = tokenMeta(b.asset);
                  const selected = asset === b.asset;
                  return (
                    <button
                      key={b.asset}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className="wallet-bal-card"
                      data-selected={selected ? 'true' : 'false'}
                      disabled={busy || Boolean(proposalId)}
                      onClick={() => selectBalance(b.asset)}
                    >
                      <div className="wallet-bal-top">
                        <TokenLogo symbol={meta.symbol} assetId={b.asset} size={22} />
                        <span className="wallet-bal-sym">{meta.symbol}</span>
                      </div>
                      <div className="wallet-bal-amt">{formatUnits(b.amount, meta.decimals)}</div>
                      {meta.chain ? (
                        <div className="wallet-bal-chain">{chainLabel(meta.chain)}</div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="dash-muted">No funds received yet.</p>
            )}
          </Panel>
          {!proposalId ? (
            <Panel title="Default settlement token">
              <label className="field">
                <span>Settlement asset</span>
                <AssetGridPicker
                  ariaLabel="Settlement asset"
                  title="Settlement token"
                  value={settlement}
                  disabled={!mine || busy}
                  onChange={setSettlement}
                  placeholder="Choose token and chain"
                  options={tokenOptions}
                />
              </label>
              <p className="dash-muted dash-small">
                Payments credit this token inside your Intents wallet. A payment link can pick a
                different token. This does not send funds to an outside address.
              </p>
              <div>
                <Button
                  disabled={!mine || busy || !settlement}
                  onClick={() =>
                    void run(async () => {
                      await withStepUp(() =>
                        api('/v1/account/native/settlement', {
                          method: 'PUT',
                          json: { asset: settlement },
                          store,
                        }),
                      );
                      setNotice('Default settlement updated.');
                    })
                  }
                >
                  Save settlement
                </Button>
              </div>
            </Panel>
          ) : null}
          {mine ? (
            <Panel title={proposalId ? 'Refund quote' : 'Withdraw'}>
              {proposalId ? (
                <p className="dash-muted">
                  The quote uses the amount and destination already on this refund. A signed payout
                  cannot be cancelled here.
                </p>
              ) : (
                <>
                  <label className="field">
                    <span>Amount to send{asset ? ` (${tokenMeta(asset).symbol})` : ''}</span>
                    <input
                      value={amount}
                      disabled={busy || !asset}
                      inputMode="decimal"
                      onChange={(e) => {
                        setAmount(e.target.value);
                        setPct(null);
                      }}
                    />
                  </label>
                  <div className="wallet-pct" role="group" aria-label="Amount percentage">
                    {PCTS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        disabled={busy || !asset}
                        aria-pressed={pct === n}
                        onClick={() => applyPct(n)}
                      >
                        {n === 100 ? 'Max' : `${n}%`}
                      </button>
                    ))}
                  </div>
                  <label className="field">
                    <span>Token and chain to receive</span>
                    <AssetGridPicker
                      ariaLabel="Token and chain to receive"
                      title="Token to receive"
                      value={destinationAsset}
                      disabled={busy}
                      onChange={setDestinationAsset}
                      placeholder="Choose token and chain"
                      options={tokenOptions}
                    />
                  </label>
                  <label className="field">
                    <span>Destination address</span>
                    <input
                      value={destination}
                      disabled={busy}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setDestination(e.target.value)}
                    />
                  </label>
                </>
              )}
              <div>
                <Button
                  disabled={
                    busy ||
                    (!proposalId && (!asset || !amount || !destinationAsset || !destination.trim()))
                  }
                  onClick={() => void quote()}
                >
                  Get payout quote
                </Button>
              </div>
            </Panel>
          ) : null}
          {review ? (
            <Panel title="Review payout">
              <div className="wallet-quote">
                <div className="wallet-quote-row">
                  <span className="wallet-quote-label">Send</span>
                  <strong>{showAmount(review.asset, review.amount)}</strong>
                </div>
                <div className="wallet-quote-row">
                  <span className="wallet-quote-label">Est. receive</span>
                  <strong>{showAmount(review.destinationAsset, review.quote.quote.amountOut)}</strong>
                </div>
                {review.quote.quote.minAmountOut ? (
                  <div className="wallet-quote-row">
                    <span className="wallet-quote-label">Min. receive</span>
                    <strong>
                      {showAmount(review.destinationAsset, review.quote.quote.minAmountOut)}
                    </strong>
                  </div>
                ) : null}
                <div className="wallet-quote-row">
                  <span className="wallet-quote-label">Destination</span>
                  <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                    <ChainLogo chain={review.destinationChain} />
                    {chainLabel(review.destinationChain)}
                  </strong>
                </div>
                <div className="wallet-quote-row">
                  <span className="wallet-quote-label">Address</span>
                  <strong className="dash-mono">{review.destination}</strong>
                </div>
                <div className="wallet-quote-row">
                  <span className="wallet-quote-label">Expires</span>
                  <strong>{new Date(review.expiresAt).toLocaleString()}</strong>
                </div>
                <div className="wallet-quote-row">
                  <span className="wallet-quote-label">Status</span>
                  <strong>{review.status}</strong>
                </div>
              </div>
              {mine && review.status === 'awaiting_signature' ? (
                <div>
                  <Button
                    disabled={busy || Date.parse(review.expiresAt) <= Date.now()}
                    onClick={() =>
                      void run(async () => {
                        setReview(await signPayout(store, review));
                        setNotice('Payout submitted. Its status updates below.');
                        await load();
                      })
                    }
                  >
                    Confirm and sign with wallet passkey
                  </Button>
                </div>
              ) : null}
            </Panel>
          ) : null}
          <Panel title="Payout history">
            <div>
              <Button variant="secondary" disabled={busy} onClick={() => void load()}>
                Refresh wallet
              </Button>
            </div>
            {data.payouts.length ? (
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Destination</th>
                      <th>Date</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.payouts.map((p) => (
                      <tr key={p.id}>
                        <td>{showAmount(p.asset, p.amount)}</td>
                        <td>
                          <strong>{p.status}</strong>
                        </td>
                        <td>
                          <span className="dash-mono" title={p.destination}>
                            {shortAddr(p.destination)}
                          </span>
                        </td>
                        <td>{new Date(p.expiresAt).toLocaleString()}</td>
                        <td>
                          <Button variant="secondary" onClick={() => setReview(p)}>
                            Review
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="dash-muted">No payouts yet.</p>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function shortAddr(value: string): string {
  const t = value.trim();
  if (t.length <= 16) return t;
  return `${t.slice(0, 8)}…${t.slice(-6)}`;
}
