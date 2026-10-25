// A human summary of a proposal's action, decoded from the action JSON the API returns (the
// contract's own shape). Anything that names where money goes shows the FULL destination address
// and its chain, never a nickname alone; for a swap withdrawal the real destination is the
// swap's deposit account, which is shown as such.
import type { ActionJson, SavedAddress, TeamMember } from './api';
import { chainLabel, formatAmount } from './assets';

export interface Destination {
  chain: string;
  address: string;
  /** Why this is the destination, when it is not simply the saved address. */
  note?: string;
}

export interface ActionSummary {
  /** Short title, e.g. "Withdraw 25 USDC". */
  title: string;
  /** Label / value rows. */
  rows: { label: string; value: string }[];
  /** Where funds go (withdrawals, refunds, sweeps, wallet settlement, new saved addresses). */
  destination: Destination | null;
  /** Things a signer must read before approving. */
  warnings: string[];
}

export interface ActionContext {
  savedAddresses: SavedAddress[];
  members: TeamMember[];
  /** The account's mode: amounts are humanised only for that mode's registered assets. */
  livemode: boolean;
}

const KIND_TITLES: Record<string, string> = {
  add_signer: 'Add a signer',
  remove_signer: 'Remove a signer',
  add_signer_key: 'Add a key to a signer',
  remove_signer_key: 'Remove a key from a signer',
  set_threshold: 'Change the approval rule',
  set_origins: 'Change allowed origins',
  rotate_recovery_key: 'Replace the recovery kit',
  add_saved_address: 'Add a saved address',
  remove_saved_address: 'Remove a saved address',
  set_limits: 'Change withdrawal limits',
  set_refund_cap: 'Change the refund cap',
  set_auto_sweep: 'Turn on auto-sweep',
  clear_auto_sweep: 'Turn off auto-sweep',
  withdraw: 'Withdraw',
  refund: 'Refund',
  upgrade: 'Upgrade the account contract',
  set_settlement: 'Change where payments settle',
};

export function kindOf(action: ActionJson): string {
  return Object.keys(action)[0] ?? 'unknown';
}

export function kindTitle(kind: string): string {
  return KIND_TITLES[kind] ?? kind;
}

function person(members: TeamMember[], userId: string): string {
  const m = members.find((x) => x.userId === userId);
  return m ? `${m.email} (${userId})` : userId;
}

function saved(
  ctx: ActionContext,
  id: string,
  warnings: string[],
): { destination: Destination | null; label: string } {
  const a = ctx.savedAddresses.find((x) => x.id === id);
  if (!a) {
    warnings.push(
      `Saved address ${id} is not in this store's list. Do not approve unless you know it.`,
    );
    return { destination: null, label: id };
  }
  if (a.status === 'revoked') warnings.push('This saved address has been removed.');
  return {
    destination: { chain: a.chain, address: a.address },
    label: `${chainLabel(a.chain)} · ${a.address}`,
  };
}

const limit = (asset: string, v: unknown, livemode: boolean) =>
  v === null || v === undefined ? 'No limit' : formatAmount(asset, String(v), livemode);

export function describeAction(action: ActionJson, ctx: ActionContext): ActionSummary {
  const kind = kindOf(action);
  const v = action[kind] as Record<string, unknown>;
  const rows: { label: string; value: string }[] = [];
  const warnings: string[] = [];
  let destination: Destination | null = null;
  let title = kindTitle(kind);

  switch (kind) {
    case 'withdraw':
    case 'set_auto_sweep': {
      const asset = String(v.asset);
      const s = saved(ctx, String(v.saved_address_id), warnings);
      if (kind === 'withdraw') {
        const amount = formatAmount(asset, String(v.amount), ctx.livemode);
        title = `Withdraw ${amount}`;
        rows.push({ label: 'Amount', value: amount });
        const route = v.route as {
          poa?: { token_contract: string };
          swap?: { deposit_account: string };
        };
        if (route.swap) {
          destination = {
            chain: 'near',
            address: route.swap.deposit_account,
            note: `Swap deposit account. The swap service pays out to ${s.label}.`,
          };
          rows.push({ label: 'Route', value: 'Swap to a different token (waits 24 h)' });
          rows.push({ label: 'Saved address', value: s.label });
          warnings.push(
            'Funds go to the swap deposit account shown, not straight to the saved address.',
          );
        } else {
          destination = s.destination;
          rows.push({
            label: 'Route',
            value: `Same token (${route.poa?.token_contract ?? 'unknown token'})`,
          });
        }
      } else {
        destination = s.destination;
        rows.push({ label: 'Asset', value: asset });
        rows.push({
          label: 'Sweep when above',
          value: formatAmount(asset, String(v.trigger_above), ctx.livemode),
        });
        rows.push({ label: 'Keep', value: formatAmount(asset, String(v.keep), ctx.livemode) });
      }
      rows.push({ label: 'Asset id', value: asset });
      break;
    }
    case 'refund': {
      const asset = String(v.asset);
      const amount = formatAmount(asset, String(v.amount), ctx.livemode);
      title = `Refund ${amount}`;
      rows.push({ label: 'Amount', value: amount });
      rows.push({ label: 'Payment', value: String(v.payment_id) });
      const route = v.route as { swap?: { deposit_account: string } };
      destination = route.swap
        ? {
            chain: 'near',
            address: route.swap.deposit_account,
            note: `Swap deposit account. The swap service pays out to ${String(v.destination)} on ${chainLabel(String(v.destination_chain))}.`,
          }
        : { chain: String(v.destination_chain), address: String(v.destination) };
      break;
    }
    case 'add_saved_address':
      destination = { chain: String(v.chain), address: String(v.address) };
      rows.push({ label: 'Usable', value: '24 hours after it is approved' });
      break;
    case 'remove_saved_address': {
      const s = saved(ctx, String(v.id), warnings);
      destination = s.destination;
      break;
    }
    case 'set_settlement': {
      rows.push({ label: 'Settle in', value: String(v.dest_asset) });
      if (v.payout_mode === 'wallet' && v.saved_address_id) {
        const s = saved(ctx, String(v.saved_address_id), warnings);
        destination = s.destination;
        rows.push({ label: 'Paid out to', value: 'A saved address (each payment)' });
      } else {
        rows.push({ label: 'Paid out to', value: 'This account (Tendr balance)' });
      }
      break;
    }
    case 'set_limits': {
      const asset = String(v.asset);
      rows.push({ label: 'Asset', value: asset });
      rows.push({ label: 'Per withdrawal', value: limit(asset, v.per_tx, ctx.livemode) });
      rows.push({ label: 'Per day', value: limit(asset, v.per_day, ctx.livemode) });
      rows.push({
        label: 'Note',
        value: 'Raising a limit waits 24 h; lowering it applies at once.',
      });
      break;
    }
    case 'set_refund_cap': {
      const asset = String(v.asset);
      rows.push({ label: 'Asset', value: asset });
      rows.push({
        label: 'Refunds per day without waiting',
        value: formatAmount(asset, String(v.daily), ctx.livemode),
      });
      break;
    }
    case 'clear_auto_sweep':
      rows.push({ label: 'Asset', value: String(v.asset) });
      break;
    case 'add_signer': {
      const id = String(v.id);
      rows.push({ label: 'Person', value: person(ctx.members, id) });
      rows.push({ label: 'Passkeys', value: String((v.keys as unknown[]).length) });
      break;
    }
    case 'remove_signer':
      rows.push({ label: 'Person', value: person(ctx.members, String(v.id)) });
      break;
    case 'add_signer_key':
    case 'remove_signer_key':
      rows.push({ label: 'Person', value: person(ctx.members, String(v.id)) });
      break;
    case 'set_threshold': {
      const n = Number(action.set_threshold);
      rows.push({ label: 'Approvals needed', value: String(n) });
      title = `Require ${n} approval${n === 1 ? '' : 's'}`;
      break;
    }
    case 'set_origins':
      rows.push({ label: 'Origins', value: (action.set_origins as string[]).join(', ') });
      break;
    case 'rotate_recovery_key':
      rows.push({
        label: 'New recovery kit',
        value:
          action.rotate_recovery_key === null
            ? 'None (turned off)'
            : 'A new kit replaces the old one',
      });
      break;
    case 'upgrade':
      rows.push({ label: 'Code hash', value: String(v.code_hash) });
      warnings.push('An upgrade replaces the code that guards the account.');
      break;
    default:
      rows.push({ label: 'Action', value: JSON.stringify(action) });
      break;
  }
  return { title, rows, destination, warnings };
}

/** Time left until `iso` as `5h 03m` (or `ready` once past). */
export function countdown(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'ready';
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** `usable in 24h` (whole hours, rounded up) for a saved address that is not active yet. */
export function usableIn(activeFrom: string, now: number = Date.now()): string {
  const ms = new Date(activeFrom).getTime() - now;
  if (ms <= 0) return 'usable now';
  return `usable in ${Math.ceil(ms / 3_600_000)}h`;
}
