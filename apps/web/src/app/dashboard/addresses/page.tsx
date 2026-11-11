'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useAction, useLoad, useTick } from '@/components/dashboard/common';
import { AssetGridPicker } from '@/components/dashboard/AssetGridPicker';
import { ChainLogo } from '@/components/dashboard/asset-logos';
import { EmptyState, PageHeader, Panel } from '@/components/dashboard/ui';
import { usableIn } from '@/lib/actions';
import { api, errorMessage, type Proposal, type SavedAddress } from '@/lib/api';
import { chainLabel } from '@/lib/assets';
import { chainFamily, isValidAddress } from '@/lib/checkout/address';
import { chainId } from '@/lib/chain-logos';
import { loadIntentsCatalog } from '@/lib/intents-catalog';
import { MapPin, Minus, Plus } from 'lucide-react';
import { toast } from '@/components/toast';
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
      <PageHeader
        title="Saved addresses"
        description={
          <>
            Money only leaves to an address saved here. Adding one is a proposal the signers approve,
            and a new address can receive money <strong>24 hours</strong> after it is approved, so a
            stolen login can’t send funds somewhere new straight away.
          </>
        }
      />

      {canRequest && (
        <Panel title="Add an address">
          <div id="add-address">
            <AddAddress />
          </div>
        </Panel>
      )}

      <Panel title="Addresses">
        {!data.data ? (
          <PageSkeleton label="Loading saved addresses" />
        ) : data.data.saved.length === 0 ? (
          <EmptyState
            icon={<MapPin size={22} strokeWidth={1.75} />}
            title="No saved addresses yet"
            description="Money only leaves to an address saved here. Add one and wait for signers to approve it."
            action={
              canRequest ? (
                <a href="#add-address" className="dash-empty-cta dash-btn-icon">
                  <Plus size={16} strokeWidth={1.75} aria-hidden />
                  Add one
                </a>
              ) : null
            }
          />
        ) : (
          <ul className="list">
            {data.data.saved.map((a) => (
              <li key={a.id} data-testid={`saved-${a.address}`}>
                <span className="grow">
                  <strong>{chainLabel(a.chain)}</strong>{' '}
                  <span className="dash-muted dash-small">({a.chain})</span>
                  <br />
                  <span className="dash-mono">{a.address}</span>
                </span>
                {a.status === 'pending' && (
                  <span className="dash-small">{usableIn(a.activeFrom, now)}</span>
                )}
                <Status status={a.status} />
                {canRequest && a.status !== 'revoked' && (
                  <Button
                    variant="secondary"
                    className="dash-btn-icon"
                    disabled={remove.busy}
                    onClick={() => void removeAddress(a)}
                  >
                    <Minus size={16} strokeWidth={1.75} aria-hidden />
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {data.data && data.data.open.length > 0 && (
        <Panel title="Waiting for approval">
          <ul className="list">
            {data.data.open.map((p) => {
              const v = p.action[p.kind] as { chain?: string; address?: string; id?: string };
              return (
                <li key={p.id}>
                  <span className="grow">
                    <Link
                      href={`/dashboard/approvals/${p.id}`}
                      className="dash-text-link dash-btn-icon"
                    >
                      {p.kind === 'add_saved_address' ? (
                        <>
                          <Plus size={16} strokeWidth={1.75} aria-hidden />
                          Add
                        </>
                      ) : (
                        <>
                          <Minus size={16} strokeWidth={1.75} aria-hidden />
                          Remove
                        </>
                      )}
                    </Link>{' '}
                    <span className="dash-mono dash-small">
                      {v.chain ? `${v.chain}: ${v.address}` : v.id}
                    </span>
                  </span>
                  <Status status={p.status} />
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function addressHint(chain: string): string {
  switch (chainFamily(chainId(chain))) {
    case 'near':
      return 'yourwallet.near';
    case 'evm':
      return '0x…';
    case 'solana':
      return 'Solana address';
    case 'bitcoin':
      return 'bc1…';
    case 'tron':
      return 'T…';
    default:
      return 'Address on this network';
  }
}

function AddAddress() {
  const router = useRouter();
  const [chains, setChains] = useState<string[]>([]);
  const [chain, setChain] = useState('near');
  const [address, setAddress] = useState('');
  const { busy, run } = useAction();

  useEffect(() => {
    const controller = new AbortController();
    void loadIntentsCatalog(controller.signal)
      .then((catalog) => {
        if (controller.signal.aborted) return;
        const next = [...catalog.chains].sort((a, b) => chainLabel(a).localeCompare(chainLabel(b)));
        setChains(next);
        setChain((current) =>
          next.includes(current) ? current : next.includes('near') ? 'near' : (next[0] ?? current),
        );
      })
      .catch((err) => {
        if (!controller.signal.aborted) toast.error(errorMessage(err));
      });
    return () => controller.abort();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = address.trim();
    if (!isValidAddress(chainId(chain), trimmed)) {
      toast.error('That address does not match this network.');
      return;
    }
    // The API mints the saved address's id (`pal_…`); the empty id here is replaced.
    const p = await run(() =>
      draftProposal({ add_saved_address: { id: '', chain, address: trimmed } }),
    );
    if (p) router.push(`/dashboard/approvals/${p.id}`);
  }

  return (
    <form onSubmit={submit} className="form">
      <div className="row">
        <label className="field">
          <span>Network</span>
          <AssetGridPicker
            ariaLabel="Network"
            title="Chain"
            value={chain}
            onChange={setChain}
            placeholder={chains.length ? 'Choose a network' : 'Loading networks…'}
            disabled={!chains.length}
            options={chains.map((id) => ({
              value: id,
              label: chainLabel(id),
              icon: <ChainLogo chain={id} />,
            }))}
          />
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
            placeholder={addressHint(chain)}
          />
        </label>
      </div>
      <Alert tone="info">
        After the signers approve it, this address waits 24 hours before it can receive money. Check
        every character: money sent to a wrong address cannot be recovered.
      </Alert>
      <Button type="submit" className="dash-btn-icon" disabled={busy || !address.trim()}>
        {busy ? (
          'Saving…'
        ) : (
          <>
            <Plus size={16} strokeWidth={1.75} aria-hidden />
            Ask to add this address
          </>
        )}
      </Button>
    </form>
  );
}
