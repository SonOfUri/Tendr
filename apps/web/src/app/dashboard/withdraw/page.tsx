'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { MapPin } from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { DestinationBox, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel, Select } from '@/components/dashboard/ui';
import { usableIn } from '@/lib/actions';
import { api, type AccountView, type Balances, type SavedAddress } from '@/lib/api';
import { assetInfo, chainLabel, formatAmount, parseUnits, poaTokenContract } from '@/lib/assets';
import { AssetGridPicker } from '@/components/dashboard/AssetGridPicker';
import { ChainLogo, TokenLogo } from '@/components/dashboard/asset-logos';
import { NativeWalletPanel } from '@/components/dashboard/NativeWallet';
import { chainId } from '@/lib/chain-logos';
import { loadIntentsCatalog, type IntentsToken } from '@/lib/intents-catalog';
import { toast } from '@/components/toast';
import { draftProposal } from '@/lib/proposals';

export default function WithdrawPage() {
  const { store, context, me } = useDashboard();
  const router = useRouter();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const data = useLoad(async () => {
    const account = await api<AccountView>('/v1/account');
    if (account.account?.kind === 'native_intents') {
      return { saved: [] as SavedAddress[], balances: [] as Balances['balances'], native: true };
    }
    if (store?.role === 'viewer') {
      return { saved: [] as SavedAddress[], balances: [] as Balances['balances'], native: false };
    }
    const [s, b] = await Promise.all([
      api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<Balances>('/v1/account/balances'),
    ]);
    return {
      saved: s.savedAddresses.filter((a) => a.status !== 'revoked'),
      balances: b.balances,
      native: false,
    };
  }, key);
  const catalog = useLoad(() => loadIntentsCatalog(), key ? 'intents-catalog' : null);
  const now = useTick();
  const [savedId, setSavedId] = useState('');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [receive, setReceive] = useState<'same' | 'other'>('same');
  const { busy, run } = useAction();

  if (!store || !context) return null;
  const header = (
    <PageHeader
      title="Withdraw"
      description={
        <>
          Ask to send money from the {context.livemode ? 'live' : 'test'} account to one of your
          saved addresses. Signers approve it with their passkeys before anything moves.
        </>
      }
    />
  );
  if (!data.data) {
    return (
      <>
        {header}
        {data.error ? (
          <ErrorState message={data.error} onRetry={() => void data.reload()} />
        ) : (
          <Spinner label="Loading" />
        )}
      </>
    );
  }
  const { saved, balances, native } = data.data;
  if (native) {
    return (
      <div className="stack">
        <PageHeader
          title="Withdraw"
          description="Live withdrawals are quoted, then signed with the wallet passkey. A signed payout cannot be cancelled."
        />
        <NativeWalletPanel
          merchantId={store.id}
          userId={me.user.id}
          isOwner={store.role === 'owner'}
        />
      </div>
    );
  }
  if (store.role === 'viewer') {
    return (
      <>
        {header}
        <Alert tone="info">Viewers can’t ask for withdrawals. Ask a business admin.</Alert>
      </>
    );
  }
  const target = saved.find((a) => a.id === savedId) ?? null;
  const livemode = context.livemode;
  const info = asset ? assetInfo(asset, livemode) : null;
  const catalogTokens = catalog.data?.tokens ?? [];
  const chosen = catalogTokens.find((token) => token.asset === asset) ?? null;
  const balance = balances.find((b) => b.asset === asset);
  const decimals = chosen?.decimals ?? (info?.known ? info.decimals : 0);
  const tokenChoices = withdrawTokens(catalogTokens, balances, target?.chain ?? null, livemode);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return toast.error('Choose a saved address.');
    if (receive !== 'same') return toast.error('Different-token withdrawals are coming soon.');
    const token = poaTokenContract(asset);
    if (!token) return toast.error('This asset can’t be withdrawn from here yet.');
    const raw = parseUnits(amount, decimals);
    if (!raw || raw === '0') {
      return toast.error(
        decimals > 0
          ? `Enter an amount with at most ${decimals} decimal places.`
          : 'Enter a whole number of smallest units.',
      );
    }
    // The route's token is the asset's own contract: never typed by hand.
    const p = await run(() =>
      draftProposal({
        withdraw: {
          asset,
          amount: raw,
          saved_address_id: target.id,
          route: { poa: { token_contract: token } },
        },
      }),
    );
    if (p) router.push(`/dashboard/approvals/${p.id}`);
  }

  return (
    <div className="stack">
      {header}

      {saved.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<MapPin size={22} strokeWidth={1.75} />}
            title="No saved addresses yet"
            description="Add one first. It can receive money 24 hours after it is approved."
            action={
              <Link href="/dashboard/addresses#add-address" className="dash-empty-cta">
                Add one
              </Link>
            }
          />
        </Panel>
      ) : (
        <Panel title="Withdraw to a saved address">
          <form className="form" onSubmit={submit}>
          <label className="field">
            <span>To</span>
            <Select
              ariaLabel="Saved address"
              className="tendr-select--field"
              value={savedId}
              onChange={(id) => {
                setSavedId(id);
                const next = saved.find((a) => a.id === id);
                const nextChain = next ? chainId(next.chain) : '';
                const token = catalogTokens.find((item) => item.asset === asset);
                if (
                  token &&
                  nextChain &&
                  nextChain !== 'near' &&
                  chainId(token.chain) !== nextChain
                ) {
                  setAsset('');
                }
              }}
              placeholder="Choose a saved address"
              options={saved.map((a) => ({
                value: a.id,
                label: `${chainLabel(a.chain)} · ${a.address}${
                  a.status === 'pending' ? ` (${usableIn(a.activeFrom, now)})` : ''
                }`,
                icon: <ChainLogo chain={a.chain} />,
              }))}
            />
          </label>
          {target && (
            <DestinationBox destination={{ chain: target.chain, address: target.address }} />
          )}
          {target?.status === 'pending' && (
            <Alert tone="warning">
              This address is not usable yet ({usableIn(target.activeFrom, now)}). A withdrawal to
              it will be refused until then.
            </Alert>
          )}

          <label className="field">
            <span>Asset</span>
            <AssetGridPicker
              ariaLabel="Asset"
              title="Token"
              value={asset}
              onChange={setAsset}
              placeholder={catalog.data ? 'Choose a token' : 'Loading tokens…'}
              disabled={!catalog.data}
              options={tokenChoices.map((token) => ({
                value: token.asset,
                label: `${token.symbol} · ${chainLabel(token.chain)}`,
                icon: <TokenLogo symbol={token.symbol} assetId={token.asset} />,
              }))}
            />
          </label>
          {info && (
            <p className="dash-muted dash-small">
              {chosen
                ? `${chosen.symbol} on ${chainLabel(chosen.chain)} · ${chosen.decimals} decimals`
                : info.known
                  ? `${info.symbol} · ${info.decimals} decimals`
                  : 'Not in the 1Click catalog: enter the amount in raw smallest units.'}
              {balance && ` · balance ${formatAmount(asset, balance.amount, livemode)}`}
            </p>
          )}

          <label className="field">
            <span>
              Amount
              {info ? (info.known ? ` (${info.symbol})` : ' (smallest units)') : ''}
            </span>
            <input
              name="amount"
              required
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoComplete="off"
            />
          </label>

          <fieldset className="field">
            <legend>Receive</legend>
            <label>
              <input
                type="radio"
                name="receive"
                checked={receive === 'same'}
                onChange={() => setReceive('same')}
              />{' '}
              The same token{target ? ` on ${chainLabel(target.chain)}` : ''}
            </label>
            <label>
              <input
                type="radio"
                name="receive"
                checked={receive === 'other'}
                onChange={() => setReceive('other')}
                disabled
              />{' '}
              A different token — different-token withdrawals coming soon
            </label>
            <p className="dash-muted dash-small">
              When they arrive, different-token withdrawals go through a swap and wait 24 hours
              after approval.
            </p>
          </fieldset>

          <Button type="submit" disabled={busy}>
            {busy ? 'Asking…' : 'Ask to withdraw'}
          </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}

/** 1Click tokens that can be sent to `destinationChain`. A NEAR address can take any of them. */
function withdrawTokens(
  tokens: IntentsToken[],
  balances: { asset: string }[],
  destinationChain: string | null,
  livemode: boolean,
): IntentsToken[] {
  const dest = destinationChain ? chainId(destinationChain) : '';
  const matched = tokens.filter(
    (token) => !dest || dest === 'near' || chainId(token.chain) === dest,
  );
  const byId = new Map(matched.map((token) => [token.asset, token]));
  if (!dest || dest === 'near') {
    for (const balance of balances) {
      if (byId.has(balance.asset)) continue;
      const known = assetInfo(balance.asset, livemode);
      byId.set(balance.asset, {
        asset: balance.asset,
        symbol: known.known ? known.symbol : balance.asset,
        chain: dest || 'near',
        decimals: known.decimals,
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) ||
      a.chain.localeCompare(b.chain) ||
      a.asset.localeCompare(b.asset),
  );
}
