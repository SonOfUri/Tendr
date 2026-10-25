'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { RecoveryKitCreator } from '@/components/dashboard/RecoveryKitCreator';
import {
  api,
  type AccountView,
  type AssetLimit,
  type GoLiveStatus,
  type SavedAddress,
} from '@/lib/api';
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

  if (!store || !context) return null;
  if (!data.data) {
    return data.error ? <Alert tone="danger">{data.error}</Alert> : <Spinner label="Loading" />;
  }
  const { account, limits, saved, goLive } = data.data;
  const isOwner = store.role === 'owner';
  const canSettings = store.role === 'owner' || store.role === 'admin';
  const go = (id: string) => router.push(`/dashboard/approvals/${id}`);

  return (
    <div className="stack">
      <div>
        <h1>Security</h1>
        <p className="muted">
          Settings of the {context.livemode ? 'live' : 'test'} account. Each change is a proposal
          the signers approve; raising a limit or the refund cap waits 24 hours.
        </p>
        {notice && <Alert tone="success">{notice}</Alert>}
      </div>

      <section className="card">
        <h2>Approval rule</h2>
        {account.account ? (
          <ThresholdForm
            current={account.account.threshold}
            signers={account.signers.length}
            enabled={isOwner}
            onDraft={go}
          />
        ) : (
          <p className="muted">This account is not set up yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Withdrawal limits</h2>
        <LimitsList limits={limits} />
        {canSettings ? (
          <LimitsForm onDraft={go} />
        ) : (
          <p className="muted small">Admins and owners can change limits.</p>
        )}
      </section>

      <section className="card">
        <h2>Refund cap</h2>
        <p className="muted small">
          Refunds up to this amount per day go out as soon as they are approved; larger ones wait 24
          hours.
        </p>
        {canSettings && <RefundCapForm onDraft={go} />}
      </section>

      <section className="card">
        <h2>Auto-sweep</h2>
        <p className="muted small">
          Moves everything above a threshold to a saved address automatically.
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
      </section>

      <section className="card" id="recovery-kit">
        <h2>Recovery kit</h2>
        <p>
          Status:{' '}
          <strong data-testid="recovery-kit-status">
            {goLive.checklist.recoveryKeySet ? 'On' : 'Not set up'}
          </strong>
        </p>
        <p className="muted small">
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
          <p className="muted">Only the owner can replace the recovery kit.</p>
        )}
      </section>
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
  const { busy, error, run } = useAction();
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
            <select value={n} onChange={(e) => setN(Number(e.target.value))}>
              {Array.from({ length: Math.max(signers, 1) }, (_, i) => i + 1).map((i) => (
                <option key={i} value={i}>
                  {i} of {signers}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy || n === current}>
            Ask to change
          </Button>
        </div>
      ) : (
        <p className="muted small">Only the owner can change the approval rule.</p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}

function LimitsList({ limits }: { limits: AssetLimit[] }) {
  const set = limits.filter((l) => l.perTx !== null || l.perDay !== null || l.refundCap !== null);
  if (set.length === 0) return <p className="muted">No limits set: any approved amount can go.</p>;
  const show = (asset: string, v: string | null) =>
    v === null ? 'No limit' : formatAmount(asset, v);
  return (
    <table className="balances">
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
            <td title={l.asset}>{assetInfo(l.asset).symbol}</td>
            <td>{show(l.asset, l.perTx)}</td>
            <td>{show(l.asset, l.perDay)}</td>
            <td>{l.refundCap === null ? '0' : formatAmount(l.asset, l.refundCap)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A human amount field → smallest units for `asset`, or an error message. */
function toRaw(asset: string, human: string, what: string): string {
  const raw = parseUnits(human, assetInfo(asset).decimals);
  if (raw === null) throw new Error(`${what}: enter a number`);
  return raw;
}

function AssetField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
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
  );
}

function LimitsForm({ onDraft }: { onDraft: (id: string) => void }) {
  const [asset, setAsset] = useState('');
  const [perTx, setPerTx] = useState('');
  const [perDay, setPerDay] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() =>
          draftProposal({
            set_limits: {
              asset,
              per_tx: perTx.trim() ? toRaw(asset, perTx, 'Per withdrawal') : null,
              per_day: perDay.trim() ? toRaw(asset, perDay, 'Per day') : null,
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
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={busy || !asset}>
        Ask to set limits
      </Button>
    </form>
  );
}

function RefundCapForm({ onDraft }: { onDraft: (id: string) => void }) {
  const [asset, setAsset] = useState('');
  const [daily, setDaily] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = await run(() =>
          draftProposal({ set_refund_cap: { asset, daily: toRaw(asset, daily, 'Cap') } }),
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
      {error && <Alert tone="danger">{error}</Alert>}
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
  const { busy, error, run } = useAction();
  return (
    <li>
      <span className="grow">
        {assetInfo(limit.asset).symbol}: above{' '}
        {s.triggerAbove ? formatAmount(limit.asset, s.triggerAbove) : '?'}, keep{' '}
        {s.keep ? formatAmount(limit.asset, s.keep) : '?'} →{' '}
        <strong>{s.chain ? chainLabel(s.chain) : '?'}</strong>{' '}
        <span className="address small">{s.address}</span>
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
      {error && <Alert tone="danger">{error}</Alert>}
    </li>
  );
}

function SweepForm({ saved, onDraft }: { saved: SavedAddress[]; onDraft: (id: string) => void }) {
  const usable = saved.filter((a) => a.status !== 'revoked');
  const [asset, setAsset] = useState('');
  const [trigger, setTrigger] = useState('');
  const [keep, setKeep] = useState('');
  const [savedId, setSavedId] = useState('');
  const { busy, error, run } = useAction();
  if (usable.length === 0) {
    return (
      <p className="muted small">
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
              trigger_above: toRaw(asset, trigger, 'Sweep above'),
              keep: toRaw(asset, keep, 'Keep'),
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
        <select required value={savedId} onChange={(e) => setSavedId(e.target.value)}>
          <option value="">Choose a saved address</option>
          {usable.map((a) => (
            <option key={a.id} value={a.id}>
              {chainLabel(a.chain)} · {a.address}
            </option>
          ))}
        </select>
      </label>
      {target && (
        <p className="muted small">
          Destination: {chainLabel(target.chain)} <span className="address">{target.address}</span>
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={busy || !asset || !savedId}>
        Ask to turn on auto-sweep
      </Button>
    </form>
  );
}
