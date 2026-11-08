'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLivemode, useLoad } from '@/components/dashboard/common';
import { ErrorState, PageHeader, Panel, Select } from '@/components/dashboard/ui';
import { RecoveryKitCreator } from '@/components/dashboard/RecoveryKitCreator';
import {
  api,
  type AccountView,
  type AssetLimit,
  type GoLiveStatus,
  type SavedAddress,
} from '@/lib/api';
import { ChainLogo } from '@/components/dashboard/asset-logos';
import { assetInfo, chainLabel, formatAmount, parseUnits } from '@/lib/assets';
import { draftProposal } from '@/lib/proposals';

interface Security {
  account: AccountView;
  limits: AssetLimit[];
  saved: SavedAddress[];
  goLive: GoLiveStatus;
}

export default function SecurityPage() {
  const { store, context, refresh } = useDashboard();
  const router = useRouter();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const data = useLoad<Security>(async () => {
    const [account, l, s, goLive] = await Promise.all([
      api<AccountView>('/v1/account'),
      api<{ limits: AssetLimit[] }>('/v1/account/limits'),
      api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<GoLiveStatus>('/v1/account/go-live', { livemode: false }),
    ]);
    return { account, limits: l.limits, saved: s.savedAddresses, goLive };
  }, key);
  const [notice, setNotice] = useState<string | null>(null);

  const header = (
    <PageHeader
      title="Security"
      description={
        <>
          Settings of the {context?.livemode ? 'live' : 'test'} account. Each change is a proposal
          the signers approve. Raising a limit or the refund cap, adding a signer or a passkey,
          replacing the recovery kit, lowering the approval rule and changing origins take effect 24
          hours after approval, and any signer can cancel in that time. Removing a signer or a key
          and raising the approval rule apply at once.
        </>
      }
    />
  );

  if (!store || !context) return null;
  if (!data.data) {
    return (
      <div className="stack">
        {header}
        {data.error ? (
          <ErrorState message={data.error} onRetry={() => void data.reload()} />
        ) : (
          <Spinner label="Loading" />
        )}
      </div>
    );
  }
  const { account, limits, saved, goLive } = data.data;
  const isOwner = store.role === 'owner';
  const canSettings = store.role === 'owner' || store.role === 'admin';
  const go = (id: string) => router.push(`/dashboard/approvals/${id}`);

  return (
    <div className="stack">
      {header}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Panel title="Approval rule" id="approval-rule">
        {account.account ? (
          <ThresholdForm
            current={account.account.threshold}
            signers={account.signers.length}
            enabled={isOwner}
            onDraft={go}
          />
        ) : (
          <p className="dash-muted">This account is not set up yet.</p>
        )}
      </Panel>

      <Panel title="Withdrawal limits">
        <LimitsList limits={limits} />
        {canSettings ? (
          <LimitsForm onDraft={go} />
        ) : (
          <p className="dash-muted dash-small">Admins and owners can change limits.</p>
        )}
      </Panel>

      <Panel title="Refund cap">
        <p className="dash-muted dash-small">
          Refunds up to this amount per day go out as soon as they are approved; larger ones wait 24
          hours.
        </p>
        {canSettings && <RefundCapForm onDraft={go} />}
      </Panel>

      <Panel title="Auto-sweep">
        <p className="dash-muted dash-small">
          Moves everything above a threshold to a saved address automatically.
        </p>
        <p className="dash-muted dash-small" data-testid="sweep-limits-note">
          Sweeps are not counted against the per-withdrawal or per-day limits: they can only go to
          the saved address pinned in the sweep rule, which itself waited 24 hours before it could
          receive money.
        </p>
        {limits.filter((l) => l.autoSweep).length > 0 && (
          <ul className="list">
            {limits
              .filter((l) => l.autoSweep)
              .map((l) => (
                <SweepRow key={l.asset} limit={l} enabled={canSettings} onDraft={go} />
              ))}
          </ul>
        )}
        {canSettings && <SweepForm saved={saved} onDraft={go} />}
      </Panel>

      <Panel title="Recovery kit" id="recovery-kit">
        <p>
          Status:{' '}
          <strong data-testid="recovery-kit-status">
            {goLive.checklist.recoveryKeySet ? 'On' : 'Not set up'}
          </strong>
        </p>
        <p className="dash-muted dash-small">
          The kit can start a recovery of the live account (signers get 3 days to stop it). Lost
          your passkeys? <Link href="/dashboard/recovery">Recovery</Link>.
        </p>
        {isOwner ? (
          <RecoveryKitCreator
            storeName={store.name}
            storeSlug={store.slug}
            replacing={goLive.checklist.recoveryKeySet}
            onRegistered={(r) => {
              if (r.stored) setNotice('Your new recovery kit is on. Keep it somewhere safe.');
              else go(r.proposal.id);
              void data.reload();
              void refresh();
            }}
          />
        ) : (
          <p className="dash-muted">Only the owner can replace the recovery kit.</p>
        )}
      </Panel>
    </div>
  );
}

function ThresholdForm({
  current,
  signers,
  enabled,
  onDraft,
}: {
  current: number;
  signers: number;
  enabled: boolean;
  onDraft: (id: string) => void;
}) {
  const [n, setN] = useState(current);
  const { busy, run } = useAction();
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() => draftProposal({ set_threshold: n }));
        if (p) onDraft(p.id);
      }}
    >
      <p>
        Now: <strong>{current}</strong> of {signers} signer{signers === 1 ? '' : 's'} must approve.
      </p>
      {enabled ? (
        <div className="row">
          <label className="field">
            <span>Approvals needed</span>
            <Select
              ariaLabel="Approvals needed"
              className="tendr-select--field"
              value={String(n)}
              onChange={(v) => setN(Number(v))}
              options={Array.from({ length: Math.max(signers, 1) }, (_, i) => i + 1).map((i) => ({
                value: String(i),
                label: `${i} of ${signers}`,
              }))}
            />
          </label>
          <Button type="submit" disabled={busy || n === current}>
            Ask to change
          </Button>
        </div>
      ) : (
        <p className="dash-muted dash-small">Only the owner can change the approval rule.</p>
      )}
    </form>
  );
}

function LimitsList({ limits }: { limits: AssetLimit[] }) {
  const livemode = useLivemode();
  const set = limits.filter((l) => l.perTx !== null || l.perDay !== null || l.refundCap !== null);
  if (set.length === 0)
    return <p className="dash-muted">No limits set: any approved amount can go.</p>;
  const show = (asset: string, v: string | null) =>
    v === null ? 'No limit' : formatAmount(asset, v, livemode);
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Per withdrawal</th>
            <th>Per day</th>
            <th>Refund cap / day</th>
          </tr>
        </thead>
        <tbody>
          {set.map((l) => (
            <tr key={l.asset}>
              <td>
                {assetInfo(l.asset, livemode).known && <>{assetInfo(l.asset, livemode).symbol} </>}
                <code className="dash-mono">{l.asset}</code>
              </td>
              <td>{show(l.asset, l.perTx)}</td>
              <td>{show(l.asset, l.perDay)}</td>
              <td>{l.refundCap === null ? '0' : formatAmount(l.asset, l.refundCap, livemode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A human amount field → smallest units for `asset`, or an error message. */
function toRaw(asset: string, human: string, what: string, livemode: boolean): string {
  const info = assetInfo(asset, livemode);
  const raw = parseUnits(human, info.decimals);
  if (raw === null) {
    throw new Error(
      info.known
        ? `${what}: enter an amount with at most ${info.decimals} decimal places`
        : `${what}: enter a whole number of smallest units`,
    );
  }
  return raw;
}

function AssetField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const livemode = useLivemode();
  const info = value ? assetInfo(value, livemode) : null;
  return (
    <>
      <label className="field grow">
        <span>Asset id</span>
        <input
          required
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="nep141:…"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      {info && (
        <p className="dash-muted dash-small">
          {info.known
            ? `Amounts below are in ${info.symbol}.`
            : 'Not a registered asset: enter amounts in raw smallest units.'}
        </p>
      )}
    </>
  );
}

function LimitsForm({ onDraft }: { onDraft: (id: string) => void }) {
  const livemode = useLivemode();
  const [asset, setAsset] = useState('');
  const [perTx, setPerTx] = useState('');
  const [perDay, setPerDay] = useState('');
  const { busy, run } = useAction();
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() =>
          draftProposal({
            set_limits: {
              asset,
              per_tx: perTx.trim() ? toRaw(asset, perTx, 'Per withdrawal', livemode) : null,
              per_day: perDay.trim() ? toRaw(asset, perDay, 'Per day', livemode) : null,
            },
          }),
        );
        if (p) onDraft(p.id);
      }}
    >
      <AssetField value={asset} onChange={setAsset} />
      <div className="row">
        <label className="field grow">
          <span>Per withdrawal (blank = no limit)</span>
          <input inputMode="decimal" value={perTx} onChange={(e) => setPerTx(e.target.value)} />
        </label>
        <label className="field grow">
          <span>Per day (blank = no limit)</span>
          <input inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} />
        </label>
      </div>
      <Button type="submit" disabled={busy || !asset}>
        Ask to set limits
      </Button>
    </form>
  );
}

function RefundCapForm({ onDraft }: { onDraft: (id: string) => void }) {
  const livemode = useLivemode();
  const [asset, setAsset] = useState('');
  const [daily, setDaily] = useState('');
  const { busy, run } = useAction();
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() =>
          draftProposal({ set_refund_cap: { asset, daily: toRaw(asset, daily, 'Cap', livemode) } }),
        );
        if (p) onDraft(p.id);
      }}
    >
      <div className="row">
        <AssetField value={asset} onChange={setAsset} />
        <label className="field">
          <span>Per day</span>
          <input
            required
            inputMode="decimal"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
          />
        </label>
      </div>
      <Button type="submit" disabled={busy || !asset}>
        Ask to set the refund cap
      </Button>
    </form>
  );
}

function SweepRow({
  limit,
  enabled,
  onDraft,
}: {
  limit: AssetLimit;
  enabled: boolean;
  onDraft: (id: string) => void;
}) {
  const s = limit.autoSweep!;
  const livemode = useLivemode();
  const { busy, run } = useAction();
  return (
    <li>
      <span className="grow">
        <code className="dash-mono">{limit.asset}</code>: above{' '}
        {s.triggerAbove ? formatAmount(limit.asset, s.triggerAbove, livemode) : '?'}, keep{' '}
        {s.keep ? formatAmount(limit.asset, s.keep, livemode) : '?'} →{' '}
        <strong>{s.chain ? chainLabel(s.chain) : '?'}</strong>{' '}
        <span className="dash-mono dash-small">{s.address}</span>
      </span>
      {enabled && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            const p = await run(() => draftProposal({ clear_auto_sweep: { asset: limit.asset } }));
            if (p) onDraft(p.id);
          }}
        >
          Turn off
        </Button>
      )}
    </li>
  );
}

function SweepForm({ saved, onDraft }: { saved: SavedAddress[]; onDraft: (id: string) => void }) {
  const livemode = useLivemode();
  const usable = saved.filter((a) => a.status !== 'revoked');
  const [asset, setAsset] = useState('');
  const [trigger, setTrigger] = useState('');
  const [keep, setKeep] = useState('');
  const [savedId, setSavedId] = useState('');
  const { busy, run } = useAction();
  if (usable.length === 0) {
    return (
      <p className="dash-muted dash-small">
        Add a <Link href="/dashboard/addresses">saved address</Link> first.
      </p>
    );
  }
  const target = usable.find((a) => a.id === savedId);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() =>
          draftProposal({
            set_auto_sweep: {
              asset,
              trigger_above: toRaw(asset, trigger, 'Sweep above', livemode),
              keep: toRaw(asset, keep, 'Keep', livemode),
              saved_address_id: savedId,
            },
          }),
        );
        if (p) onDraft(p.id);
      }}
    >
      <AssetField value={asset} onChange={setAsset} />
      <div className="row">
        <label className="field grow">
          <span>Sweep when above</span>
          <input
            required
            inputMode="decimal"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
        </label>
        <label className="field grow">
          <span>Keep in the account</span>
          <input
            required
            inputMode="decimal"
            value={keep}
            onChange={(e) => setKeep(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>Send to</span>
        <Select
          ariaLabel="Send to"
          className="tendr-select--field"
          value={savedId}
          onChange={setSavedId}
          placeholder="Choose a saved address"
          options={usable.map((a) => ({
            value: a.id,
            label: `${chainLabel(a.chain)} · ${a.address}`,
            icon: <ChainLogo chain={a.chain} />,
          }))}
        />
      </label>
      {target && (
        <p className="dash-muted dash-small">
          Destination: {chainLabel(target.chain)}{' '}
          <span className="dash-mono">{target.address}</span>
        </p>
      )}
      <Button type="submit" disabled={busy || !asset || !savedId}>
        Ask to turn on auto-sweep
      </Button>
    </form>
  );
}
