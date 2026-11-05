'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { DestinationBox, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { usableIn } from '@/lib/actions';
import { api, type Balances, type SavedAddress } from '@/lib/api';
import { registeredAssetIds } from '@/lib/asset-registry';
import { assetInfo, chainLabel, formatAmount, parseUnits, poaTokenContract } from '@/lib/assets';
import { draftProposal } from '@/lib/proposals';

export default function WithdrawPage() {
  const { store, context } = useDashboard();
  const router = useRouter();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const data = useLoad(async () => {
    const [s, b] = await Promise.all([
      api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<Balances>('/v1/account/balances'),
    ]);
    return { saved: s.savedAddresses.filter((a) => a.status !== 'revoked'), balances: b.balances };
  }, key);
  const now = useTick();
  const [savedId, setSavedId] = useState('');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [receive, setReceive] = useState<'same' | 'other'>('same');
  const { busy, error, setError, run } = useAction();

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
  if (store.role === 'viewer') {
    return (
      <>
        {header}
        <Alert tone="info">Viewers can’t ask for withdrawals. Ask a business admin.</Alert>
      </>
    );
  }
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
  const { saved, balances } = data.data;
  const target = saved.find((a) => a.id === savedId) ?? null;
  const livemode = context.livemode;
  const info = asset ? assetInfo(asset, livemode) : null;
  const balance = balances.find((b) => b.asset === asset);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!target) return setError('Choose a saved address.');
    if (receive !== 'same') return setError('Different-token withdrawals are coming soon.');
    const token = poaTokenContract(asset);
    if (!token) return setError('This asset can’t be withdrawn from here yet.');
    const raw = parseUnits(amount, info!.decimals);
    if (!raw || raw === '0') {
      return setError(
        info!.known
          ? `Enter an amount with at most ${info!.decimals} decimal places.`
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
        <Alert tone="info">
          You have no saved addresses yet. <Link href="/dashboard/addresses">Add one</Link> first;
          it can receive money 24 hours after it is approved.
        </Alert>
      ) : (
        <Panel title="Withdraw to a saved address">
          <form className="form" onSubmit={submit}>
          <label className="field">
            <span>To</span>
            <select
              name="saved-address"
              required
              value={savedId}
              onChange={(e) => setSavedId(e.target.value)}
            >
              <option value="">Choose a saved address</option>
              {saved.map((a) => (
                <option key={a.id} value={a.id}>
                  {chainLabel(a.chain)} · {a.address}
                  {a.status === 'pending' ? ` (${usableIn(a.activeFrom, now)})` : ''}
                </option>
              ))}
            </select>
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
            <input
              name="asset"
              list="withdraw-assets"
              required
              value={asset}
              onChange={(e) => setAsset(e.target.value.trim())}
              spellCheck={false}
              autoComplete="off"
              placeholder="nep141:…"
            />
            <datalist id="withdraw-assets">
              {[...new Set([...balances.map((b) => b.asset), ...registeredAssetIds(livemode)])].map(
                (a) => (
                  <option key={a} value={a}>
                    {assetInfo(a, livemode).known ? assetInfo(a, livemode).symbol : a}
                  </option>
                ),
              )}
            </datalist>
          </label>
          {info && (
            <p className="dash-muted dash-small">
              {info.known
                ? `${info.symbol} · ${info.decimals} decimals`
                : 'Not a registered asset: enter the amount in raw smallest units.'}
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

          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" disabled={busy}>
            {busy ? 'Asking…' : 'Ask to withdraw'}
          </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}
