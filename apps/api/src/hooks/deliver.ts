// Integrator hook delivery (project 5a, Task 11, spec §4.2–4.3, ruling T11-c).
//
// One `hook_calls` row per settled payment of a HOOK session (hooks.ts creates it on
// `payment.succeeded`). Each attempt calls the contract once:
//   EVM   `onTendrDeposit` through `relayer-evm` (EvmSender: nonce lock, dry run, recorded before
//         sent, replacement, unknown outcome). The receipt arrives later: `pollEvmRelays` hands
//         each final outcome to `applyEvmHookOutcome`.
//   NEAR  `on_tendr_deposit` through `relayer-near` (RelayerNearSender.signHook): the hash is
//         recorded (`submitted`) before the broadcast; an unknown outcome is settled by
//         `pollNearHooks` from the transaction status.
//   Test  simulated: succeeds at once, no RPC, no gas (`setHookTransport` lets tests decide).
//
// Statuses: `pending` (an attempt is due at `next_retry_at`; `lease_until` while one runs),
// `submitted` (a transaction is out, its outcome awaited), `confirmed` (succeeded, shown as
// `succeeded`) and `failed` (gave up). At most one attempt is in flight: a claim moves the row's
// `attempt` and `lease_until` in one conditional update, and a `submitted` row is never sent again.
//
// Retries: the webhook schedule (60 s × 2^(n-1), `retryDelayMs`) until `retry_until` (3 days
// after creation; the last retry lands on it). A revert (dry run or mined) is retried: the contract
// may be paused; the reason is kept in `last_error`. At or past `retry_until` a failure is final:
// `failed`, and the first time also `hook.failed` (webhook-deliverable; one alert email,
// hooks.ts). A resend (hooks.ts) sets `retry_until` to the resend time: a one-off attempt.
//
// Gas (ruling T11-a): the quoted hook estimate (`quotes.hook_fee_usd`) was already taken from the
// payment's proceeds and never touches the sponsorship budget. The actual cost of every attempt
// is added to `cost_usd`; whatever exceeds the estimate is Tendr's loss (`recognizeTendrLoss` on a
// `method = hook` sponsorship row), never charged to the merchant.
import { Prisma, type HookCall } from '@prisma/client';
import type { Queue } from 'bullmq';
import { createHash, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { retryDelayMs } from '../checkout/webhooks.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import { nativeUsd } from '../gas/fees.js';
import { alertLossCapReached, lossCapReached, recognizeTendrLoss } from '../gas/loss-cap.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { RelayerNearSender, TxResult, TxStatusResult } from '../near/client.js';
import { relayerNearSender } from '../near/client.js';
import { NotBroadcastError } from '../near/rpc.js';
import { liveEvmSender } from '../relayer/evm/index.js';
import {
  EvmNotBroadcastError,
  type EvmOutcome,
  type EvmSendInput,
  type EvmSendResult,
} from '../relayer/evm/sender.js';
import {
  HookRefused,
  INTEGRATOR_HOOK_PURPOSE,
  expectedHookCall,
  type ExpectedHookCall,
  type HookArgs,
} from './guard.js';

export const DELIVER_HOOK_JOB = 'deliver-hook';
export const SWEEP_HOOKS_JOB = 'sweep-hooks';
/** The first retry's delay (then doubling: the webhook schedule). */
export const HOOK_RETRY_BASE_MS = 60_000;
/** An attempt's claim (EvmSender.send or a NEAR send-and-wait fits well inside it). */
export const HOOK_LEASE_MS = 60_000;
/** An EVM hook transaction still unmined after this is cancelled (nonce freed) and retried. */
export const EVM_HOOK_GIVE_UP_MS = 10 * 60_000;
/** A NEAR hook transaction the node still does not know after this was dropped: retried. */
export const NEAR_HOOK_UNKNOWN_MS = 10 * 60_000;
/** A `submitted` NEAR row younger than this is left to the attempt that sent it. */
const NEAR_POLL_MIN_AGE_MS = 30_000;
const MAX_ERROR_LEN = 500;

// ─── transports ─────────────────────────────────────────────────────────────

/** What one attempt did. */
export type HookSendResult =
  /** The call executed and succeeded. `costUsd`: its actual gas cost, when priced. */
  | { outcome: 'succeeded'; txHash: string; costUsd: string | null }
  /** It did not succeed: reverted (on chain or in the dry run) or was never sent. */
  | { outcome: 'failed'; txHash: string | null; costUsd: string | null; error: string }
  /** A transaction is out; its outcome arrives later (EVM receipt, NEAR status). */
  | { outcome: 'submitted'; txHash: string };

export type HookTransport = (call: ExpectedHookCall) => Promise<HookSendResult>;

/** The EVM sender surface hooks use (EvmSender in production). */
export interface HookEvmSender {
  send(input: EvmSendInput): Promise<EvmSendResult>;
}
/** The NEAR sender surface hooks use (RelayerNearSender in production). */
export interface HookNearSender {
  accountId(): Promise<string>;
  signHook: RelayerNearSender['signHook'];
  send(signed: { hash: string }): Promise<TxResult>;
  rpc: { txStatus(hash: string, accountId: string): Promise<TxStatusResult | null> };
}

interface DeliveryDeps {
  evmSender: () => HookEvmSender;
  nearSender: (livemode: boolean) => HookNearSender;
}
const DEFAULT_DEPS: DeliveryDeps = {
  evmSender: liveEvmSender,
  nearSender: (livemode) => relayerNearSender(livemode) as unknown as HookNearSender,
};
let deps: DeliveryDeps = DEFAULT_DEPS;

/** Tests: fake senders for the live paths (`null` restores the real ones). */
export function setHookDeliveryDeps(
  over: { evmSender?: HookEvmSender; nearSender?: (livemode: boolean) => HookNearSender } | null,
): void {
  deps = over
    ? {
        evmSender: over.evmSender ? () => over.evmSender! : DEFAULT_DEPS.evmSender,
        nearSender: over.nearSender ?? DEFAULT_DEPS.nearSender,
      }
    : DEFAULT_DEPS;
}

let override: HookTransport | null = null;

/** Tests: decide every attempt's outcome (any mode). `null` restores the real transports. */
export function setHookTransport(fn: HookTransport | null): void {
  override = fn;
}

/** Test mode: the call "succeeds" at once with a made-up hash; nothing touches a chain. */
const simulated: HookTransport = async (call) => {
  const digest = createHash('sha256')
    .update(`${call.hookCallId}:${randomBytes(8).toString('hex')}`)
    .digest();
  return {
    outcome: 'succeeded',
    txHash: call.family === 'evm' ? `0x${digest.toString('hex')}` : bs58.encode(digest),
    costUsd: null,
  };
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** USD of `units` of the chain's native coin; null when it cannot be priced (logged). */
async function priced(chain: string, units: bigint | null | undefined): Promise<string | null> {
  if (units === null || units === undefined) return null;
  try {
    return await nativeUsd(chain, units, true);
  } catch (err) {
    log('warn', 'hook: gas cost unpriced', { chain, err: String(err) });
    return null;
  }
}

/** Live EVM: `onTendrDeposit` via relayer-evm; the outcome comes back through `pollEvmRelays`. */
const liveEvm: HookTransport = async (call) => {
  // A transaction already out for this call (an attempt that crashed before writing `submitted`)
  // is never doubled: wait for its outcome instead.
  const out = await prisma.relayerTransaction.findFirst({
    where: { purpose: INTEGRATOR_HOOK_PURPOSE, refId: call.hookCallId, outcomeHandledAt: null },
    orderBy: { createdAt: 'desc' },
    select: { txHash: true },
  });
  if (out) return { outcome: 'submitted', txHash: out.txHash };
  try {
    const res = await deps.evmSender().send({
      chain: call.chain,
      to: call.to,
      data: call.data!,
      giveUpAt: new Date(Date.now() + EVM_HOOK_GIVE_UP_MS),
      purpose: INTEGRATOR_HOOK_PURPOSE,
      refId: call.hookCallId,
    });
    return { outcome: 'submitted', txHash: res.txHash };
  } catch (err) {
    if (err instanceof EvmNotBroadcastError) {
      return { outcome: 'failed', txHash: null, costUsd: null, error: err.message };
    }
    throw err;
  }
};

/** A NEAR execution result as a hook outcome (success only when no receipt failed). */
async function nearOutcome(r: TxResult): Promise<HookSendResult> {
  const costUsd = await priced('near', r.tokensBurnt);
  return r.status === 'success'
    ? { outcome: 'succeeded', txHash: r.txHash, costUsd }
    : { outcome: 'failed', txHash: r.txHash, costUsd, error: r.failure ?? 'the call failed' };
}

/** Live NEAR: `on_tendr_deposit` via relayer-near; the hash is recorded before the broadcast. */
function liveNear(onSigned: (hash: string) => Promise<boolean>): HookTransport {
  return async (call) => {
    const sender = deps.nearSender(call.livemode);
    let signed: { hash: string };
    try {
      signed = await sender.signHook(call.hookCallId, call.to, call.args);
    } catch (err) {
      return { outcome: 'failed', txHash: null, costUsd: null, error: errorText(err) };
    }
    if (!(await onSigned(signed.hash))) {
      // The claim was lost meanwhile: never broadcast.
      throw new Error('hook claim lost before the broadcast');
    }
    try {
      return await nearOutcome(await sender.send(signed));
    } catch (err) {
      if (err instanceof NotBroadcastError) {
        return { outcome: 'failed', txHash: null, costUsd: null, error: errorText(err) };
      }
      // Unknown outcome: the transaction may still execute (same hash, at most once).
      log('warn', 'hook: NEAR outcome unknown', { hookCallId: call.hookCallId, err: String(err) });
      return { outcome: 'submitted', txHash: signed.hash };
    }
  };
}

// ─── scheduling ─────────────────────────────────────────────────────────────

let queue: Pick<Queue, 'add'> | null = null;

/** The worker's queue for hook attempts; without one (tests) attempts run inline. */
export function setHookQueue(q: Pick<Queue, 'add'> | null): void {
  queue = q;
}

export interface DeliverHookJobData {
  hookCallId: string;
}

/** Queues an attempt for `at`; without a queue, runs it now when due. */
export async function enqueueHook(hookCallId: string, at: Date, now = new Date()): Promise<void> {
  if (!queue) {
    if (at.getTime() <= now.getTime()) await attemptHook(hookCallId, { now });
    return;
  }
  await queue.add(DELIVER_HOOK_JOB, { hookCallId } satisfies DeliverHookJobData, {
    jobId: `hook__${hookCallId}__${at.getTime()}`,
    delay: Math.max(0, at.getTime() - now.getTime()),
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { age: 86_400 },
  });
}

/**
 * Queues every `pending` call whose attempt is due and whose lease (if any) has lapsed. Returns
 * how many. Runs every minute in the worker.
 */
export async function sweepDueHooks(now = new Date(), limit = 500): Promise<number> {
  const due = await prisma.hookCall.findMany({
    where: {
      status: 'pending',
      nextRetryAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  for (const d of due) await enqueueHook(d.id, now, now);
  return due.length;
}

// ─── attempts ───────────────────────────────────────────────────────────────

export interface AttemptOptions {
  now?: Date;
  /** A resend: goes now even before `next_retry_at` (never while one is in flight). */
  manual?: boolean;
}

/** Whether an attempt of `h` is in flight at `now`. */
export function hookInFlight(
  h: Pick<HookCall, 'status' | 'leaseUntil'>,
  now: Date = new Date(),
): boolean {
  return (
    h.status === 'submitted' ||
    (h.status === 'pending' && h.leaseUntil !== null && h.leaseUntil > now)
  );
}

/**
 * Claims the call, makes one attempt and records its outcome. Returns the row after the attempt,
 * or null when nothing was attempted (unknown, not pending, not due, or in flight).
 */
export async function attemptHook(
  hookCallId: string,
  opts: AttemptOptions = {},
): Promise<HookCall | null> {
  const now = opts.now ?? new Date();
  const before = await prisma.hookCall.findUnique({ where: { id: hookCallId } });
  if (!before || before.status !== 'pending' || hookInFlight(before, now)) return null;
  if (!opts.manual && before.nextRetryAt !== null && before.nextRetryAt > now) return null;
  const leaseUntil = new Date(now.getTime() + HOOK_LEASE_MS);
  const claimed = await prisma.hookCall.updateMany({
    where: {
      id: hookCallId,
      status: 'pending',
      attempt: before.attempt,
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    data: { attempt: { increment: 1 }, leaseUntil },
  });
  if (claimed.count !== 1) return null;
  const attempt = before.attempt + 1;

  let result: HookSendResult;
  try {
    const call = await expectedHookCall(hookCallId);
    const transport: HookTransport =
      override ??
      (!call.livemode
        ? simulated
        : call.family === 'evm'
          ? liveEvm
          : liveNear((hash) => markSubmitted(hookCallId, attempt, hash)));
    result = await transport(call);
  } catch (err) {
    if (!(err instanceof HookRefused)) {
      log('warn', 'hook attempt failed', { hookCallId, attempt, err: String(err) });
    }
    result = { outcome: 'failed', txHash: null, costUsd: null, error: errorText(err) };
  }
  await recordOutcome(hookCallId, { attempt, statuses: ['pending', 'submitted'] }, result, now);
  return prisma.hookCall.findUnique({ where: { id: hookCallId } });
}

/** NEAR: the signed hash is on the row (`submitted`) before the broadcast. False: claim lost. */
async function markSubmitted(id: string, attempt: number, txHash: string): Promise<boolean> {
  const { count } = await prisma.hookCall.updateMany({
    where: { id, attempt, status: 'pending' },
    data: { status: 'submitted', txHash, nextRetryAt: null, leaseUntil: null },
  });
  return count === 1;
}

interface Claim {
  /** The attempt the outcome belongs to (null: whatever attempt is `submitted`). */
  attempt: number | null;
  statuses: ('pending' | 'submitted')[];
}

const clip = (s: string) => s.slice(0, MAX_ERROR_LEN);

/**
 * Writes an attempt's outcome while the claim still holds (same attempt, expected status), with
 * its events, in one transaction: success → `confirmed` + `hook.succeeded`; failure → the next
 * retry, or `failed` (+ `hook.failed` the first time) at or past `retry_until`; submitted → wait.
 * Gas above the estimate becomes Tendr's loss.
 */
async function recordOutcome(
  hookCallId: string,
  claim: Claim,
  result: HookSendResult,
  now: Date,
): Promise<void> {
  const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hookCallId } });
  const ctx = { merchantId: row.merchantId, livemode: row.livemode };
  const where: Prisma.HookCallWhereInput = {
    id: hookCallId,
    status: { in: claim.statuses },
    ...(claim.attempt !== null ? { attempt: claim.attempt } : {}),
  };
  const cost =
    result.outcome !== 'submitted' && result.costUsd !== null
      ? (row.costUsd ?? new Prisma.Decimal(0)).plus(result.costUsd)
      : row.costUsd;
  let lossRecognized = false;
  await tenantTransaction(ctx, async (tx) => {
    let data: Prisma.HookCallUpdateManyMutationInput;
    let event: { type: 'hook.succeeded' | 'hook.failed'; extra: object } | null = null;
    if (result.outcome === 'submitted') {
      data = { status: 'submitted', txHash: result.txHash, nextRetryAt: null, leaseUntil: null };
    } else if (result.outcome === 'succeeded') {
      data = {
        status: 'confirmed',
        txHash: result.txHash,
        succeededAt: now,
        nextRetryAt: null,
        leaseUntil: null,
        lastError: null,
        costUsd: cost,
      };
      event = { type: 'hook.succeeded', extra: { tx_hash: result.txHash } };
    } else {
      const deadline = row.retryUntil.getTime();
      const final = now.getTime() >= deadline;
      const error = clip(result.error);
      data = {
        status: final ? 'failed' : 'pending',
        nextRetryAt: final
          ? null
          : new Date(Math.min(now.getTime() + retryDelayMs(row.attempt), deadline)),
        leaseUntil: null,
        lastError: error,
        costUsd: cost,
        ...(result.txHash ? { txHash: result.txHash } : {}),
        ...(final && row.alertedAt === null ? { alertedAt: now } : {}),
      };
      if (final && row.alertedAt === null) {
        event = { type: 'hook.failed', extra: { error, tx_hash: result.txHash ?? row.txHash } };
      }
    }
    const { count } = await tx.hookCall.updateMany({ where, data });
    if (count !== 1) {
      log('info', 'hook outcome not written: the claim moved on', { hookCallId });
      return;
    }
    if (event) {
      const session = await tx.session.findFirstOrThrow({
        where: { id: row.sessionId, ...ctx },
        select: { externalRef: true },
      });
      await recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: row.paymentId,
        type: event.type,
        payload: {
          payment_id: row.paymentId,
          session_id: row.sessionId,
          external_ref: session.externalRef,
          hook_call_id: row.id,
          chain: row.chain,
          contract: row.targetContract,
          attempts: row.attempt,
          ...event.extra,
        },
      });
    }
    if (result.outcome !== 'submitted' && result.costUsd !== null && cost) {
      lossRecognized = await recognizeShortfall(tx, row, cost, result.txHash, now);
    }
  });
  if (lossRecognized && (await lossCapReached(row.livemode, now))) {
    await alertLossCapReached(row.livemode, now);
  }
}

/**
 * Ruling T11-a: the hook's actual gas (all attempts) above the quoted estimate is Tendr's loss.
 * Each new excess becomes a `method = hook` sponsorship row recognised with `recognizeTendrLoss`
 * (`cost_usd` = that excess), never charged to the merchant and never against the budget.
 */
async function recognizeShortfall(
  tx: Prisma.TransactionClient,
  row: HookCall,
  totalCost: Prisma.Decimal,
  txHash: string | null,
  now: Date,
): Promise<boolean> {
  const ctx = { merchantId: row.merchantId, livemode: row.livemode };
  const payment = await tx.payment.findFirstOrThrow({
    where: { id: row.paymentId, ...ctx },
    select: { quoteId: true, quote: { select: { hookFeeUsd: true } } },
  });
  const estimate = payment.quote.hookFeeUsd ?? new Prisma.Decimal(0);
  const booked = await tx.gasSponsorship.aggregate({
    where: { ...ctx, method: 'hook', quoteId: payment.quoteId },
    _sum: { costUsd: true },
  });
  const excess = totalCost
    .minus(estimate)
    .minus(booked._sum.costUsd ?? 0)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_UP);
  if (excess.lte(0)) return false;
  const id = newId('gas');
  await tx.gasSponsorship.create({
    data: {
      id,
      ...ctx,
      sessionId: row.sessionId,
      quoteId: payment.quoteId,
      chain: row.chain,
      txHash,
      method: 'hook',
      provider: row.chain === 'near' ? 'relayer-near' : 'relayer-evm',
      sponsor: 'merchant',
      status: 'confirmed',
      estimateUsd: estimate,
    },
  });
  return recognizeTendrLoss(tx, id, excess.toFixed(), now);
}

// ─── outcomes that arrive later ─────────────────────────────────────────────

/** An EVM hook transaction's final outcome (from `pollEvmRelays`). */
export async function applyEvmHookOutcome(o: EvmOutcome, now = new Date()): Promise<void> {
  const cost =
    o.gasUsed !== null && o.effectiveGasPrice !== null
      ? await priced(o.chain, o.gasUsed * o.effectiveGasPrice)
      : null;
  const result: HookSendResult =
    o.status === 'confirmed' && o.txHash
      ? { outcome: 'succeeded', txHash: o.txHash, costUsd: cost }
      : {
          outcome: 'failed',
          txHash: o.txHash,
          costUsd: cost,
          error: o.reason ?? 'the transaction failed',
        };
  await recordOutcome(o.refId, { attempt: null, statuses: ['submitted'] }, result, now);
}

/**
 * Live NEAR hook calls whose outcome is unknown (`submitted`): the transaction status settles
 * them; one the node still does not know NEAR_HOOK_UNKNOWN_MS after it was signed was dropped,
 * and counts as a failed attempt (retried). Returns how many outcomes were applied.
 */
export async function pollNearHooks(
  opts: { now?: () => Date; livemode?: boolean } = {},
): Promise<number> {
  const livemode = opts.livemode ?? true;
  const now = opts.now?.() ?? new Date();
  const rows = await prisma.hookCall.findMany({
    where: {
      livemode,
      chain: 'near',
      status: 'submitted',
      txHash: { not: null },
      updatedAt: { lte: new Date(now.getTime() - NEAR_POLL_MIN_AGE_MS) },
    },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  if (rows.length === 0) return 0;
  const sender = deps.nearSender(livemode);
  const relayer = await sender.accountId();
  let applied = 0;
  for (const row of rows) {
    try {
      const status = await sender.rpc.txStatus(row.txHash!, relayer);
      let result: HookSendResult | null = null;
      if (status) {
        const ok = status.topLevelOk !== false && status.receipts.every((r) => r.ok);
        const costUsd = await priced('near', status.tokensBurnt);
        result = ok
          ? { outcome: 'succeeded', txHash: status.hash, costUsd }
          : { outcome: 'failed', txHash: status.hash, costUsd, error: 'the call failed' };
      } else if (now.getTime() - row.updatedAt.getTime() >= NEAR_HOOK_UNKNOWN_MS) {
        result = {
          outcome: 'failed',
          txHash: null,
          costUsd: null,
          error: 'outcome unknown: the transaction was never seen on chain',
        };
      }
      if (!result) continue;
      await recordOutcome(row.id, { attempt: row.attempt, statuses: ['submitted'] }, result, now);
      applied++;
    } catch (err) {
      log('warn', 'hook: NEAR status lookup failed', { hookCallId: row.id, err: String(err) });
    }
  }
  return applied;
}

export type { HookArgs };
