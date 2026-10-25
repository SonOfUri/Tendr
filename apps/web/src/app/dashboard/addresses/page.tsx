'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { usableIn } from '@/lib/actions';
import { api, type Proposal, type SavedAddress } from '@/lib/api';
import { CHAINS, chainLabel } from '@/lib/assets';
import { draftProposal } from '@/lib/proposals';

export default function SavedAddressesPage() {
  const { store, context } = useDashboard();
  const router = useRouter();
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const data = useLoad(async () => {
    const [s, p] = await Promise.all([
      api<{ savedAddresses: SavedAddress[] }>('/v1/account/saved-addresses'),
      api<{ proposals: Proposal[] }>('/v1/account/proposals'),
    ]);
    const open = p.proposals.filter(
      (x) =>
        ['draft', 'pending', 'timelocked'].includes(x.status) &&
        (x.kind === 'add_saved_address' || x.kind === 'remove_saved_address'),
    );
    return { saved: s.savedAddresses, open };
  }, key);
  const now = useTick();
  const remove = useAction();

  if (!store || !context) return null;
  const canRequest = store.role !== 'viewer';

  async function removeAddress(a: SavedAddress) {
    const p = await remove.run(() => draftProposal({ remove_saved_address: { id: a.id } }));
    if (p) router.push(`/dashboard/approvals/${p.id}`);
  }

  return (
    <div className="stack">
      <div>
        <h1>Saved addresses</h1>
        <p className="muted">
          Money only leaves to an address saved here. Adding one is a proposal the signers approve,
          and a new address can receive money <strong>24 hours</strong> after it is approved, so a
          stolen login can’t send funds somewhere new straight away.
        </p>
      </div>

      {canRequest && (
        <section className="card">
          <h2>Add an address</h2>
          <AddAddress />
        </section>
      )}

      <section className="card">
        <h2>Addresses</h2>
        {data.error && <Alert tone="danger">{data.error}</Alert>}
        {remove.error && <Alert tone="danger">{remove.error}</Alert>}
        {!data.data ? (
          <Spinner label="Loading saved addresses" />
        ) : data.data.saved.length === 0 ? (
          <p className="muted">No saved addresses yet.</p>
        ) : (
          <ul className="list">
            {data.data.saved.map((a) => (
              <li key={a.id} data-testid={`saved-${a.address}`}>
                <span className="grow">
                  <strong>{chainLabel(a.chain)}</strong>{' '}
                  <span className="muted small">({a.chain})</span>
                  <br />
                  <span className="address">{a.address}</span>
                </span>
                {a.status === 'pending' && (
                  <span className="small">{usableIn(a.activeFrom, now)}</span>
                )}
                <Status status={a.status} />
                {canRequest && a.status !== 'revoked' && (
                  <Button
                    variant="secondary"
                    disabled={remove.busy}
                    onClick={() => void removeAddress(a)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.data && data.data.open.length > 0 && (
        <section className="card">
          <h2>Waiting for approval</h2>
          <ul className="list">
            {data.data.open.map((p) => {
              const v = p.action[p.kind] as { chain?: string; address?: string; id?: string };
              return (
                <li key={p.id}>
                  <span className="grow">
                    <Link href={`/dashboard/approvals/${p.id}`}>
                      {p.kind === 'add_saved_address' ? 'Add' : 'Remove'}
                    </Link>{' '}
                    <span className="address small">
                      {v.chain ? `${v.chain}: ${v.address}` : v.id}
                    </span>
                  </span>
                  <Status status={p.status} />
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function AddAddress() {
  const router = useRouter();
  const [chain, setChain] = useState('near');
  const [address, setAddress] = useState('');
  const { busy, error, run } = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The API mints the saved address's id (`pal_…`); the empty id here is replaced.
    const p = await run(() =>
      draftProposal({ add_saved_address: { id: '', chain, address: address.trim() } }),
    );
    if (p) router.push(`/dashboard/approvals/${p.id}`);
  }

  return (
    <form onSubmit={submit} className="form">
      <div className="row">
        <label className="field">
          <span>Network</span>
          <select name="chain" value={chain} onChange={(e) => setChain(e.target.value)}>
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Address</span>
          <input
            name="address"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={chain === 'near' ? 'yourwallet.near' : '0x…'}
          />
        </label>
      </div>
      <Alert tone="info">
        After the signers approve it, this address waits 24 hours before it can receive money. Check
        every character: money sent to a wrong address cannot be recovered.
      </Alert>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={busy || !address.trim()}>
        {busy ? 'Saving…' : 'Ask to add this address'}
      </Button>
    </form>
  );
}
