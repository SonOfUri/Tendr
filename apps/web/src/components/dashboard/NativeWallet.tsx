'use client';

import Link from 'next/link';
import { NativeWalletSecurity } from './NativeWalletSecurity';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LinkSettlementOptions } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import {
  api,
  errorMessage,
  type AccountView,
  type Balances,
  type GoLiveStatus,
  type StoreContext,
} from '@/lib/api';
import { activateWallet, registerWallet, signPayout, type NativePayout } from '@/lib/native-wallet';
import { withStepUp } from '@/lib/webauthn';
import { chainLabel, parseUnits } from '@/lib/assets';

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
  onDone(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = view.account?.status === 'active';
  const mine = isOwner && (!view.nativeWallet || view.nativeWallet.ownerUserId === userId);
  const closed = status.checklist.missing.includes('live_mode_unavailable');
  async function setup() {
    setBusy(true);
    setError(null);
    try {
      if (!view.nativeWallet) await registerWallet(store);
      await activateWallet(store);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      await onDone();
      setBusy(false);
    }
  }
  return (
    <section className="card stack">
      <h2>Live wallet</h2>
      <p>
        One owner controls this store’s wallet with a dedicated wallet passkey. Your login passkey
        is separate.
      </p>
      {view.account && <p className="address">{view.account.nearAccountId}</p>}
      {active ? (
        <>
          <Alert tone="success">Wallet activated.</Alert>
          <Link href="/dashboard/wallet">Manage wallet, settlement and withdrawals</Link>
        </>
      ) : (
        <>
          {closed && (
            <Alert tone="info">
              Live wallet setup is disabled on this backend. Local test payments remain available.
            </Alert>
          )}
          <p className="muted small">
            Use a synced passkey you can keep. After activation, add a backup wallet passkey and
            enable an offline wallet recovery kit. Each key has full wallet control.
          </p>
          {mine ? (
            <Button disabled={busy || closed} onClick={() => void setup()}>
              {busy
                ? 'Waiting for your passkey…'
                : view.nativeWallet
                  ? 'Finish wallet activation'
                  : 'Create wallet passkey and activate'}
            </Button>
          ) : (
            <p>Only the wallet’s designated owner can complete setup.</p>
          )}
        </>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </section>
  );
}

type Token = LinkSettlementOptions['tokens'][number];
function units(value: string, decimals: number): string {
  const n = value.padStart(decimals + 1, '0');
  return decimals
    ? `${n.slice(0, -decimals)}.${n.slice(-decimals)}`.replace(/\.?0+$/, '') || '0'
    : n;
}

/** Remount by merchant ID: no draft or async result is shared between stores. */
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
  const store = useMemo(() => ({ merchantId, livemode: true }), [merchantId]);
  const [data, setData] = useState<{
    view: AccountView;
    status: GoLiveStatus;
    balances: Balances;
    catalog: LinkSettlementOptions | null;
    payouts: NativePayout[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [settlement, setSettlement] = useState('');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [destinationAsset, setDestinationAsset] = useState('');
  const [destination, setDestination] = useState('');
  const [review, setReview] = useState<NativePayout | null>(null);
  const load = useCallback(async () => {
    try {
      const [view, status, balances] = await Promise.all([
        api<AccountView>('/v1/account', { store }),
        api<GoLiveStatus>('/v1/account/go-live', { store }),
        api<Balances>('/v1/account/balances', { store }),
      ]);
      const active = view.account?.kind === 'native_intents' && view.account.status === 'active';
      const [catalog, payouts] = active
        ? await Promise.all([
            api<LinkSettlementOptions>('/v1/payment_links/settlement-options', { store }),
            api<{ payouts: NativePayout[] }>('/v1/account/native/payouts', { store }),
          ])
        : [null, { payouts: [] }];
      setData({ view, status, balances, catalog, payouts: payouts.payouts });
      setSettlement((v) => v || catalog?.store_default?.asset || '');
      setReview((old) => (old ? (payouts.payouts.find((p) => p.id === old.id) ?? old) : null));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [store]);
  useEffect(() => {
    void load();
  }, [load]);
  const pending = data?.payouts.some((p) => ['submitting', 'submitted'].includes(p.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [pending, load]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      await load();
      setBusy(false);
    }
  }
  if (!data)
    return error ? <Alert tone="danger">{error}</Alert> : <Spinner label="Loading wallet" />;
  if (
    data.view.account?.kind === 'contract' ||
    (!data.view.account && data.status.accountKind !== 'native_intents')
  )
    return (
      <Alert tone="info">
        This store uses a contract account. <Link href="/dashboard">Open account</Link>
      </Alert>
    );
  const mine = isOwner && data.view.nativeWallet?.ownerUserId === userId;
  const active = data.view.account?.status === 'active';
  const tokens = data.catalog?.tokens ?? [];
  const tokenLabel = (t: Token) => `${t.symbol} · ${chainLabel(t.chain)}`;
  const tokenAmount = (id: string, raw: string) => {
    const t = tokens.find((t) => t.asset === id);
    return t ? `${units(raw, t.decimals)} ${tokenLabel(t)}` : `${raw} smallest units · ${id}`;
  };
  async function quote() {
    await run(async () => {
      const token = tokens.find((t) => t.asset === asset);
      const raw = token ? parseUnits(amount, token.decimals) : null;
      if (!proposalId && (!raw || BigInt(raw) <= 0n))
        throw new Error('Enter a valid amount for the selected token.');
      const payout = await withStepUp(() =>
        api<NativePayout>('/v1/account/native/payouts', {
          method: 'POST',
          store,
          json: proposalId
            ? { proposalId }
            : { asset, amount: raw, destinationAsset, destination: destination.trim() },
        }),
      );
      setReview(payout);
    });
  }
  return (
    <div className="stack">
      <h1>{proposalId ? 'Approve refund with wallet passkey' : 'Live wallet'}</h1>
      <NativeWalletSetup
        view={data.view}
        status={data.status}
        store={store}
        userId={userId}
        isOwner={isOwner}
        onDone={load}
      />
      {active && mine && !proposalId && <NativeWalletSecurity key={merchantId} store={store} />}
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {active && (
        <>
          {!mine && (
            <Alert tone="info">
              You can view this wallet. Only its designated owner can change settlement or authorize
              payouts.
            </Alert>
          )}
          <section className="card stack">
            <h2>Balances</h2>
            {data.balances.balances.length ? (
              data.balances.balances.map((b) => (
                <p key={b.asset}>{tokenAmount(b.asset, b.amount)}</p>
              ))
            ) : (
              <p>No funds received yet.</p>
            )}
          </section>
          {!proposalId && (
            <section className="card stack">
              <h2>Default settlement token</h2>
              <label className="field">
                <span>Settlement asset</span>
                <select
                  value={settlement}
                  disabled={!mine || busy}
                  onChange={(e) => setSettlement(e.target.value)}
                >
                  <option value="">Choose token and chain</option>
                  {tokens.map((t) => (
                    <option key={t.asset} value={t.asset}>
                      {tokenLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">
                Payments credit this token to your wallet. Individual payment links can choose a
                different token.
              </p>
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
            </section>
          )}
          {mine && (
            <section className="card stack">
              <h2>{proposalId ? 'Refund quote' : 'Withdraw'}</h2>
              {proposalId ? (
                <p>The API will quote the amount and destination recorded on this refund.</p>
              ) : (
                <>
                  <label className="field">
                    <span>Token to send</span>
                    <select
                      value={asset}
                      disabled={busy}
                      onChange={(e) => setAsset(e.target.value)}
                    >
                      <option value="">Choose a balance</option>
                      {data.balances.balances
                        .filter((b) => BigInt(b.amount) > 0n)
                        .map((b) => (
                          <option key={b.asset} value={b.asset}>
                            {tokenAmount(b.asset, b.amount)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Amount to send</span>
                    <input
                      value={amount}
                      disabled={busy}
                      inputMode="decimal"
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Token and chain to receive</span>
                    <select
                      value={destinationAsset}
                      disabled={busy}
                      onChange={(e) => setDestinationAsset(e.target.value)}
                    >
                      <option value="">Choose token and chain</option>
                      {tokens.map((t) => (
                        <option key={t.asset} value={t.asset}>
                          {tokenLabel(t)}
                        </option>
                      ))}
                    </select>
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
              <Button
                disabled={
                  busy ||
                  (!proposalId && (!asset || !amount || !destinationAsset || !destination.trim()))
                }
                onClick={() => void quote()}
              >
                Get payout quote
              </Button>
            </section>
          )}
          {review && (
            <section className="card stack" aria-label="Review payout">
              <h2>Review payout</h2>
              <p>
                Send: <strong>{tokenAmount(review.asset, review.amount)}</strong>
              </p>
              <p>
                Estimated receive:{' '}
                {tokenAmount(review.destinationAsset, review.quote.quote.amountOut)}
              </p>
              {review.quote.quote.minAmountOut && (
                <p>
                  Minimum receive:{' '}
                  {tokenAmount(review.destinationAsset, review.quote.quote.minAmountOut)}
                </p>
              )}
              <p>
                Destination chain: <strong>{chainLabel(review.destinationChain)}</strong>
              </p>
              <p className="address">{review.destination}</p>
              <p>Quote expires: {new Date(review.expiresAt).toLocaleString()}</p>
              <p>
                Status: <strong>{review.status}</strong>
              </p>
              {mine && review.status === 'awaiting_signature' && (
                <Button
                  disabled={busy || Date.parse(review.expiresAt) <= Date.now()}
                  onClick={() =>
                    void run(async () => {
                      setReview(await signPayout(store, review));
                      setNotice('Payout submitted. Follow its status below.');
                    })
                  }
                >
                  Confirm and sign with wallet passkey
                </Button>
              )}
            </section>
          )}
          <section className="card stack">
            <h2>Payout history</h2>
            <Button variant="secondary" disabled={busy} onClick={() => void load()}>
              Refresh wallet
            </Button>
            {data.payouts.length ? (
              data.payouts.map((p) => (
                <div key={p.id}>
                  <p>
                    {tokenAmount(p.asset, p.amount)} · <strong>{p.status}</strong>
                  </p>
                  <p className="address">{p.destination}</p>
                  <Button variant="secondary" onClick={() => setReview(p)}>
                    Review payout {p.id.slice(-6)}
                  </Button>
                </div>
              ))
            ) : (
              <p>No payouts yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
