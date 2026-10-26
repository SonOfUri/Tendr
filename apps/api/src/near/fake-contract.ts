// An in-memory stand-in for the merchant-account contract, used by `FakeNearClient` when it runs
// with `simulateContracts` (local dev and the dashboard's end-to-end tests: NEAR_FAKE_SIMULATE=1).
// It answers the calls the API relays and the views the watcher reads, with the contract's
// events, so the dashboard can be driven end to end with no NEAR node.
//
// It is NOT the contract and checks far less: it trusts the relay's approvals (the API verified
// the passkey assertion locally), never verifies a recovery signature (the API did), and moves no
// funds (withdrawals and refunds execute at once). The rules it does keep are the ones the
// dashboard shows: the threshold, timelocks (swap withdrawals, limit and refund-cap raises, and
// security changes that widen access: adding a signer or key, replacing or clearing the recovery
// key, lowering the threshold, changing origins), expiry settled by `execute`,
// saved addresses becoming usable 24 h after they are added, the 72 h recovery delay, nonces and
// epochs. API unit tests do not use it: they script the fake directly.
import { proposalId, recoveryId, type ActionJson } from '../accounts/encoding.js';
import type { InitConfigJson } from './client.js';

const NS_PER_MS = 1_000_000n;
const HOUR_NS = 3_600_000n * NS_PER_MS;
export const SIM_SAVED_ADDRESS_DELAY_NS = 24n * HOUR_NS;
export const SIM_TIMELOCK_DELAY_NS = 24n * HOUR_NS;
export const SIM_RECOVERY_DELAY_NS = 72n * HOUR_NS;
export const SIM_PROPOSAL_TTL_NS = 7n * 24n * HOUR_NS;

type SignerKeyJson = InitConfigJson['signers'][number]['keys'][number];
type Signer = { id: string; keys: SignerKeyJson[] };

interface Approval {
  signer_id: string;
  key: unknown;
  signer_epoch: bigint;
}

interface Proposal {
  id: string;
  action: ActionJson;
  creator: string;
  createdAt: bigint;
  approvals: Approval[];
  readyAt: bigint | null;
  timelockEpoch: bigint | null;
  status: 'pending' | 'executed' | 'failed' | 'cancelled' | 'expired';
}

interface AssetState {
  perTx: bigint | null;
  perDay: bigint | null;
  refundCap: bigint;
  sweep: {
    trigger_above: string;
    keep: string;
    saved_address_id: string;
    chain: string;
    address: string;
  } | null;
}

interface AccountState {
  signers: Signer[];
  threshold: number;
  epoch: bigint;
  recoveryKey: string | null;
  recoveryKeyEpoch: bigint;
  recoveryNonce: bigint;
  recovery: {
    nonce: bigint;
    recoveryKeyEpoch: bigint;
    newSigners: Signer[];
    newThreshold: number;
    executesAt: bigint;
  } | null;
  proposals: Map<string, Proposal>;
  order: string[];
  saved: { id: string; chain: string; address: string; active_from: bigint }[];
  assets: Map<string, AssetState>;
  settlement: { dest_asset: string; payout_mode: string; saved_address_id: string | null } | null;
}

/** A contract panic: the fake turns it into a failed transaction with this message. */
export class SimulatedPanic extends Error {}

const panic = (msg: string): never => {
  throw new SimulatedPanic(`Smart contract panicked: ${msg}`);
};

const EVENT_STANDARD = 'tendr-merchant-account';
const log = (event: string, data: object) =>
  `EVENT_JSON:${JSON.stringify({ standard: EVENT_STANDARD, version: '1.0.0', event, data })}`;

const kindOf = (a: ActionJson) => Object.keys(a)[0]!;
const valueOf = <T>(a: ActionJson) => (a as Record<string, unknown>)[kindOf(a)] as T;
const u128 = (v: string | null | undefined) => (v === null || v === undefined ? null : BigInt(v));

export class FakeMerchantContracts {
  private readonly accounts = new Map<string, AccountState>();

  constructor(
    private readonly now: () => bigint = () => BigInt(Date.now()) * NS_PER_MS,
    /**
     * The timelock delay. The WooCommerce e2e shortens it (`NEAR_FAKE_TIMELOCK_SECONDS`) so a
     * store refund, which is timelocked above the refund cap, executes within the run.
     */
    private readonly timelockNs: bigint = SIM_TIMELOCK_DELAY_NS,
  ) {}

  has(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  init(accountId: string, init: InitConfigJson): void {
    this.accounts.set(accountId, {
      signers: structuredClone(init.signers),
      threshold: init.threshold,
      epoch: 0n,
      recoveryKey: init.recovery_key,
      recoveryKeyEpoch: 0n,
      recoveryNonce: 0n,
      recovery: null,
      proposals: new Map(),
      order: [],
      saved: [],
      assets: new Map(),
      settlement: null,
    });
  }

  /** `admin_sync_signers` on a test account. */
  syncSigners(accountId: string, signers: Signer[], threshold: number): void {
    const s = this.accounts.get(accountId);
    if (!s) return;
    s.signers = structuredClone(signers);
    s.threshold = threshold;
    s.epoch += 1n;
  }

  /** The logs of a successful call, or a thrown `SimulatedPanic`. */
  call(accountId: string, method: string, args: Record<string, unknown>): string[] {
    const s = this.accounts.get(accountId) ?? panic('account does not exist');
    const now = this.now();
    switch (method) {
      case 'propose':
        return this.propose(accountId, s, args, now);
      case 'approve':
        return this.approve(accountId, s, args, now);
      case 'execute': {
        const pending = s.proposals.get(String(args.proposal_id));
        if (pending?.status === 'pending' && now > pending.createdAt + SIM_PROPOSAL_TTL_NS) {
          // Like the contract: `execute` past the TTL marks it expired (and frees the slot).
          pending.status = 'expired';
          return [log('proposal_failed', { proposal_id: pending.id, reason: 'expired' })];
        }
        const p = this.open(s, String(args.proposal_id), now);
        if (p.readyAt === null || p.timelockEpoch !== s.epoch) panic('proposal is not approved');
        if (now < p.readyAt!) panic('proposal is timelocked');
        return this.execute(accountId, s, p, now);
      }
      case 'cancel': {
        const p = this.open(s, String(args.proposal_id), now);
        const signer = this.approver(s, args.approval);
        p.status = 'cancelled';
        return [log('proposal_cancelled', { proposal_id: p.id, signer_id: signer })];
      }
      case 'start_recovery':
        return this.startRecovery(accountId, s, args, now);
      case 'cancel_recovery': {
        if (!s.recovery) panic('no recovery is pending');
        const signer = this.approver(s, args.approval);
        s.recovery = null;
        return [log('recovery_cancelled', { signer_id: signer })];
      }
      case 'execute_recovery': {
        const r = s.recovery ?? panic('no recovery is pending');
        if (now < r!.executesAt) panic('recovery is not ready');
        s.recovery = null;
        s.signers = r!.newSigners;
        s.threshold = r!.newThreshold;
        s.epoch += 1n;
        const ids = s.signers.map((x) => x.id);
        return [
          log('recovery_executed', {
            new_signer_ids: ids,
            new_threshold: s.threshold,
            signer_epoch: s.epoch.toString(),
          }),
          this.signersChanged(s, null),
        ];
      }
      default:
        return panic(`method ${method} is not simulated`);
    }
  }

  /** A view's JSON answer, or `undefined` when the view is not simulated. */
  view(accountId: string, method: string, args: Record<string, unknown>): unknown {
    const s = this.accounts.get(accountId);
    if (!s) return undefined;
    const now = this.now();
    switch (method) {
      case 'get_proposal': {
        const p = s.proposals.get(String(args.id));
        return p ? this.proposalView(s, p, now) : null;
      }
      case 'list_proposals': {
        const from = Number(args.from_index ?? 0);
        const limit = Math.min(Number(args.limit ?? 50), 100);
        return s.order
          .slice(from, from + limit)
          .map((id) => this.proposalView(s, s.proposals.get(id)!, now));
      }
      case 'list_saved_addresses':
        return s.saved.map((a) => ({ ...a, active_from: a.active_from.toString() }));
      case 'get_settlement':
        return s.settlement;
      case 'get_limits': {
        const a = this.asset(s, String(args.asset));
        return {
          per_tx: a.perTx?.toString() ?? null,
          per_day: a.perDay?.toString() ?? null,
          refund_cap: a.refundCap.toString(),
          pending_raise: null,
          spent_24h: '0',
          refunded_24h: '0',
        };
      }
      case 'get_auto_sweep': {
        const a = this.asset(s, String(args.asset));
        return a.sweep ? { ...a.sweep, in_flight: false } : null;
      }
      case 'get_recovery': {
        const r = s.recovery;
        if (!r) return null;
        return {
          recovery_id: recoveryId(accountId, r.recoveryKeyEpoch, r.nonce),
          nonce: r.nonce.toString(),
          recovery_key_epoch: r.recoveryKeyEpoch.toString(),
          new_signer_ids: r.newSigners.map((x) => x.id),
          new_threshold: r.newThreshold,
          executes_at: r.executesAt.toString(),
        };
      }
      case 'get_recovery_nonce':
        return s.recoveryNonce.toString();
      default:
        return undefined;
    }
  }

  /** The signer set and keys, as `get_config` reports them. */
  config(accountId: string) {
    const s = this.accounts.get(accountId);
    if (!s) return undefined;
    return {
      signers: structuredClone(s.signers),
      threshold: s.threshold,
      signer_epoch: s.epoch.toString(),
      recovery_key_set: s.recoveryKey !== null,
      recovery_key_epoch: s.recoveryKeyEpoch.toString(),
    };
  }

  // ─── proposals ─────────────────────────────────────────────────────────────

  private approver(s: AccountState, approval: unknown): string {
    const a = approval as { signer_id?: unknown } | undefined;
    const id = typeof a?.signer_id === 'string' ? a.signer_id : '';
    if (!s.signers.some((x) => x.id === id)) panic('not a signer');
    return id;
  }

  private open(s: AccountState, id: string, now: bigint): Proposal {
    const p = s.proposals.get(id) ?? panic('unknown proposal');
    if (p!.status !== 'pending') panic(`proposal is ${p!.status}`);
    if (now > p!.createdAt + SIM_PROPOSAL_TTL_NS) panic('proposal expired');
    return p!;
  }

  private propose(
    accountId: string,
    s: AccountState,
    args: Record<string, unknown>,
    now: bigint,
  ): string[] {
    const action = args.action as ActionJson;
    const salt = new Uint8Array(Buffer.from(String(args.salt), 'base64'));
    const id = proposalId(action, salt);
    if (s.proposals.has(id)) panic('proposal already exists');
    const signer = this.approver(s, args.approval);
    this.checkAction(s, action, now);
    const p: Proposal = {
      id,
      action: structuredClone(action),
      creator: signer,
      createdAt: now,
      approvals: [],
      readyAt: null,
      timelockEpoch: null,
      status: 'pending',
    };
    s.proposals.set(id, p);
    s.order.push(id);
    const logs = [
      log('proposal_created', {
        proposal_id: id,
        signer_id: signer,
        action,
        expires_at: (now + SIM_PROPOSAL_TTL_NS).toString(),
      }),
    ];
    return [...logs, ...this.addApproval(accountId, s, p, args.approval, now)];
  }

  private approve(
    accountId: string,
    s: AccountState,
    args: Record<string, unknown>,
    now: bigint,
  ): string[] {
    const p = this.open(s, String(args.proposal_id), now);
    return this.addApproval(accountId, s, p, args.approval, now);
  }

  private addApproval(
    accountId: string,
    s: AccountState,
    p: Proposal,
    approval: unknown,
    now: bigint,
  ): string[] {
    const signer = this.approver(s, approval);
    if (p.approvals.some((a) => a.signer_id === signer && a.signer_epoch === s.epoch)) {
      panic('signer already approved');
    }
    p.approvals = p.approvals.filter((a) => a.signer_id !== signer);
    p.approvals.push({
      signer_id: signer,
      key: (approval as { key?: unknown }).key ?? null,
      signer_epoch: s.epoch,
    });
    const valid = this.valid(s, p);
    const logs = [
      log('proposal_approved', {
        proposal_id: p.id,
        signer_id: signer,
        signer_epoch: s.epoch.toString(),
        approvals: valid,
        threshold: s.threshold,
      }),
    ];
    if (valid < s.threshold) return logs;
    if (p.readyAt !== null && p.timelockEpoch === s.epoch) return logs;
    if (this.needsTimelock(s, p.action)) {
      p.readyAt = now + this.timelockNs;
      p.timelockEpoch = s.epoch;
      return [
        ...logs,
        log('timelock_started', {
          proposal_id: p.id,
          action: p.action,
          ready_at: p.readyAt.toString(),
        }),
      ];
    }
    return [...logs, ...this.execute(accountId, s, p, now)];
  }

  private valid(s: AccountState, p: Proposal): number {
    return p.approvals.filter(
      (a) => a.signer_epoch === s.epoch && s.signers.some((x) => x.id === a.signer_id),
    ).length;
  }

  private asset(s: AccountState, asset: string): AssetState {
    return s.assets.get(asset) ?? { perTx: null, perDay: null, refundCap: 0n, sweep: null };
  }

  private updateAsset(s: AccountState, asset: string, fn: (a: AssetState) => void): void {
    const a = structuredClone(this.asset(s, asset));
    fn(a);
    s.assets.set(asset, a);
  }

  private needsTimelock(s: AccountState, action: ActionJson): boolean {
    const raises = (old: bigint | null, next: bigint | null) =>
      old === null ? false : next === null ? true : next > old;
    switch (kindOf(action)) {
      case 'add_signer':
      case 'add_signer_key':
      case 'rotate_recovery_key':
      case 'set_origins':
      case 'upgrade':
        return true;
      case 'set_threshold':
        return valueOf<number>(action) < s.threshold;
      case 'withdraw':
        return 'swap' in valueOf<{ route: object }>(action).route;
      case 'refund': {
        const v = valueOf<{ asset: string; amount: string }>(action);
        return BigInt(v.amount) > this.asset(s, v.asset).refundCap;
      }
      case 'set_limits': {
        const v = valueOf<{ asset: string; per_tx: string | null; per_day: string | null }>(action);
        const a = this.asset(s, v.asset);
        return raises(a.perTx, u128(v.per_tx)) || raises(a.perDay, u128(v.per_day));
      }
      case 'set_refund_cap': {
        const v = valueOf<{ asset: string; daily: string }>(action);
        return BigInt(v.daily) > this.asset(s, v.asset).refundCap;
      }
      default:
        return false;
    }
  }

  /** The contract's fast checks that the dashboard relies on (saved address usability). */
  private checkAction(s: AccountState, action: ActionJson, now: bigint): void {
    const usable = (id: string) => {
      const a = s.saved.find((x) => x.id === id) ?? panic('unknown saved address');
      if (now < a!.active_from) panic('saved address is not active yet');
    };
    switch (kindOf(action)) {
      case 'withdraw':
        usable(valueOf<{ saved_address_id: string }>(action).saved_address_id);
        break;
      case 'add_saved_address': {
        const v = valueOf<{ id: string }>(action);
        if (s.saved.some((x) => x.id === v.id)) panic('saved address id was used before');
        break;
      }
      default:
        break;
    }
  }

  private signersChanged(s: AccountState, proposal: string | null): string {
    return log('signers_changed', {
      proposal_id: proposal,
      signer_ids: s.signers.map((x) => x.id),
      threshold: s.threshold,
      signer_epoch: s.epoch.toString(),
      recovery_key_set: s.recoveryKey !== null,
    });
  }

  private execute(accountId: string, s: AccountState, p: Proposal, now: bigint): string[] {
    const logs: string[] = [];
    const a = p.action;
    let signersChanged = false;
    switch (kindOf(a)) {
      case 'add_signer':
        s.signers.push(structuredClone(valueOf<Signer>(a)));
        signersChanged = true;
        break;
      case 'remove_signer': {
        const { id } = valueOf<{ id: string }>(a);
        s.signers = s.signers.filter((x) => x.id !== id);
        signersChanged = true;
        break;
      }
      case 'add_signer_key': {
        const v = valueOf<{ id: string; key: SignerKeyJson }>(a);
        s.signers.find((x) => x.id === v.id)?.keys.push(v.key);
        signersChanged = true;
        break;
      }
      case 'remove_signer_key': {
        const v = valueOf<{ id: string; key: SignerKeyJson }>(a);
        const signer = s.signers.find((x) => x.id === v.id);
        if (signer) {
          const k = JSON.stringify(v.key);
          signer.keys = signer.keys.filter((x) => JSON.stringify(x) !== k);
        }
        signersChanged = true;
        break;
      }
      case 'set_threshold':
        s.threshold = valueOf<number>(a);
        signersChanged = true;
        break;
      case 'rotate_recovery_key':
        s.recoveryKey = valueOf<string | null>(a);
        s.recoveryKeyEpoch += 1n;
        s.recoveryNonce = 0n;
        if (s.recovery) {
          s.recovery = null;
          logs.push(log('recovery_cancelled', { reason: 'recovery_key_rotated' }));
        }
        break;
      case 'add_saved_address': {
        const v = valueOf<{ id: string; chain: string; address: string }>(a);
        s.saved.push({ ...v, active_from: now + SIM_SAVED_ADDRESS_DELAY_NS });
        break;
      }
      case 'remove_saved_address': {
        const { id } = valueOf<{ id: string }>(a);
        s.saved = s.saved.filter((x) => x.id !== id);
        break;
      }
      case 'set_limits': {
        const v = valueOf<{ asset: string; per_tx: string | null; per_day: string | null }>(a);
        this.updateAsset(s, v.asset, (x) => {
          x.perTx = u128(v.per_tx);
          x.perDay = u128(v.per_day);
        });
        break;
      }
      case 'set_refund_cap': {
        const v = valueOf<{ asset: string; daily: string }>(a);
        this.updateAsset(s, v.asset, (x) => {
          x.refundCap = BigInt(v.daily);
        });
        break;
      }
      case 'set_auto_sweep': {
        const v = valueOf<{
          asset: string;
          trigger_above: string;
          keep: string;
          saved_address_id: string;
        }>(a);
        const dest = s.saved.find((x) => x.id === v.saved_address_id);
        if (!dest) {
          p.status = 'failed';
          return [log('proposal_failed', { proposal_id: p.id, reason: 'unknown saved address' })];
        }
        this.updateAsset(s, v.asset, (x) => {
          x.sweep = {
            trigger_above: v.trigger_above,
            keep: v.keep,
            saved_address_id: dest.id,
            chain: dest.chain,
            address: dest.address,
          };
        });
        break;
      }
      case 'clear_auto_sweep': {
        const v = valueOf<{ asset: string }>(a);
        this.updateAsset(s, v.asset, (x) => {
          x.sweep = null;
        });
        break;
      }
      case 'set_settlement': {
        const v = valueOf<{
          dest_asset: string;
          payout_mode: string;
          saved_address_id: string | null;
        }>(a);
        s.settlement = { ...v };
        logs.push(log('settlement_changed', { proposal_id: p.id, ...v }));
        break;
      }
      default:
        // withdraw, refund, upgrade: no funds or code move in the simulation.
        break;
    }
    p.status = 'executed';
    if (signersChanged) {
      s.epoch += 1n;
      logs.push(this.signersChanged(s, p.id));
    }
    void accountId;
    return [log('proposal_executed', { proposal_id: p.id, action: a }), ...logs];
  }

  private proposalView(s: AccountState, p: Proposal, now: bigint) {
    const expired =
      p.status === 'pending' && now > p.createdAt + SIM_PROPOSAL_TTL_NS ? 'expired' : p.status;
    return {
      id: p.id,
      action: p.action,
      creator: p.creator,
      created_at: p.createdAt.toString(),
      expires_at: (p.createdAt + SIM_PROPOSAL_TTL_NS).toString(),
      approvals: p.approvals.map((a) => ({
        signer_id: a.signer_id,
        key: a.key,
        signer_epoch: a.signer_epoch.toString(),
      })),
      valid_approvals: this.valid(s, p),
      ready_at: p.readyAt !== null && p.timelockEpoch === s.epoch ? p.readyAt.toString() : null,
      status: expired,
    };
  }

  // ─── recovery ──────────────────────────────────────────────────────────────

  private startRecovery(
    accountId: string,
    s: AccountState,
    args: Record<string, unknown>,
    now: bigint,
  ): string[] {
    if (s.recoveryKey === null) panic('no recovery key is set');
    if (s.recovery) panic('a recovery is already pending');
    const nonce = BigInt(String(args.nonce));
    if (nonce <= s.recoveryNonce) panic('recovery nonce must exceed the last one used');
    if (now > BigInt(String(args.valid_until))) panic('recovery payload expired');
    s.recoveryNonce = nonce;
    s.recovery = {
      nonce,
      recoveryKeyEpoch: s.recoveryKeyEpoch,
      newSigners: structuredClone(args.new_signers as Signer[]),
      newThreshold: Number(args.new_threshold),
      executesAt: now + SIM_RECOVERY_DELAY_NS,
    };
    return [
      log('recovery_started', {
        recovery_id: recoveryId(accountId, s.recoveryKeyEpoch, nonce),
        nonce: nonce.toString(),
        recovery_key_epoch: s.recoveryKeyEpoch.toString(),
        new_signer_ids: s.recovery.newSigners.map((x) => x.id),
        new_threshold: s.recovery.newThreshold,
        executes_at: s.recovery.executesAt.toString(),
      }),
    ];
  }
}
