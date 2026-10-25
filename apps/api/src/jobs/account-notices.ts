// Signer notices for merchant-account changes, sent by outbox handlers in the worker, plus the
// worker's account jobs (reconciliation, permissionless executions, the delayed recovery notice).
//
// Every notice goes to every current signer of the store (emails from the team listing). Its
// content is built from the ON-CHAIN action the event carries — the `action` the contract logged
// (or returned in `get_proposal`) — never from the draft the website sent, so a tampered draft
// cannot make a notice describe a different destination than the one about to receive funds.
import type { Event } from '@prisma/client';
import { Queue } from 'bullmq';
import { mirrorTestSigners } from '../accounts/accounts.js';
import { ActionSchema, kindOf, type ActionJson, type ActionOf } from '../accounts/encoding.js';
import {
  AccountEventTypes as T,
  executeReadyRecovery,
  executeReadyTimelocks,
  reconcileAllAccounts,
  type SavedAddressView,
} from '../accounts/watcher.js';
import { getMailer, type MailTemplate } from '../auth/mailer.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { listMembers } from '../merchants/team.js';
import { nearClient } from '../near/client.js';
import { registerEventHandler } from './handlers.js';
import { createQueueConnection } from './queue.js';

/** The worker's merchant-account jobs. */
export const ACCOUNTS_QUEUE = 'tendr-accounts';
export const RECONCILE_JOB = 'reconcile-accounts';
export const EXECUTE_TIMELOCKS_JOB = 'execute-ready-timelocks';
export const EXECUTE_RECOVERY_JOB = 'execute-ready-recovery';
export const RECOVERY_SOON_JOB = 'recovery-executes-soon';
/** Every scheduled account job runs this often. */
export const ACCOUNT_JOB_EVERY_MS = 60_000;
/** `RECOVERY_NOTICE_BEFORE`: the reminder goes out this long before a recovery can execute. */
export const RECOVERY_NOTICE_BEFORE_MS = 24 * 3_600_000;

// ─── delayed jobs ────────────────────────────────────────────────────────────

/** Where delayed account jobs are added (the worker's accounts queue; tests swap in a recorder). */
export interface DelayedJobs {
  add(name: string, data: object, opts: { delay: number; jobId: string }): Promise<unknown>;
}

let delayed: DelayedJobs | null = null;

/** Replaces the delayed-job target (the worker passes its queue; tests a recorder); null resets. */
export function setDelayedJobs(target: DelayedJobs | null): void {
  delayed = target;
}

function delayedJobs(): DelayedJobs {
  delayed ??= new Queue(ACCOUNTS_QUEUE, { connection: createQueueConnection() });
  return delayed;
}

/**
 * Schedules the `recovery_executes_soon` notice at `executesAt − 24 h` (at once if that is past).
 * The job id is fixed per recovery, so a replayed event never schedules it twice.
 */
export async function scheduleRecoverySoon(
  recoveryId: string,
  executesAt: Date,
  now = Date.now(),
): Promise<void> {
  const delay = Math.max(0, executesAt.getTime() - RECOVERY_NOTICE_BEFORE_MS - now);
  await delayedJobs().add(
    RECOVERY_SOON_JOB,
    { recoveryId },
    { delay, jobId: `recovery-soon__${recoveryId}` },
  );
}

// ─── recipients and links ────────────────────────────────────────────────────

/** Emails of the store's current signers (the single team-listing helper). */
async function signerEmails(merchantId: string): Promise<string[]> {
  return (await listMembers(merchantId)).filter((m) => m.isSigner).map((m) => m.email);
}

async function mailSigners(
  merchantId: string,
  template: MailTemplate,
  data: Record<string, string>,
): Promise<number> {
  const to = await signerEmails(merchantId);
  const mailer = getMailer();
  for (const email of to) await mailer.send({ to: email, template, data });
  return to.length;
}

const approvalUrl = (proposalRowId: string) =>
  new URL(`/dashboard/approvals/${proposalRowId}`, env().WEB_URL).toString();
const recoveryUrl = () => new URL('/dashboard/recovery', env().WEB_URL).toString();

type Payload = Record<string, unknown>;
const payloadOf = (e: Event) => (e.payload ?? {}) as Payload;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

function scopeOf(e: Event): { merchantId: string; livemode: boolean } {
  if (!e.merchantId || e.livemode === null) throw new Error(`event ${e.id} has no merchant/mode`);
  return { merchantId: e.merchantId, livemode: e.livemode };
}

// ─── decoding the on-chain action ────────────────────────────────────────────

/** What an action does, for a notice: where the money goes and how much. */
export interface ActionSummary {
  kind: string;
  summary: string;
  destination: string;
  destinationChain: string;
  asset: string;
  amount: string;
}

async function savedAddressOnChain(
  livemode: boolean,
  contractId: string,
  merchantId: string,
  id: string,
): Promise<{ chain: string; address: string } | null> {
  try {
    const list = await nearClient(livemode).view<SavedAddressView[]>(
      contractId,
      'list_saved_addresses',
      {},
    );
    const hit = list.find((a) => a.id === id);
    if (hit) return { chain: hit.chain, address: hit.address };
  } catch (err) {
    log('warn', 'list_saved_addresses failed; using the mirror', { err: String(err) });
  }
  // The mirror of the same contract state (`payout_allowlist`, id = on-chain id).
  const row = await prisma.payoutAllowlistEntry.findFirst({ where: { id, merchantId, livemode } });
  return row ? { chain: row.chain, address: row.address } : null;
}

/**
 * Decodes an on-chain action into the facts a notice states. For a withdrawal over a Swap route
 * the funds leave to the swap's `deposit_account`, so that is the destination named; over PoA they
 * go to the saved address (resolved from the contract). A refund names its own destination and
 * chain (plus the swap deposit account when routed through one).
 */
export async function summarizeAction(
  action: ActionJson,
  account: { livemode: boolean; nearAccountId: string; merchantId: string },
): Promise<ActionSummary> {
  const kind = kindOf(action);
  const base = { kind, summary: kind.replace(/_/g, ' '), destination: '', destinationChain: '' };
  if (kind === 'withdraw') {
    const w = (action as { withdraw: ActionOf<'withdraw'> }).withdraw;
    const saved = await savedAddressOnChain(
      account.livemode,
      account.nearAccountId,
      account.merchantId,
      w.saved_address_id,
    );
    const savedText = saved
      ? `${saved.chain}:${saved.address}`
      : `saved address ${w.saved_address_id}`;
    if ('swap' in w.route) {
      return {
        ...base,
        summary: `Withdraw ${w.amount} ${w.asset} through a swap deposit account ${w.route.swap.deposit_account} (for ${savedText})`,
        destination: w.route.swap.deposit_account,
        destinationChain: 'near',
        asset: w.asset,
        amount: w.amount,
      };
    }
    return {
      ...base,
      summary: `Withdraw ${w.amount} ${w.asset} to ${savedText}`,
      destination: saved?.address ?? w.saved_address_id,
      destinationChain: saved?.chain ?? '',
      asset: w.asset,
      amount: w.amount,
    };
  }
  if (kind === 'refund') {
    const r = (action as { refund: ActionOf<'refund'> }).refund;
    const via =
      'swap' in r.route ? ` through swap deposit account ${r.route.swap.deposit_account}` : '';
    return {
      ...base,
      summary: `Refund ${r.amount} ${r.asset} for ${r.payment_id} to ${r.destination_chain}:${r.destination}${via}`,
      destination: r.destination,
      destinationChain: r.destination_chain,
      asset: r.asset,
      amount: r.amount,
    };
  }
  const v = Object.values(action)[0] as Record<string, unknown> | undefined;
  const asset = v && typeof v === 'object' && typeof v.asset === 'string' ? v.asset : '';
  return { ...base, asset, amount: '' };
}

async function accountOf(scope: { merchantId: string; livemode: boolean }) {
  return prisma.merchantAccount.findFirst({ where: scope });
}

// ─── handlers ────────────────────────────────────────────────────────────────

/** `account.proposal.created` → `proposal_needs_approval`, while the proposal still needs it. */
export async function onProposalCreated(event: Event): Promise<void> {
  const scope = scopeOf(event);
  const p = payloadOf(event);
  const row = await prisma.accountProposal.findFirst({
    where: { id: s(p.proposalId), ...scope },
    select: { status: true },
  });
  if (!row || (row.status !== 'pending' && row.status !== 'timelocked')) return;
  const account = await accountOf(scope);
  const action = ActionSchema.safeParse(p.action);
  if (!account || !action.success) {
    log('warn', 'proposal notice without a decodable on-chain action', { eventId: event.id });
    return;
  }
  const sum = await summarizeAction(action.data, account);
  await mailSigners(scope.merchantId, 'proposal_needs_approval', {
    proposalId: s(p.proposalId),
    kind: sum.kind,
    summary: sum.summary,
    destination: sum.destination,
    destinationChain: sum.destinationChain,
    asset: sum.asset,
    amount: sum.amount,
    livemode: String(scope.livemode),
    url: approvalUrl(s(p.proposalId)),
  });
}

/** `account.proposal.timelocked` → `timelock_started`, with a cancel link. */
export async function onTimelockStarted(event: Event): Promise<void> {
  const scope = scopeOf(event);
  const p = payloadOf(event);
  const account = await accountOf(scope);
  const action = ActionSchema.safeParse(p.action);
  if (!account || !action.success) {
    log('warn', 'timelock notice without a decodable on-chain action', { eventId: event.id });
    return;
  }
  const sum = await summarizeAction(action.data, account);
  await mailSigners(scope.merchantId, 'timelock_started', {
    proposalId: s(p.proposalId),
    kind: sum.kind,
    summary: sum.summary,
    destination: sum.destination,
    destinationChain: sum.destinationChain,
    asset: sum.asset,
    amount: sum.amount,
    readyAt: s(p.readyAt),
    livemode: String(scope.livemode),
    cancelUrl: approvalUrl(s(p.proposalId)),
  });
}

/** `account.proposal.executed` → `proposal_executed`. */
export async function onProposalExecuted(event: Event): Promise<void> {
  const scope = scopeOf(event);
  const p = payloadOf(event);
  const account = await accountOf(scope);
  const action = ActionSchema.safeParse(p.action);
  if (!account || !action.success) return;
  const sum = await summarizeAction(action.data, account);
  await mailSigners(scope.merchantId, 'proposal_executed', {
    proposalId: s(p.proposalId),
    kind: sum.kind,
    summary: sum.summary,
    destination: sum.destination,
    destinationChain: sum.destinationChain,
    asset: sum.asset,
    amount: sum.amount,
    livemode: String(scope.livemode),
    url: approvalUrl(s(p.proposalId)),
  });
}

/**
 * `account.recovery.started` → `recovery_started` to every signer, and the reminder scheduled at
 * `executes_at − 24 h`.
 */
export async function onRecoveryStarted(event: Event): Promise<void> {
  const scope = scopeOf(event);
  const p = payloadOf(event);
  const executesAt = new Date(s(p.executesAt));
  if (Number.isNaN(executesAt.getTime())) throw new Error(`event ${event.id} has no executesAt`);
  // Scheduled first: a retry after a failed send must not skip the reminder.
  await scheduleRecoverySoon(s(p.recoveryId), executesAt);
  await mailSigners(scope.merchantId, 'recovery_started', {
    recoveryId: s(p.recoveryId),
    executesAt: executesAt.toISOString(),
    newSignerIds: Array.isArray(p.newSignerIds) ? p.newSignerIds.join(',') : '',
    livemode: String(scope.livemode),
    cancelUrl: recoveryUrl(),
  });
}

/** The delayed reminder: sent only while the recovery is still pending. */
export async function sendRecoveryExecutesSoon(recoveryId: string): Promise<boolean> {
  const r = await prisma.recoveryRequest.findUnique({ where: { id: recoveryId } });
  if (!r || r.status !== 'pending') return false;
  await mailSigners(r.merchantId, 'recovery_executes_soon', {
    recoveryId: r.id,
    executesAt: r.executesAt.toISOString(),
    livemode: String(r.livemode),
    cancelUrl: recoveryUrl(),
  });
  return true;
}

/**
 * `account.signers.changed` on the LIVE account → mirror the signer set onto the test contract.
 * Never for test-mode changes. Retried by BullMQ when the sync fails.
 */
export async function onSignersChanged(event: Event): Promise<void> {
  if (event.livemode !== true || !event.merchantId) return;
  await mirrorTestSigners(event.merchantId);
}

/** Registers the account notice handlers (called once, from register-handlers). */
export function registerAccountHandlers(): void {
  registerEventHandler(T.proposalCreated, 'notify-proposal-created', onProposalCreated);
  registerEventHandler(T.proposalTimelocked, 'notify-timelock-started', onTimelockStarted);
  registerEventHandler(T.proposalExecuted, 'notify-proposal-executed', onProposalExecuted);
  registerEventHandler(T.recoveryStarted, 'notify-recovery-started', onRecoveryStarted);
  registerEventHandler(T.signersChanged, 'mirror-test-signers', onSignersChanged, {
    attempts: 20,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}

/** Runs one job of the accounts queue by name. */
export async function processAccountJob(name: string, data: unknown): Promise<void> {
  switch (name) {
    case RECONCILE_JOB: {
      const r = await reconcileAllAccounts();
      if (r.failed > 0) log('warn', 'some accounts failed to reconcile', r);
      return;
    }
    case EXECUTE_TIMELOCKS_JOB:
      await executeReadyTimelocks();
      return;
    case EXECUTE_RECOVERY_JOB:
      await executeReadyRecovery();
      return;
    case RECOVERY_SOON_JOB: {
      const id = (data as { recoveryId?: unknown } | null)?.recoveryId;
      if (typeof id !== 'string') throw new Error('recovery-executes-soon job without recoveryId');
      await sendRecoveryExecutesSoon(id);
      return;
    }
    default:
      throw new Error(`unknown accounts job ${name}`);
  }
}
