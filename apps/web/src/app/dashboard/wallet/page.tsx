'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { MapPin } from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { DestinationBox, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel, Select } from '@/components/dashboard/ui';
import { NativeWalletPanel } from '@/components/dashboard/NativeWallet';
import { DemoAssetModal } from '@/components/demo/DemoAssetModal';
import '@/components/demo/demo-playground.css';
import { usableIn } from '@/lib/actions';
import { api, type AccountView, type Balances, type SavedAddress } from '@/lib/api';
import { assetInfo, chainLabel, formatAmount, parseUnits, poaTokenContract } from '@/lib/assets';
import { ChainLogo } from '@/components/dashboard/asset-logos';
import { chainId } from '@/lib/chain-logos';
import type { Token } from '@/lib/checkout/api';
import { buildDemoAssetOptions } from '@/lib/demo-assets';
import { loadIntentsCatalog, type IntentsToken } from '@/lib/intents-catalog';
import { toast } from '@/components/toast';
import { draftProposal } from '@/lib/proposals';

export default function WalletPage() {
  const { store, context, me } = useDashboard();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const account = useLoad(() => api<AccountView>('/v1/account'), key);

  if (!store || !context) return null;

  const header = (
    <PageHeader
      title="Wallet"
      description="Balances, settlement, and withdrawals for this account. Live native wallets use a wallet passkey; contract accounts go through approvals."
    />
  );

  if (!account.data) {
    return (
      <>
        {header}
        {account.error ? (
          <ErrorState message={account.error} onRetry={() => void account.reload()} />
        ) : (
          <PageSkeleton label="Loading" />
        )}
      </>
    );
  }

  const native = account.data.account?.kind === 'native_intents';
  if (native) {
    return (
      <div className="stack">
        {header}
        <NativeWalletPanel
          merchantId={store.id}
          userId={me.user.id}
          isOwner={store.role === 'owner'}
        />
      </div>
    );
  }

  return (
    <div className="stack">
      {header}
      <ContractWithdrawForm />
    </div>
  );
}

function ContractWithdrawForm() {
  const { store, context } = useDashboard();
  const router = useRouter();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const data = useLoad(async () => {
    if (store?.role === 'viewer') {
      return { saved: [] as SavedAddress[], balances: [] as Balances['balances'] };
    }
    const [s, b] = await Promise.all([
      api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<Balances>('/v1/account/balances'),
    ]);
    return {
      saved: s.savedAddresses.filter((a) => a.status !== 'revoked'),
      balances: b.balances,
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

  if (!data.data) {
    return data.error ? (
      <ErrorState message={data.error} onRetry={() => void data.reload()} />
    ) : (
      <PageSkeleton label="Loading" />
    );
  }

  if (store.role === 'viewer') {
    return <Alert tone="info">Viewers can’t ask for withdrawals. Ask a business admin.</Alert>;
  }

  const { saved, balances } = data.data;
  const target = saved.find((a) => a.id === savedId) ?? null;
  const livemode = context.livemode;
  const info = asset ? assetInfo(asset, livemode) : null;
  const catalogTokens = catalog.data?.tokens ?? [];
  const chosen = catalogTokens.find((token) => token.asset === asset) ?? null;
  const balance = balances.find((b) => b.asset === asset);
  const decimals = chosen?.decimals ?? (info?.known ? info.decimals : 0);
  const tokenChoices = withdrawTokens(catalogTokens, balances, target?.chain ?? null, livemode);
  const assetOptions = buildDemoAssetOptions(
    tokenChoices.map(
      (token): Token => ({
        asset_id: token.asset,
        symbol: token.symbol,
        blockchain: token.chain,
        decimals: token.decimals,
        price_usd: null,
        popular: false,
      }),
    ),
  );
  const assetValue =
    asset && assetOptions.some((o) => o.chainVariants.some((v) => v.assetId === asset))
      ? asset
      : assetOptions[0]?.chainVariants[0]?.assetId ?? assetOptions[0]?.value ?? '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return toast.error('Choose a saved address.');
    if (receive !== 'same') return toast.error('Different-token withdrawals are coming soon.');
    const assetId = asset || assetValue;
    if (!assetId) return toast.error('Choose an asset to withdraw.');
    const token = poaTokenContract(assetId);
    if (!token) return toast.error('This asset can’t be withdrawn from here yet.');
    const chosenDecimals =
      catalogTokens.find((t) => t.asset === assetId)?.decimals ??
      (assetInfo(assetId, livemode).known ? assetInfo(assetId, livemode).decimals : 0);
    const raw = parseUnits(amount, chosenDecimals);
    if (!raw || raw === '0') {
      return toast.error(
        chosenDecimals > 0
          ? `Enter an amount with at most ${chosenDecimals} decimal places.`
          : 'Enter a whole number of smallest units.',
      );
    }
    // The route's token is the asset's own contract: never typed by hand.
    const p = await run(() =>
      draftProposal({
        withdraw: {
          asset: assetId,
          amount: raw,
          saved_address_id: target.id,
          route: { poa: { token_contract: token } },
        },
      }),
    );
    if (p) router.push(`/dashboard/approvals/${p.id}`);
  }

  if (saved.length === 0) {
    return (
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
    );
  }

  return (
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
            This address is not usable yet ({usableIn(target.activeFrom, now)}). A withdrawal to it
            will be refused until then.
          </Alert>
        )}

        <div className="stack dash-demo-asset-field">
          <label className="field">
            <span>Asset</span>
            {catalog.data && assetOptions.length ? (
              <DemoAssetModal
                options={assetOptions}
                value={assetValue}
                onChange={setAsset}
              />
            ) : (
              <p className="dash-muted dash-small">
                {catalog.data ? 'No withdrawable tokens for this address.' : 'Loading tokens…'}
              </p>
            )}
          </label>
        </div>
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
            When they arrive, different-token withdrawals go through a swap and wait 24 hours after
            approval.
          </p>
        </fieldset>

        <Button type="submit" disabled={busy}>
          {busy ? 'Asking…' : 'Ask to withdraw'}
        </Button>
      </form>
    </Panel>
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
