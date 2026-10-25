// The chain watcher: applies the merchant-account contract's events to the Postgres mirror, and
// reconciles the mirror with the contract's own views.
//
// Sources of truth, in order:
// - The relayer applies the events in the logs of its own transactions right away
//   (`applyAccountEventsTx` inside the request's transaction, then `afterAccountEvents`).
// - `reconcileAccount` (a worker job, every 60 s per active account, both modes) reads
//   `get_config`, `list_proposals` / `get_proposal`, `get_recovery`, `list_saved_addresses`,
//   `get_settlement`, `get_limits` and `get_auto_sweep`, and applies any difference. It catches
//   transactions our relayer never sent, so notices never depend on the website or the API.
//   *(Pilot ruling: no indexer; reconciliation is the backstop.)*
//
// Everything here is idempotent on replay:
// - lifecycle events (`account.proposal.*`, `account.recovery.*`) are recorded once per chain fact,
//   keyed by a `dedupeKey` in the payload (e.g. `approved:<signer>:<epoch>`);
// - mirror changes (signers and keys, saved addresses, limits, settlement, the recovery key) are
//   recorded only when the mirror actually changed, and the signer-set event is keyed by its
//   content (epoch, threshold, signers and keys).
// Mirror writes for one account are serialised on its `merchant_accounts` row (`FOR UPDATE`).
//
// Times taken from the chain (`ready_at`, `executes_at`, `active_from`) are the contract's block
// timestamps (ns) converted to Dates, never the time we happened to see them.
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { type MerchantAccount, type ProposalStatus } from '@prisma/client';
import { SignerKeySchema, type SignerKey } from '@tendr/contracts';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { nearClient, type SignerKeyJson } from '../near/client.js';
import type { ConfigView } from './accounts.js';
import { ActionSchema, kindOf, type ActionJson } from './encoding.js';
import { nsToDate, parseAccountEvents, u64Of, type AccountEvent } from './events.js';
import {
  applyProposalEvents,
  applyProposalView,
  credentialForKey,
  landed,
  relay,
  RELAY_CLAIM_LEASE_MS,
  upsertApproval,
  type ContractProposalView,
} from './proposals.js';

export { parseAccountEvents };

type Tx = Prisma.TransactionClient;

const HEX32 = /^[0-9a-f]{64}$/;
/** `list_proposals` page size (the contract's `MAX_LIST_LIMIT`). */
const LIST_PAGE = 100;
/** Most `list_proposals` pages one reconciliation reads; the rest waits for the next run. */
const MAX_PAGES_PER_RUN = 10;
/** How many due proposals / recoveries one scheduled run executes. */
const EXECUTE_BATCH = 50;

/** Event types this module records. */
export const AccountEventTypes = {
  proposalCreated: 'account.proposal.created',
  proposalApproved: 'account.proposal.approved',
  proposalTimelocked: 'account.proposal.timelocked',
  proposalExecuted: 'account.proposal.executed',
  proposalFailed: 'account.proposal.failed',
  proposalCancelled: 'account.proposal.cancelled',
  signersChanged: 'account.signers.changed',
  recoveryStarted: 'account.recovery.started',
  recoveryCancelled: 'account.recovery.cancelled',
  recoveryExecuted: 'account.recovery.executed',
  recoveryKeyRotated: 'account.recovery_key.rotated',
  savedAddressAdded: 'account.saved_address.added',
  savedAddressRemoved: 'account.saved_address.removed',
  limitsChanged: 'account.limits.changed',
  settlementChanged: 'account.settlement.changed',
  recoverySessionOpened: 'account.recovery_session.opened',
  recoveryPasskeyRegistered: 'account.recovery_session.passkey_registered',
  mirrorConflict: 'merchant_account.mirror_conflict',
} as const;
const T = AccountEventTypes;

/** What the chain changed that needs a fresh contract view (fetched outside the transaction). */
export interface ApplyOutcome {
  signers: boolean;
  /**
   * What caused each signer change (the proposal id, else the transaction hash): the
   * `account.signers.changed` event is keyed by it, so every change is announced even when a
   * later one returns to an earlier signer set (M2).
   */
  signerCauses: string[];
  savedAddresses: boolean;
  limitAssets: Set<string>;
}

const emptyOutcome = (): ApplyOutcome => ({
  signers: false,
  signerCauses: [],
  savedAddresses: false,
  limitAssets: new Set(),
});

const ctxOf = (a: { merchantId: string; livemode: boolean }): ScopeContext => ({
  merchantId: a.merchantId,
  livemode: a.livemode,
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const keyIdOf = (k: SignerKeyJson | SignerKey) =>
  'p256' in k ? `p256:${k.p256}` : `ed25519:${k.ed25519}`;

async function lockAccount(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM merchant_accounts WHERE id = ${id} FOR UPDATE`;
}

/**
 * Records an event unless one with the same aggregate, type and `dedupeKey` exists (replays of
 * the same chain fact). Returns whether it was recorded.
 */
async function recordOnce(
  tx: Tx,
  ctx: ScopeContext,
  e: { aggregateType: string; aggregateId: string; type: string; key: string; payload: object },
): Promise<boolean> {
  const dup = await tx.event.findFirst({
    where: {
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      type: e.type,
      payload: { path: ['dedupeKey'], equals: e.key },
    },
    select: { id: true },
  });
  if (dup) return false;
  await recordEvent(tx, ctx, {
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    type: e.type,
    payload: { ...e.payload, dedupeKey: e.key },
  });
  return true;
}

// ─── applying events ─────────────────────────────────────────────────────────

/**
 * Applies the contract's events (from one transaction's successful receipts, or synthesised by
 * reconciliation) to the mirror of `account`, inside the caller's transaction. Idempotent. Returns
 * what still needs a fresh contract view; pass it to `afterAccountEvents` once committed.
 */
export async function applyAccountEventsTx(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id' | 'merchantId' | 'livemode' | 'nearAccountId'>,
  events: readonly AccountEvent[],
  txHash: string | null,
): Promise<ApplyOutcome> {
  const out = emptyOutcome();
  if (events.length === 0) return out;
  await lockAccount(tx, account.id);
  const byProposal = new Map<string, AccountEvent[]>();
  for (const e of events) {
    switch (e.event) {
      case 'signers_changed':
        await signersChangedTx(tx, ctx, account, e.data);
        out.signers = true;
        out.signerCauses.push(
          str(e.data.proposal_id) ?? txHash ?? `epoch:${String(e.data.signer_epoch)}`,
        );
        break;
      case 'recovery_started':
        await recoveryStartedTx(tx, ctx, account, e.data, txHash);
        break;
      case 'recovery_cancelled':
        await recoveryEndedTx(tx, ctx, account, 'cancelled', e.data, txHash);
        break;
      case 'recovery_executed':
        await recoveryEndedTx(tx, ctx, account, 'executed', e.data, txHash);
        out.signers = true;
        break;
      case 'settlement_changed':
        await writeSettlement(tx, ctx, account, {
          dest_asset: str(e.data.dest_asset) ?? '',
          payout_mode: e.data.payout_mode === 'wallet' ? 'wallet' : 'intents',
          saved_address_id: str(e.data.saved_address_id),
        });
        break;
      case 'sweep_executed':
        break;
      default: {
        const id = e.data.proposal_id;
        if (typeof id !== 'string' || !HEX32.test(id)) break;
        byProposal.set(id, [...(byProposal.get(id) ?? []), e]);
      }
    }
  }
  for (const [onchainId, evs] of byProposal) {
    await proposalEventsTx(tx, ctx, account, onchainId, evs, txHash, out);
  }
  return out;
}

/**
 * Applies `events` to `accountId`'s mirror in its own transaction, then refreshes from the chain
 * whatever they changed (signers, saved addresses, limits).
 */
export async function applyAccountEvents(
  ctx: ScopeContext,
  accountId: string,
  events: readonly AccountEvent[],
  opts: { txHash?: string | null } = {},
): Promise<ApplyOutcome> {
  const account = await prisma.merchantAccount.findFirstOrThrow({
    where: { id: accountId, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  const outcome = await tenantTransaction(ctx, (tx, c) =>
    applyAccountEventsTx(tx, c, account, events, opts.txHash ?? null),
  );
  await afterAccountEvents(account, outcome);
  return outcome;
}

/**
 * Refreshes from the contract's views what applied events changed: the signer mirror
 * (`get_config`), saved addresses (`list_saved_addresses`) and the limits of touched assets.
 * Failures are logged, not thrown: the transaction they follow has landed, and reconciliation
 * repeats this within a minute.
 */
export async function afterAccountEvents(
  account: MerchantAccount,
  outcome: ApplyOutcome,
): Promise<void> {
  const client = nearClient(account.livemode);
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      log('warn', 'account mirror refresh failed; reconciliation will retry', {
        accountId: account.id,
        what,
        err: String(err),
      });
    }
  };
  if (outcome.signers) {
    await step('signers', async () =>
      syncSigners(
        account,
        await client.view<ConfigView>(account.nearAccountId, 'get_config', {}),
        outcome.signerCauses,
      ),
    );
  }
  if (outcome.savedAddresses) {
    await step('saved addresses', async () =>
      syncSavedAddresses(
        account,
        await client.view<SavedAddressView[]>(account.nearAccountId, 'list_saved_addresses', {}),
      ),
    );
  }
  for (const asset of outcome.limitAssets) {
    await step(`limits ${asset}`, () => refreshLimits(account, asset));
  }
}

/** `signers_changed`: the epoch and threshold the next challenge needs, and the signer flags. */
async function signersChangedTx(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id' | 'merchantId' | 'livemode'>,
  d: Record<string, unknown>,
): Promise<void> {
  const epoch = u64Of(d.signer_epoch);
  const threshold = d.threshold;
  if (epoch !== null && typeof threshold === 'number' && threshold >= 1) {
    await tx.merchantAccount.updateMany({
      where: {
        id: account.id,
        merchantId: ctx.merchantId,
        livemode: ctx.livemode,
        signerEpoch: { lte: epoch },
      },
      data: { signerEpoch: epoch, threshold },
    });
  }
  if (Array.isArray(d.signer_ids) && d.signer_ids.every((x) => typeof x === 'string')) {
    await setSignerFlags(tx, account, d.signer_ids as string[]);
  }
}

/**
 * `merchant_users.is_signer` from a signer set. The flag lives on the person, not per mode, so
 * the live account decides it; the test account does only while no live account is active.
 */
async function setSignerFlags(
  tx: Tx,
  account: Pick<MerchantAccount, 'merchantId' | 'livemode'>,
  signerIds: string[],
): Promise<boolean> {
  if (!account.livemode) {
    const live = await tx.merchantAccount.findFirst({
      where: { merchantId: account.merchantId, livemode: true, status: 'active' },
      select: { id: true },
    });
    if (live) return false;
  }
  const on = await tx.merchantUser.updateMany({
    where: { merchantId: account.merchantId, userId: { in: signerIds }, isSigner: false },
    data: { isSigner: true },
  });
  const off = await tx.merchantUser.updateMany({
    where: { merchantId: account.merchantId, userId: { notIn: signerIds }, isSigner: true },
    data: { isSigner: false },
  });
  return on.count + off.count > 0;
}

/** A proposal's events: its row (created from the chain when missing), status and event rows. */
async function proposalEventsTx(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id' | 'merchantId' | 'livemode' | 'nearAccountId'>,
  onchainId: string,
  evs: AccountEvent[],
  txHash: string | null,
  out: ApplyOutcome,
): Promise<void> {
  let row = await tx.accountProposal.findFirst({
    where: { accountId: account.id, onchainId, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (!row) {
    const created = evs.find((e) => e.event === 'proposal_created');
    row = created ? await createFromChain(tx, ctx, account, onchainId, created.data) : null;
    if (!row) {
      log('warn', 'chain events for an unknown proposal skipped', {
        accountId: account.id,
        onchainId,
        events: evs.map((e) => e.event),
      });
      return;
    }
  }
  await applyProposalEvents(tx, ctx, row.id, evs, txHash);

  const base = { proposalId: row.id, onchainId, kind: row.kind, txHash };
  const rec = (type: string, key: string, payload: object) =>
    recordOnce(tx, ctx, {
      aggregateType: 'account_proposal',
      aggregateId: row.id,
      type,
      key,
      payload: { ...base, ...payload },
    });
  for (const e of evs) {
    const d = e.data;
    switch (e.event) {
      case 'proposal_created':
        await rec(T.proposalCreated, 'created', {
          signerId: str(d.signer_id),
          action: d.action ?? null,
          expiresAt: iso(nsToDate(d.expires_at)),
        });
        break;
      case 'proposal_approved':
        await rec(T.proposalApproved, `approved:${str(d.signer_id)}:${String(d.signer_epoch)}`, {
          signerId: str(d.signer_id),
          signerEpoch: str(d.signer_epoch),
          approvals: typeof d.approvals === 'number' ? d.approvals : null,
          threshold: typeof d.threshold === 'number' ? d.threshold : null,
        });
        break;
      case 'timelock_started':
        await rec(T.proposalTimelocked, `timelocked:${String(d.ready_at)}`, {
          action: d.action ?? null,
          readyAt: iso(nsToDate(d.ready_at)),
        });
        break;
      case 'proposal_executed': {
        const fresh = await rec(T.proposalExecuted, 'executed', { action: d.action ?? null });
        const action = ActionSchema.safeParse(d.action);
        if (action.success) await executedSideEffects(tx, ctx, account, action.data, out, fresh);
        break;
      }
      case 'proposal_failed':
        await rec(T.proposalFailed, 'failed', { reason: str(d.reason) });
        break;
      case 'proposal_cancelled':
        await rec(T.proposalCancelled, 'cancelled', { signerId: str(d.signer_id) });
        break;
      default:
        break;
    }
  }
}

/**
 * A row for a proposal first seen on chain (created outside our relayer, or a relay whose answer
 * was lost). Needs the on-chain action. A creator who is not a known person is stored as null
 * (the proposal is still mirrored and notified). The salt is not recoverable from chain and is
 * never needed once a proposal is on chain, so it is left empty.
 */
async function createFromChain(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id'>,
  onchainId: string,
  d: Record<string, unknown>,
) {
  const action = ActionSchema.safeParse(d.action);
  if (!action.success) return null;
  const creator = str(d.signer_id);
  const person = creator
    ? await tx.user.findUnique({ where: { id: creator }, select: { id: true } })
    : null;
  const createdAt = nsToDate(d.created_at);
  return tx.accountProposal.create({
    data: {
      id: newId('prop'),
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      accountId: account.id,
      onchainId,
      kind: kindOf(action.data),
      action: action.data as Prisma.InputJsonValue,
      salt: '',
      status: 'draft',
      createdByUserId: person?.id ?? null,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

/** Mirror changes an executed action makes (beyond the events the contract emits for it). */
async function executedSideEffects(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id' | 'merchantId' | 'livemode' | 'nearAccountId'>,
  action: ActionJson,
  out: ApplyOutcome,
  firstTime: boolean,
): Promise<void> {
  const a = action as Record<string, Record<string, unknown>>;
  switch (kindOf(action)) {
    case 'add_saved_address':
      out.savedAddresses = true;
      break;
    case 'remove_saved_address': {
      out.savedAddresses = true;
      const id = str(a.remove_saved_address!.id);
      if (id) await revokeSavedAddress(tx, ctx, id);
      break;
    }
    case 'set_limits':
    case 'set_refund_cap':
    case 'set_auto_sweep':
    case 'clear_auto_sweep': {
      const asset = str(a[kindOf(action)]!.asset);
      if (asset) out.limitAssets.add(asset);
      break;
    }
    case 'rotate_recovery_key':
      // Only on the first application: a replay must not undo a later rotation.
      if (firstTime) {
        await rotateRecoveryKeyTx(
          tx,
          ctx,
          account,
          (action as { rotate_recovery_key: string | null }).rotate_recovery_key,
        );
      }
      break;
    default:
      break;
  }
}

async function rotateRecoveryKeyTx(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id' | 'nearAccountId'>,
  keyB64: string | null,
): Promise<void> {
  const next = keyB64 ? `ed25519:${keyB64}` : null;
  const where = {
    merchantId: ctx.merchantId,
    livemode: ctx.livemode,
    nearAccountId: account.nearAccountId,
    kind: 'recovery' as const,
    revokedAt: null,
  };
  const current = await tx.accountKey.findMany({ where });
  if (current.length === 1 && current[0]!.publicKey === next) return;
  if (current.length === 0 && next === null) return;
  await tx.accountKey.updateMany({ where, data: { revokedAt: new Date() } });
  if (next) {
    await tx.accountKey.create({
      data: {
        id: newId('akey'),
        merchantId: ctx.merchantId,
        livemode: ctx.livemode,
        nearAccountId: account.nearAccountId,
        publicKey: next,
        kind: 'recovery',
      },
    });
  }
  await recordEvent(tx, ctx, {
    aggregateType: 'merchant_account',
    aggregateId: account.id,
    type: T.recoveryKeyRotated,
    payload: { publicKey: keyB64 },
  });
}

// ─── recovery ────────────────────────────────────────────────────────────────

async function recoveryStartedTx(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id'>,
  d: Record<string, unknown>,
  txHash: string | null,
): Promise<void> {
  const onchainId = str(d.recovery_id);
  const executesAt = nsToDate(d.executes_at);
  if (!onchainId || !HEX32.test(onchainId) || !executesAt) return;
  const newSignerIds = Array.isArray(d.new_signer_ids)
    ? d.new_signer_ids.filter((x): x is string => typeof x === 'string')
    : [];
  const newThreshold = typeof d.new_threshold === 'number' ? d.new_threshold : null;
  let row = await tx.recoveryRequest.findFirst({
    where: { accountId: account.id, onchainId, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  // Created once; a replay never reopens one that has since ended.
  row ??= await tx.recoveryRequest.create({
    data: {
      id: newId('rec'),
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      accountId: account.id,
      onchainId,
      executesAt,
      status: 'pending',
      newSignerIds,
      newThreshold,
      nonce: u64Of(d.nonce),
      recoveryKeyEpoch: u64Of(d.recovery_key_epoch),
      startTxHash: txHash,
    },
  });
  await recordOnce(tx, ctx, {
    aggregateType: 'recovery_request',
    aggregateId: row.id,
    type: T.recoveryStarted,
    key: 'started',
    payload: {
      recoveryId: row.id,
      onchainId,
      executesAt: executesAt.toISOString(),
      newSignerIds,
      newThreshold,
      txHash,
    },
  });
}

/**
 * `recovery_cancelled` / `recovery_executed`: the contract names no recovery id, so they end the
 * account's pending recovery (or, for a synthesised event, the one in `recovery_id`).
 */
async function recoveryEndedTx(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id'>,
  status: 'cancelled' | 'executed',
  d: Record<string, unknown>,
  txHash: string | null,
): Promise<void> {
  const named = str(d.recovery_id);
  const row = await tx.recoveryRequest.findFirst({
    where: {
      accountId: account.id,
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      status: 'pending',
      ...(named ? { onchainId: named } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  if (row) {
    await tx.recoveryRequest.update({
      where: { id: row.id },
      data: {
        status,
        ...(txHash
          ? status === 'cancelled'
            ? { cancelTxHash: txHash }
            : { executeTxHash: txHash }
          : {}),
      },
    });
  }
  const payload =
    status === 'cancelled'
      ? { signerId: str(d.signer_id), reason: str(d.reason) }
      : {
          newSignerIds: Array.isArray(d.new_signer_ids) ? d.new_signer_ids : [],
          newThreshold: typeof d.new_threshold === 'number' ? d.new_threshold : null,
          signerEpoch: str(d.signer_epoch),
        };
  await recordOnce(tx, ctx, {
    aggregateType: row ? 'recovery_request' : 'merchant_account',
    aggregateId: row?.id ?? account.id,
    type: status === 'cancelled' ? T.recoveryCancelled : T.recoveryExecuted,
    key: row ? status : `${status}:${str(d.signer_epoch) ?? hash(d)}`,
    payload: { recoveryId: row?.id ?? null, onchainId: row?.onchainId ?? null, ...payload, txHash },
  });
}

// ─── mirrors refreshed from contract views ───────────────────────────────────

/**
 * Brings the signer mirror up to `config` (the contract's `get_config`): the account's threshold
 * and epoch, `merchant_users.is_signer` (see `setSignerFlags`), and the account's passkey rows in
 * `account_keys`, each on-chain key matched to that same person's credential (active first; R1:
 * never by public key across people). Also mirrors `recovery_key_epoch`.
 *
 * Records `account.signers.changed`:
 * - with `causes` (the proposal ids / tx hashes of the chain's `signers_changed`): once per cause,
 *   so A → B → A within one epoch still announces (and mirrors to test) each change;
 * - without (reconciliation): only when the signer set differs from the last one announced.
 */
export async function syncSigners(
  account: MerchantAccount,
  config: ConfigView,
  causes: string[] = [],
): Promise<boolean> {
  const ctx = ctxOf(account);
  return tenantTransaction(ctx, async (tx) => {
    await lockAccount(tx, account.id);
    const current = await tx.merchantAccount.findFirstOrThrow({ where: { id: account.id } });
    let changed = false;
    const epoch = BigInt(config.signer_epoch);
    if (
      epoch >= current.signerEpoch &&
      (epoch !== current.signerEpoch || config.threshold !== current.threshold) &&
      config.threshold >= 1
    ) {
      await tx.merchantAccount.update({
        where: { id: account.id },
        data: { signerEpoch: epoch, threshold: config.threshold },
      });
      changed = true;
    }
    const keyEpoch = u64Of(config.recovery_key_epoch);
    if (keyEpoch !== null && current.recoveryKeyEpoch !== keyEpoch) {
      await tx.merchantAccount.update({
        where: { id: account.id },
        data: { recoveryKeyEpoch: keyEpoch },
      });
    }
    const ids = config.signers.map((s) => s.id);
    if (await setSignerFlags(tx, account, ids)) changed = true;
    if (await syncSignerKeys(tx, account, config)) changed = true;

    const signers = [...config.signers]
      .map((s) => ({ id: s.id, keys: s.keys.map(keyIdOf).sort() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const contentKey = `${config.signer_epoch}:${config.threshold}:${hash(signers)}`;
    const payload = {
      nearAccountId: account.nearAccountId,
      signerIds: ids,
      threshold: config.threshold,
      signerEpoch: config.signer_epoch,
      recoveryKeySet: config.recovery_key_set,
      contentKey,
    };
    const scope = {
      aggregateType: 'merchant_account',
      aggregateId: account.id,
      type: T.signersChanged,
    };
    if (causes.length > 0) {
      for (const cause of new Set(causes)) {
        await recordOnce(tx, ctx, { ...scope, key: `cause:${cause}`, payload });
      }
    } else {
      const last = await tx.event.findFirst({
        where: { merchantId: ctx.merchantId, livemode: ctx.livemode, ...scope },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { payload: true },
      });
      if ((last?.payload as { contentKey?: unknown } | undefined)?.contentKey !== contentKey) {
        await recordEvent(tx, ctx, {
          ...scope,
          payload: { ...payload, dedupeKey: `content:${contentKey}` },
        });
      }
    }
    return changed;
  });
}

async function syncSignerKeys(tx: Tx, account: MerchantAccount, config: ConfigView) {
  const scope = {
    merchantId: account.merchantId,
    livemode: account.livemode,
    nearAccountId: account.nearAccountId,
    kind: 'passkey' as const,
  };
  const known = new Set(
    (
      await tx.user.findMany({
        where: { id: { in: config.signers.map((s) => s.id) } },
        select: { id: true },
      })
    ).map((u) => u.id),
  );
  const desired = new Map<
    string,
    { userId: string; publicKey: string; credentialId: string | null }
  >();
  for (const s of config.signers) {
    if (!known.has(s.id)) {
      log('warn', 'on-chain signer is not a known person', { accountId: account.id, signer: s.id });
      continue;
    }
    const creds = await tx.webauthnCredential.findMany({
      where: { userId: s.id },
      orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      select: { id: true, publicKey: true },
    });
    for (const k of s.keys) {
      const publicKey = keyIdOf(k);
      const cred = creds.find((c) => {
        const parsed = SignerKeySchema.safeParse(c.publicKey);
        return parsed.success && keyIdOf(parsed.data as SignerKey) === publicKey;
      });
      desired.set(`${s.id}|${publicKey}`, {
        userId: s.id,
        publicKey,
        credentialId: cred?.id ?? null,
      });
    }
  }
  const existing = await tx.accountKey.findMany({ where: { ...scope, revokedAt: null } });
  let changed = false;
  const now = new Date();
  for (const row of existing) {
    const want = desired.get(`${row.userId}|${row.publicKey}`);
    if (!want) {
      await tx.accountKey.update({ where: { id: row.id }, data: { revokedAt: now } });
      changed = true;
    } else {
      desired.delete(`${row.userId}|${row.publicKey}`);
      if (row.credentialId !== want.credentialId) {
        await tx.accountKey.update({
          where: { id: row.id },
          data: { credentialId: want.credentialId },
        });
      }
    }
  }
  for (const want of desired.values()) {
    await tx.accountKey.create({
      data: { id: newId('akey'), ...scope, ...want },
    });
    changed = true;
  }
  return changed;
}

/** The contract's `SavedAddressView` JSON. */
export interface SavedAddressView {
  id: string;
  chain: string;
  address: string;
  active_from: string;
}

async function revokeSavedAddress(tx: Tx, ctx: ScopeContext, id: string): Promise<boolean> {
  const { count } = await tx.payoutAllowlistEntry.updateMany({
    where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode, status: { not: 'revoked' } },
    data: { status: 'revoked' },
  });
  if (count === 0) return false;
  await recordEvent(tx, ctx, {
    aggregateType: 'payout_allowlist',
    aggregateId: id,
    type: T.savedAddressRemoved,
    payload: { id },
  });
  return true;
}

/**
 * `payout_allowlist` from `list_saved_addresses`: row id = on-chain saved-address id, usable from
 * the chain's `active_from` (`pending` until then), `revoked` once the chain no longer lists it.
 */
export async function syncSavedAddresses(
  account: MerchantAccount,
  list: SavedAddressView[],
): Promise<void> {
  const ctx = ctxOf(account);
  await tenantTransaction(ctx, async (tx) => {
    await lockAccount(tx, account.id);
    const now = new Date();
    const onChain = new Map(list.map((v) => [v.id, v]));
    const rows = await tx.payoutAllowlistEntry.findMany({
      where: { merchantId: ctx.merchantId, livemode: ctx.livemode },
    });
    // Removals first, so a re-added address never meets its own revoked predecessor.
    for (const r of rows) {
      if (r.status !== 'revoked' && !onChain.has(r.id)) await revokeSavedAddress(tx, ctx, r.id);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const v of list) {
      const activeFrom = nsToDate(v.active_from);
      if (!activeFrom) continue;
      const status = activeFrom > now ? ('pending' as const) : ('active' as const);
      const row = byId.get(v.id);
      if (!row) {
        // The on-chain id is the row's primary key. One already owned by another store or mode
        // (an id chosen outside our API, which mints `pal_<ULID>` ids) cannot be mirrored here:
        // record the conflict and skip the entry rather than fail the whole mirror (I3).
        const taken = await tx.payoutAllowlistEntry.findUnique({
          where: { id: v.id },
          select: { merchantId: true, livemode: true },
        });
        if (taken) {
          await recordOnce(tx, ctx, {
            aggregateType: 'merchant_account',
            aggregateId: account.id,
            type: T.mirrorConflict,
            key: `saved_address:${v.id}`,
            payload: { table: 'payout_allowlist', id: v.id, chain: v.chain, address: v.address },
          });
          log('warn', 'saved-address id already mirrored for another store or mode; skipped', {
            accountId: account.id,
            savedAddressId: v.id,
          });
          continue;
        }
        await tx.payoutAllowlistEntry.create({
          data: {
            id: v.id,
            merchantId: ctx.merchantId,
            livemode: ctx.livemode,
            chain: v.chain,
            address: v.address,
            status,
            activeFrom,
          },
        });
        await recordEvent(tx, ctx, {
          aggregateType: 'payout_allowlist',
          aggregateId: v.id,
          type: T.savedAddressAdded,
          payload: { id: v.id, chain: v.chain, address: v.address, activeFrom: iso(activeFrom) },
        });
      } else if (
        row.status !== status ||
        row.chain !== v.chain ||
        row.address !== v.address ||
        row.activeFrom.getTime() !== activeFrom.getTime()
      ) {
        await tx.payoutAllowlistEntry.update({
          where: { id: row.id },
          data: { status, chain: v.chain, address: v.address, activeFrom },
        });
      }
    }
  });
}

/** The contract's `Settlement` JSON (`get_settlement`, `settlement_changed`). */
export interface SettlementView {
  dest_asset: string;
  payout_mode: 'intents' | 'wallet';
  saved_address_id: string | null;
}

/**
 * The store's default `settlement_configs` row (project 3 reads it) from the contract's
 * settlement: `intents` settles to the account itself on NEAR; `wallet` to the saved address.
 * Records `account.settlement.changed` when the row changed.
 */
async function writeSettlement(
  tx: Tx,
  ctx: ScopeContext,
  account: Pick<MerchantAccount, 'id' | 'nearAccountId'>,
  s: SettlementView,
): Promise<void> {
  if (!s.dest_asset) return;
  let target: { destChain: string; payoutAddress: string | null; nearAccount: string | null };
  if (s.payout_mode === 'wallet') {
    const saved = s.saved_address_id
      ? await tx.payoutAllowlistEntry.findFirst({
          where: { id: s.saved_address_id, merchantId: ctx.merchantId, livemode: ctx.livemode },
        })
      : null;
    if (!saved) {
      log('warn', 'settlement names a saved address not mirrored yet', {
        accountId: account.id,
        savedAddressId: s.saved_address_id,
      });
      return;
    }
    target = { destChain: saved.chain, payoutAddress: saved.address, nearAccount: null };
  } else {
    target = { destChain: 'near', payoutAddress: null, nearAccount: account.nearAccountId };
  }
  const data = {
    destAssetId: s.dest_asset,
    payoutMode: s.payout_mode,
    ...target,
  };
  const current = await tx.settlementConfig.findFirst({
    where: { merchantId: ctx.merchantId, livemode: ctx.livemode, isDefault: true },
  });
  if (
    current &&
    current.destAssetId === data.destAssetId &&
    current.payoutMode === data.payoutMode &&
    current.destChain === data.destChain &&
    current.payoutAddress === data.payoutAddress &&
    current.nearAccount === data.nearAccount
  ) {
    return;
  }
  if (current) {
    await tx.settlementConfig.update({ where: { id: current.id }, data });
  } else {
    await tx.settlementConfig.create({
      data: {
        id: newId('stc'),
        merchantId: ctx.merchantId,
        livemode: ctx.livemode,
        isDefault: true,
        ...data,
      },
    });
  }
  await recordEvent(tx, ctx, {
    aggregateType: 'merchant_account',
    aggregateId: account.id,
    type: T.settlementChanged,
    payload: { ...data, savedAddressId: s.saved_address_id },
  });
}

/** The contract's `LimitsView` / `AutoSweepView` JSON (the fields mirrored). */
interface LimitsView {
  per_tx: string | null;
  per_day: string | null;
  refund_cap: string;
}
interface AutoSweepView {
  trigger_above: string;
  keep: string;
  saved_address_id: string;
  chain: string;
  address: string;
}

const dec = (v: string | null | undefined) => (v === null || v === undefined ? null : v);
const decOf = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(0));

/** `account_limits` for `asset` from `get_limits` and `get_auto_sweep`. */
export async function refreshLimits(account: MerchantAccount, asset: string): Promise<void> {
  const client = nearClient(account.livemode);
  const [limits, sweep] = await Promise.all([
    client.view<LimitsView>(account.nearAccountId, 'get_limits', { asset }),
    client.view<AutoSweepView | null>(account.nearAccountId, 'get_auto_sweep', { asset }),
  ]);
  const ctx = ctxOf(account);
  const data = {
    perTx: dec(limits.per_tx),
    perDay: dec(limits.per_day),
    refundCap: dec(limits.refund_cap),
    sweepTriggerAbove: dec(sweep?.trigger_above),
    sweepKeep: dec(sweep?.keep),
    sweepSavedAddressId: sweep?.saved_address_id ?? null,
    sweepChain: sweep?.chain ?? null,
    sweepAddress: sweep?.address ?? null,
  };
  await tenantTransaction(ctx, async (tx) => {
    await lockAccount(tx, account.id);
    const row = await tx.accountLimit.findFirst({
      where: { accountId: account.id, asset, merchantId: ctx.merchantId, livemode: ctx.livemode },
    });
    if (
      row &&
      decOf(row.perTx) === data.perTx &&
      decOf(row.perDay) === data.perDay &&
      decOf(row.refundCap) === data.refundCap &&
      decOf(row.sweepTriggerAbove) === data.sweepTriggerAbove &&
      decOf(row.sweepKeep) === data.sweepKeep &&
      row.sweepSavedAddressId === data.sweepSavedAddressId &&
      row.sweepChain === data.sweepChain &&
      row.sweepAddress === data.sweepAddress
    ) {
      return;
    }
    if (row) {
      await tx.accountLimit.update({ where: { id: row.id }, data });
    } else {
      await tx.accountLimit.create({
        data: {
          id: newId('alim'),
          merchantId: ctx.merchantId,
          livemode: ctx.livemode,
          accountId: account.id,
          asset,
          ...data,
        },
      });
    }
    await recordEvent(tx, ctx, {
      aggregateType: 'merchant_account',
      aggregateId: account.id,
      type: T.limitsChanged,
      payload: { asset, ...data },
    });
  });
}

// ─── reconciliation ──────────────────────────────────────────────────────────

/** The contract's `RecoveryView` JSON (`get_recovery`). */
export interface RecoveryView {
  recovery_id: string;
  nonce: string;
  recovery_key_epoch: string;
  new_signer_ids: string[];
  new_threshold: number;
  executes_at: string;
}

const ev = (event: AccountEvent['event'], data: Record<string, unknown>): AccountEvent => ({
  event,
  version: '1.0.0',
  data,
});

/** The events a proposal's view implies, as the contract would have emitted them. */
function eventsFromView(v: ContractProposalView): AccountEvent[] {
  const out: AccountEvent[] = [
    ev('proposal_created', {
      proposal_id: v.id,
      signer_id: v.creator ?? null,
      action: v.action ?? null,
      expires_at: v.expires_at ?? null,
      created_at: v.created_at ?? null,
    }),
    ...v.approvals.map((a) =>
      ev('proposal_approved', {
        proposal_id: v.id,
        signer_id: a.signer_id,
        signer_epoch: a.signer_epoch,
      }),
    ),
  ];
  if (v.status === 'pending' && v.ready_at) {
    out.push(ev('timelock_started', { proposal_id: v.id, action: v.action, ready_at: v.ready_at }));
  }
  if (v.status === 'executed')
    out.push(ev('proposal_executed', { proposal_id: v.id, action: v.action }));
  if (v.status === 'failed')
    out.push(ev('proposal_failed', { proposal_id: v.id, reason: 'failed' }));
  if (v.status === 'expired') {
    out.push(ev('proposal_failed', { proposal_id: v.id, reason: 'expired' }));
  }
  if (v.status === 'cancelled') {
    out.push(ev('proposal_cancelled', { proposal_id: v.id, signer_id: null }));
  }
  return out;
}

const OPEN_ON_CHAIN: ProposalStatus[] = ['pending', 'timelocked', 'executing'];

/**
 * Reconciles one account with its contract (one job per active account every 60 s, both modes;
 * each proposal is applied in its own short transaction):
 * - new proposals since the cursor (`list_proposals`), and every proposal the mirror still has open
 *   (`get_proposal`), applied as the events their views imply, then the views themselves;
 * - drafts whose relay claim went stale (R24): looked up by on-chain id — brought up to date when
 *   the chain has them, released otherwise;
 * - the pending recovery (`get_recovery`) against `recovery_requests`;
 * - signers and keys (`get_config`), saved addresses, settlement, and limits of known assets.
 * Returns false when the account is not active.
 */
export async function reconcileAccount(merchantId: string, livemode: boolean): Promise<boolean> {
  const account = await prisma.merchantAccount.findFirst({
    where: { merchantId, livemode, status: 'active' },
  });
  if (!account) return false;
  const ctx = ctxOf(account);
  const client = nearClient(livemode);
  const contract = account.nearAccountId;

  const [config, recovery] = await Promise.all([
    client.view<ConfigView>(contract, 'get_config', {}),
    client.view<RecoveryView | null>(contract, 'get_recovery', {}),
  ]);

  // Proposals: new ones since the cursor (in creation order), then every one still open here.
  const listed: ContractProposalView[] = [];
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const batch = await client.view<ContractProposalView[]>(contract, 'list_proposals', {
      from_index: account.proposalsSeen + listed.length,
      limit: LIST_PAGE,
    });
    listed.push(...batch);
    if (batch.length < LIST_PAGE) break;
  }
  const listedIds = new Set(listed.map((v) => v.id));
  const staleClaim = new Date(Date.now() - RELAY_CLAIM_LEASE_MS);
  const open = await prisma.accountProposal.findMany({
    where: {
      accountId: account.id,
      merchantId,
      livemode,
      OR: [
        { status: { in: OPEN_ON_CHAIN } },
        { status: 'draft', relayClaimedAt: { lt: staleClaim } },
      ],
    },
    select: { id: true, onchainId: true, status: true },
  });
  const byId: ContractProposalView[] = [];
  const unclaim: string[] = [];
  for (const row of open) {
    if (listedIds.has(row.onchainId)) continue;
    const v = await client.view<ContractProposalView | null>(contract, 'get_proposal', {
      id: row.onchainId,
    });
    if (v) byId.push(v);
    else if (row.status === 'draft') unclaim.push(row.id);
  }

  // One short transaction per proposal. The cursor advances only over listed proposals that
  // applied, up to the first failure, so a failing one is retried on the next run.
  const assets = new Set<string>();
  const failures: unknown[] = [];
  let applied = 0;
  for (const v of listed) {
    try {
      for (const a of (await reconcileProposal(account, v)).limitAssets) assets.add(a);
      if (failures.length === 0) applied += 1;
    } catch (err) {
      failures.push(err);
    }
  }
  for (const v of byId) {
    try {
      for (const a of (await reconcileProposal(account, v)).limitAssets) assets.add(a);
    } catch (err) {
      failures.push(err);
    }
  }
  await tenantTransaction(ctx, async (tx) => {
    if (unclaim.length > 0) {
      await tx.accountProposal.updateMany({
        where: {
          id: { in: unclaim },
          merchantId,
          livemode,
          status: 'draft',
          relayClaimedAt: { lt: staleClaim },
        },
        data: { relayClaimedAt: null },
      });
    }
    // Conditional on the cursor we read: a concurrent run cannot move it twice.
    await tx.merchantAccount.updateMany({
      where: { id: account.id, merchantId, livemode, proposalsSeen: account.proposalsSeen },
      data: { proposalsSeen: account.proposalsSeen + applied, reconciledAt: new Date() },
    });
  });

  // Recovery: a started one we never saw; pending rows the chain no longer has.
  const recoveryEvents: AccountEvent[] = [];
  const pending = await prisma.recoveryRequest.findMany({
    where: { accountId: account.id, merchantId, livemode, status: 'pending' },
  });
  if (recovery) {
    const known = await prisma.recoveryRequest.findFirst({
      where: { accountId: account.id, merchantId, livemode, onchainId: recovery.recovery_id },
      select: { id: true },
    });
    if (!known) recoveryEvents.push(ev('recovery_started', { ...recovery }));
  }
  const chainIds = new Set(config.signers.map((s) => s.id));
  for (const row of pending) {
    if (row.onchainId === recovery?.recovery_id) continue;
    const executed =
      row.executesAt <= new Date() &&
      row.newThreshold === config.threshold &&
      row.newSignerIds.length === chainIds.size &&
      row.newSignerIds.every((id) => chainIds.has(id));
    recoveryEvents.push(
      executed
        ? ev('recovery_executed', {
            recovery_id: row.onchainId,
            new_signer_ids: config.signers.map((s) => s.id),
            new_threshold: config.threshold,
            signer_epoch: config.signer_epoch,
          })
        : ev('recovery_cancelled', { recovery_id: row.onchainId, reason: 'not_pending_on_chain' }),
    );
  }
  if (recoveryEvents.length > 0) {
    await tenantTransaction(ctx, (tx, c) =>
      applyAccountEventsTx(tx, c, account, recoveryEvents, null),
    );
  }

  // Mirrors read straight from the contract's views.
  await syncSigners(account, config);
  await syncSavedAddresses(
    account,
    await client.view<SavedAddressView[]>(contract, 'list_saved_addresses', {}),
  );
  const settlement = await client.view<SettlementView | null>(contract, 'get_settlement', {});
  if (settlement) {
    await tenantTransaction(ctx, async (tx, c) => {
      await lockAccount(tx, account.id);
      await writeSettlement(tx, c, account, settlement);
    });
  }
  for (const r of await prisma.accountLimit.findMany({
    where: { accountId: account.id, merchantId, livemode },
    select: { asset: true },
  })) {
    assets.add(r.asset);
  }
  for (const p of await prisma.accountProposal.findMany({
    where: {
      accountId: account.id,
      merchantId,
      livemode,
      kind: { in: ['set_limits', 'set_refund_cap', 'set_auto_sweep', 'clear_auto_sweep'] },
      status: 'executed',
    },
    select: { action: true },
  })) {
    const parsed = ActionSchema.safeParse(p.action);
    if (!parsed.success) continue;
    const asset = str((Object.values(parsed.data)[0] as Record<string, unknown>).asset);
    if (asset) assets.add(asset);
  }
  for (const asset of assets) await refreshLimits(account, asset);

  if (failures.length > 0) {
    log('warn', 'some proposals failed to reconcile', {
      accountId: account.id,
      failed: failures.length,
      err: String(failures[0]),
    });
    throw failures[0];
  }
  return true;
}

/**
 * One proposal's view applied in its own transaction: the events the view implies, then the view
 * itself (status incl. `executing`), its approvals (each key matched to that person's credential),
 * and a stale relay claim cleared.
 */
async function reconcileProposal(
  account: MerchantAccount,
  v: ContractProposalView,
): Promise<ApplyOutcome> {
  return tenantTransaction(ctxOf(account), async (tx, c) => {
    const out = await applyAccountEventsTx(tx, c, account, eventsFromView(v), null);
    const row = await tx.accountProposal.findFirst({
      where: {
        accountId: account.id,
        onchainId: v.id,
        merchantId: c.merchantId,
        livemode: c.livemode,
      },
    });
    if (!row) return out;
    await applyProposalView(tx, c, row.id, v);
    if (row.relayClaimedAt) {
      await tx.accountProposal.update({ where: { id: row.id }, data: { relayClaimedAt: null } });
    }
    for (const a of v.approvals) {
      const credentialId = await credentialForKey(a.signer_id, a.key);
      const epoch = u64Of(a.signer_epoch);
      if (!credentialId || epoch === null) continue;
      await upsertApproval(tx, c, row.id, a.signer_id, {
        credentialId,
        signerEpoch: epoch,
        txHash: null,
      });
    }
    return out;
  });
}

// ─── permissionless executions (the relayer pays gas) ───────────────────────

/**
 * Calls `execute` on every timelocked proposal past `ready_at` (anyone may; the contract re-checks
 * approvals, epoch and the timelock) and applies the outcome. A refusal (e.g. the signer set
 * changed and the timelock restarted) re-reads the proposal from the chain instead.
 */
export async function executeReadyTimelocks(now = new Date()): Promise<number> {
  const due = await prisma.accountProposal.findMany({
    where: { status: 'timelocked', readyAt: { lte: now }, account: { status: 'active' } },
    include: { account: true },
    orderBy: { readyAt: 'asc' },
    take: EXECUTE_BATCH,
  });
  let executed = 0;
  for (const p of due) {
    const ctx = ctxOf(p);
    try {
      const result = await relay(p.livemode, p.account.nearAccountId, 'execute', {
        proposal_id: p.onchainId,
      });
      if (landed(result)) {
        await applyAccountEvents(ctx, p.accountId, parseAccountEvents(result.successLogs), {
          txHash: result.txHash,
        });
        executed += 1;
      } else {
        log('info', 'timelocked proposal not executable yet', {
          proposalId: p.id,
          failure: result.failure,
        });
        const v = await nearClient(p.livemode).view<ContractProposalView | null>(
          p.account.nearAccountId,
          'get_proposal',
          { id: p.onchainId },
        );
        if (v) {
          await tenantTransaction(ctx, async (tx, c) => {
            await applyAccountEventsTx(tx, c, p.account, eventsFromView(v), null);
            await applyProposalView(tx, c, p.id, v);
          });
        }
      }
    } catch (err) {
      log('warn', 'executing a timelocked proposal failed', { proposalId: p.id, err: String(err) });
    }
  }
  return executed;
}

/** Calls `execute_recovery` on every pending recovery past `executes_at` and applies it. */
export async function executeReadyRecovery(now = new Date()): Promise<number> {
  const due = await prisma.recoveryRequest.findMany({
    where: { status: 'pending', executesAt: { lte: now }, account: { status: 'active' } },
    include: { account: true },
    orderBy: { executesAt: 'asc' },
    take: EXECUTE_BATCH,
  });
  let executed = 0;
  for (const r of due) {
    try {
      const result = await relay(r.livemode, r.account.nearAccountId, 'execute_recovery', {});
      if (landed(result)) {
        await applyAccountEvents(ctxOf(r), r.accountId, parseAccountEvents(result.successLogs), {
          txHash: result.txHash,
        });
        executed += 1;
      } else {
        log('info', 'recovery not executable', { recoveryId: r.id, failure: result.failure });
      }
    } catch (err) {
      log('warn', 'executing a recovery failed', { recoveryId: r.id, err: String(err) });
    }
  }
  return executed;
}
