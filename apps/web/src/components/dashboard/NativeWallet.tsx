'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { ChainLogo, TokenLogo, tokenSelectOptions } from '@/components/dashboard/asset-logos';
import { AssetGridPicker } from '@/components/dashboard/AssetGridPicker';
import { Panel } from '@/components/dashboard/ui';
import { assetInfo, chainLabel, formatAmount, formatUnits, parseUnits, poaTokenContract } from '@/lib/assets';
import {
  api,
  errorMessage,
  type AccountView,
  type Balances,
  type GoLiveStatus,
  type StoreContext,
} from '@/lib/api';
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
  const [error, setError] = useState<string | null>(null);
  const wallet = view.nativeWallet;
  const mine = isOwner && (!wallet || wallet.ownerUserId === userId);
  const active = view.account?.status === 'active';
  const closed = status.checklist.missing.includes('live_mode_unavailable');

  async function setup() {
    setBusy(true);
    setError(null);
    try {
      if (!wallet) await registerWallet(store);
      await activateWallet(store);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return <Alert tone="info">Live mode is turned off for this platform right now.</Alert>;
  }
  if (active) {
    return (
      <Alert tone="success">
        Wallet activated. Settlement and withdrawals are on the{' '}
        <Link href="/dashboard/wallet">wallet page</Link>.
      </Alert>
    );
  }
  return (
    <div className="stack">
      <p className="dash-muted">
        {wallet
          ? 'This wallet exists but is not active yet. Finish activation with its passkey. That does not move any money.'
          : 'Create the wallet passkey, then activate the wallet. Activation does not move any money, and it sets the store default to NEAR USDC until you change it.'}
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settlement, setSettlement] = useState('');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
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
    void load().catch((err) => {
      if (!controller.signal.aborted) setError(errorMessage(err));
    });
    return () => controller.abort();
    // store identity is merchant id; livemode is always live here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  const pending = data?.payouts.some((p) => p.status === 'submitting' || p.status === 'submitted');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void load().catch((err) => setError(errorMessage(err)));
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, merchantId]);

  async function run(op: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await op();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <Spinner label="Loading wallet" />;
  if (!data) return <Alert tone="danger">{error}</Alert>;

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

  function showAmount(id: string, raw: string) {
    const token = data!.tokens.find((t) => t.asset === id);
    if (token) return `${formatUnits(raw, token.decimals)} ${token.symbol}`;
    return formatAmount(id, raw, true);
  }

  async function quote() {
    await run(async () => {
      const token = data!.tokens.find((t) => t.asset === asset);
      const raw = token ? parseUnits(amount, token.decimals) : null;
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

  return (
    <div className="stack">
      <NativeWalletSetup
        view={data.view}
        status={data.status}
        store={store}
        userId={userId}
        isOwner={isOwner}
        onDone={() => void load().catch((err) => setError(errorMessage(err)))}
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {active ? (
        <>
          {!mine ? (
            <Alert tone="info">
              You can view this wallet. Only its owner can change settlement or authorize payouts.
            </Alert>
          ) : null}
          <Panel title="Balances">
            {data.balances.balances.length ? (
              data.balances.balances.map((b) => (
                <p key={b.asset} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <TokenLogo symbol={assetInfo(b.asset, true).symbol} assetId={b.asset} />{' '}
                  {showAmount(b.asset, b.amount)}
                </p>
              ))
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
                    <span>Token to send</span>
                    <AssetGridPicker
                      ariaLabel="Token to send"
                      title="Token to send"
                      value={asset}
                      disabled={busy}
                      onChange={setAsset}
                      placeholder="Choose a balance"
                      options={tokenSelectOptions(
                        data.balances.balances.filter((b) => BigInt(b.amount) > 0n).map((b) => b.asset),
                        (id) => assetInfo(id, true),
                      )}
                    />
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
              <p>
                Send: <strong>{showAmount(review.asset, review.amount)}</strong>
              </p>
              <p>Estimated receive: {showAmount(review.destinationAsset, review.quote.quote.amountOut)}</p>
              {review.quote.quote.minAmountOut ? (
                <p>
                  Minimum receive: {showAmount(review.destinationAsset, review.quote.quote.minAmountOut)}
                </p>
              ) : null}
              <p style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ChainLogo chain={review.destinationChain} /> Destination chain:{' '}
                <strong>{chainLabel(review.destinationChain)}</strong>
              </p>
              <p className="dash-mono">{review.destination}</p>
              <p>Quote expires: {new Date(review.expiresAt).toLocaleString()}</p>
              <p>
                Status: <strong>{review.status}</strong>
              </p>
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
              data.payouts.map((p) => (
                <div key={p.id} className="stack">
                  <p>
                    {showAmount(p.asset, p.amount)} · <strong>{p.status}</strong>
                  </p>
                  <p className="dash-mono">{p.destination}</p>
                  <div>
                    <Button variant="secondary" onClick={() => setReview(p)}>
                      Review payout {p.id.slice(-6)}
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <p className="dash-muted">No payouts yet.</p>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
