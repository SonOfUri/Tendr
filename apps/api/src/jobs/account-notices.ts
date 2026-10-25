// Signer notices for merchant-account changes, sent by outbox handlers in the worker, plus the
// worker's account jobs (per-account reconciliation, permissionless executions, the delayed
// recovery notice).
//
// Every notice goes to every current signer of the store (emails from the team listing); an
// executed change also reaches the signers it removed. Its content is built from the ON-CHAIN
// action the event carries — the `action` the contract logged (or returned in `get_proposal`) —
// never from the draft the website sent, so a tampered draft cannot make a notice describe a
// different change than the one the chain is making. Every action variant is decoded into its
// fields (destinations, keys as fingerprints, amounts, thresholds, rules).
import { createHash } from 'node:crypto';
import type { Event } from '@prisma/client';
import bs58 from 'bs58';
import { Queue } from 'bullmq';
import { mirrorTestSigners } from '../accounts/accounts.js';
import { ActionSchema, kindOf, type ActionJson, type ActionOf } from '../accounts/encoding.js';
import {
  AccountEventTypes as T,
  executeReadyRecovery,
  executeReadyTimelocks,
  settleExpiredProposals,
  reconcileAccount,
  type SavedAddressView,
} from '../accounts/watcher.js';
import { getMailer, type MailTemplate } from '../auth/mailer.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { listMembers } from '../merchants/team.js';
import { nearClient, type SignerKeyJson } from '../near/client.js';
import { registerEventHandler } from './handlers.js';
import { createQueueConnection } from './queue.js';

/** Reconciliation and reminders (one job per account per tick; concurrency in the worker). */
export const ACCOUNTS_QUEUE = 'tendr-accounts';
/** Permissionless executions, on their own queue and concurrency. */
export const EXECUTORS_QUEUE = 'tendr-account-executors';
/** Fans out one `reconcile-account` job per active account. */
export const RECONCILE_JOB = 'reconcile-accounts';
export const RECONCILE_ACCOUNT_JOB = 'reconcile-account';
export const EXECUTE_TIMELOCKS_JOB = 'execute-ready-timelocks';
export const EXECUTE_RECOVERY_JOB = 'execute-ready-recovery';
export const RECOVERY_SOON_JOB = 'recovery-executes-soon';
/** Every scheduled account job runs this often. */
export const ACCOUNT_JOB_EVERY_MS = 60_000;
/** `RECOVERY_NOTICE_BEFORE`: the reminder goes out this long before a recovery can execute. */
export const RECOVERY_NOTICE_BEFORE_MS = 24 * 3_600_000;

// ─── account jobs ────────────────────────────────────────────────────────────

/** Where account jobs are added (the worker's accounts queue; tests swap in a recorder). */
export interface AccountJobs {
  add(name: string, data: object, opts: { delay?: number; jobId: string }): Promise<unknown>;
}
/** Back-compat name. */
export type DelayedJobs = AccountJobs;

let jobs: AccountJobs | null = null;

/** Replaces the account-job target (the worker passes its queue; tests a recorder); null resets. */
export function setAccountJobs(target: AccountJobs | null): void {
  jobs = target;
}
export const setDelayedJobs = setAccountJobs;

function accountJobs(): AccountJobs {
  jobs ??= new Queue(ACCOUNTS_QUEUE, { connection: createQueueConnection() });
  return jobs;
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
  await accountJobs().add(
    RECOVERY_SOON_JOB,
    { recoveryId },
    { delay, jobId: `recovery-soon__${recoveryId}` },
  );
}

/**
 * Adds one `reconcile-account` job per active account (both modes). The job id is stable per
 * account per tick, so overlapping sweeps never queue an account twice for the same minute.
 */
export async function enqueueReconciles(now = Date.now()): Promise<number> {
  const accounts = await prisma.merchantAccount.findMany({
    where: { status: 'active' },
    select: { id: true, merchantId: true, livemode: true },
  });
  const tick = Math.floor(now / ACCOUNT_JOB_EVERY_MS);
  for (const a of accounts) {
    await accountJobs().add(
      RECONCILE_ACCOUNT_JOB,
      { accountId: a.id, merchantId: a.merchantId, livemode: a.livemode },
      { jobId: `reconcile__${a.id}__${tick}` },
    );
  }
  return accounts.length;
}

// ─── recipients and links ────────────────────────────────────────────────────

/** Emails of the store's current signers (the single team-listing helper). */
async function signerEmails(merchantId: string): Promise<string[]> {
  return (await listMembers(merchantId)).filter((m) => m.isSigner).map((m) => m.email);
}

/** Mails every current signer, plus `alsoUserIds` (e.g. signers the change removed). */
async function mailSigners(
  merchantId: string,
  template: MailTemplate,
  data: Record<string, string>,
  alsoUserIds: string[] = [],
): Promise<number> {
  const to = new Set(await signerEmails(merchantId));
  if (alsoUserIds.length > 0) {
    const extra = await prisma.user.findMany({
      where: { id: { in: alsoUserIds } },
      select: { email: true },
    });
    for (const u of extra) to.add(u.email);
  }
  const mailer = getMailer();
  for (const email of to) await mailer.send({ to: email, template, data });
  return to.size;
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

/** What an action does, for a notice: a full sentence plus its decoded fields. */
export interface ActionSummary {
  kind: string;
  summary: string;
  /** Decoded fields of the action (mail data); money kinds always carry destination,
   * destinationChain, asset and amount. */
  fields: Record<string, string>;
}

/** A short, stable fingerprint of a public key: `<curve>:<first 16 hex of sha256(bytes)>`. */
export function keyFingerprint(key: SignerKeyJson | { ed25519: string }): string {
  const [curve, b64] = 'p256' in key ? ['p256', key.p256] : ['ed25519', key.ed25519];
  const digest = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  return `${curve}:${digest.slice(0, 16)}`;
}

async function savedAddressOnChain(
  account: { livemode: boolean; nearAccountId: string; merchantId: string },
  id: string,
): Promise<{ chain: string; address: string } | null> {
  try {
    const list = await nearClient(account.livemode).view<SavedAddressView[]>(
      account.nearAccountId,
      'list_saved_addresses',
      {},
    );
    const hit = list.find((a) => a.id === id);
    if (hit) return { chain: hit.chain, address: hit.address };
  } catch (err) {
    log('warn', 'list_saved_addresses failed; using the mirror', { err: String(err) });
  }
  // The mirror of the same contract state (`payout_allowlist`, id = on-chain id).
  const row = await prisma.payoutAllowlistEntry.findFirst({
    where: { id, merchantId: account.merchantId, livemode: account.livemode },
  });
  return row ? { chain: row.chain, address: row.address } : null;
}

async function personLabel(id: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  return u ? `${u.email} (${id})` : id;
}

const unlimited = (v: string | null) => v ?? 'unlimited';

/** Suffix of a security change the contract holds for 24 h after approval (R34). */
export const SECURITY_DELAY_NOTE = 'takes effect 24 h after approval';

/** The configured Tendr release code hash (base58) for a mode, if any. */
export function releaseCodeHash(livemode: boolean): string | null {
  const e = env();
  return (livemode ? e.MERCHANT_ACCOUNT_CODE_HASH_LIVE : e.MERCHANT_ACCOUNT_CODE_HASH_TEST) ?? null;
}

/** An upgrade's code hash in base58 (as published) and whether it is the mode's Tendr release. */
export function describeCodeHash(
  codeHashB64: string,
  livemode: boolean,
): { codeHash: string; isRelease: boolean; verdict: string } {
  const codeHash = bs58.encode(Buffer.from(codeHashB64, 'base64'));
  const release = releaseCodeHash(livemode);
  const isRelease = release !== null && release === codeHash;
  return {
    codeHash,
    isRelease,
    verdict: isRelease
      ? 'matches the Tendr release'
      : 'NOT a Tendr release — do not approve unless you expected this',
  };
}

/**
 * Decodes an on-chain action into the facts a notice states, for every `Action` variant. For a
 * withdrawal over a Swap route the funds leave to the swap's `deposit_account`, so that is the
 * destination named; over PoA they go to the saved address (resolved from the contract). A refund
 * names its own destination and chain (plus the swap deposit account when routed through one).
 * Keys appear as fingerprints, people with their email and id.
 */
export async function summarizeAction(
  action: ActionJson,
  account: { livemode: boolean; nearAccountId: string; merchantId: string; threshold?: number },
): Promise<ActionSummary> {
  const kind = kindOf(action);
  const out = (summary: string, fields: Record<string, string>): ActionSummary => ({
    kind,
    summary,
    fields,
  });
  const saved = async (id: string) => {
    const a = await savedAddressOnChain(account, id);
    return { text: a ? `${a.chain}:${a.address}` : `saved address ${id}`, a };
  };
  const a = action as Record<string, unknown>;
  switch (kind) {
    case 'withdraw': {
      const w = a.withdraw as ActionOf<'withdraw'>;
      const to = await saved(w.saved_address_id);
      const money = { asset: w.asset, amount: w.amount, savedAddress: to.text };
      if ('swap' in w.route) {
        return out(
          `Withdraw ${w.amount} ${w.asset} through swap deposit account ${w.route.swap.deposit_account} (for ${to.text})`,
          {
            ...money,
            destination: w.route.swap.deposit_account,
            destinationChain: 'near',
            route: 'swap',
          },
        );
      }
      return out(`Withdraw ${w.amount} ${w.asset} to ${to.text}`, {
        ...money,
        destination: to.a?.address ?? w.saved_address_id,
        destinationChain: to.a?.chain ?? '',
        route: `poa (${w.route.poa.token_contract})`,
      });
    }
    case 'refund': {
      const r = a.refund as ActionOf<'refund'>;
      const swap = 'swap' in r.route ? r.route.swap.deposit_account : null;
      return out(
        `Refund ${r.amount} ${r.asset} for ${r.payment_id} to ${r.destination_chain}:${r.destination}${swap ? ` through swap deposit account ${swap}` : ''}`,
        {
          asset: r.asset,
          amount: r.amount,
          destination: r.destination,
          destinationChain: r.destination_chain,
          paymentId: r.payment_id,
          route: swap ? 'swap' : 'poa',
          ...(swap ? { swapDepositAccount: swap } : {}),
        },
      );
    }
    case 'add_signer': {
      const v = a.add_signer as ActionOf<'add_signer'>;
      const who = await personLabel(v.id);
      const keys = v.keys.map((k) => keyFingerprint(k as SignerKeyJson)).join(', ');
      return out(`Add signer ${who} with keys ${keys} (${SECURITY_DELAY_NOTE})`, {
        signer: who,
        keyFingerprints: keys,
      });
    }
    case 'remove_signer': {
      const who = await personLabel((a.remove_signer as ActionOf<'remove_signer'>).id);
      return out(`Remove signer ${who}`, { signer: who });
    }
    case 'add_signer_key':
    case 'remove_signer_key': {
      const v = a[kind] as ActionOf<'add_signer_key'>;
      const who = await personLabel(v.id);
      const fp = keyFingerprint(v.key as SignerKeyJson);
      const delay = kind === 'add_signer_key' ? ` (${SECURITY_DELAY_NOTE})` : '';
      return out(
        `${kind === 'add_signer_key' ? 'Add' : 'Remove'} key ${fp} of signer ${who}${delay}`,
        { signer: who, keyFingerprints: fp },
      );
    }
    case 'set_threshold': {
      const t = String(a.set_threshold);
      const lowers = account.threshold !== undefined && Number(t) < account.threshold;
      return out(`Require ${t} signer approvals${lowers ? ` (${SECURITY_DELAY_NOTE})` : ''}`, {
        threshold: t,
      });
    }
    case 'set_origins': {
      const o = (a.set_origins as string[]).join(', ');
      return out(`Set the allowed passkey origins to ${o} (${SECURITY_DELAY_NOTE})`, {
        origins: o,
      });
    }
    case 'rotate_recovery_key': {
      const k = a.rotate_recovery_key as string | null;
      const fp = k ? keyFingerprint({ ed25519: k }) : 'none';
      return out(
        `${k ? `Replace the recovery key with ${fp}` : 'Remove the recovery key'} (${SECURITY_DELAY_NOTE})`,
        { recoveryKeyFingerprint: fp },
      );
    }
    case 'add_saved_address': {
      const v = a.add_saved_address as ActionOf<'add_saved_address'>;
      return out(`Add saved address ${v.chain}:${v.address} (usable 24 h after approval)`, {
        savedAddressId: v.id,
        destination: v.address,
        destinationChain: v.chain,
      });
    }
    case 'remove_saved_address': {
      const id = (a.remove_saved_address as ActionOf<'remove_saved_address'>).id;
      const to = await saved(id);
      return out(`Remove saved address ${to.text}`, {
        savedAddressId: id,
        destination: to.a?.address ?? '',
        destinationChain: to.a?.chain ?? '',
      });
    }
    case 'set_limits': {
      const v = a.set_limits as ActionOf<'set_limits'>;
      return out(
        `Set ${v.asset} limits: per withdrawal ${unlimited(v.per_tx)}, per day ${unlimited(v.per_day)}`,
        { asset: v.asset, perTx: unlimited(v.per_tx), perDay: unlimited(v.per_day) },
      );
    }
    case 'set_refund_cap': {
      const v = a.set_refund_cap as ActionOf<'set_refund_cap'>;
      return out(`Set the daily refund cap of ${v.asset} to ${v.daily}`, {
        asset: v.asset,
        refundCap: v.daily,
      });
    }
    case 'set_auto_sweep': {
      const v = a.set_auto_sweep as ActionOf<'set_auto_sweep'>;
      const to = await saved(v.saved_address_id);
      return out(
        `Auto-sweep ${v.asset}: above ${v.trigger_above}, send everything over ${v.keep} to ${to.text}`,
        {
          asset: v.asset,
          triggerAbove: v.trigger_above,
          keep: v.keep,
          destination: to.a?.address ?? v.saved_address_id,
          destinationChain: to.a?.chain ?? '',
        },
      );
    }
    case 'clear_auto_sweep': {
      const asset = (a.clear_auto_sweep as ActionOf<'clear_auto_sweep'>).asset;
      return out(`Turn off auto-sweep of ${asset}`, { asset });
    }
    case 'upgrade': {
      const h = describeCodeHash((a.upgrade as ActionOf<'upgrade'>).code_hash, account.livemode);
      return out(`Upgrade the account contract to code ${h.codeHash} (${h.verdict})`, {
        codeHash: h.codeHash,
        codeHashIsTendrRelease: h.isRelease ? 'yes' : 'no',
        codeHashVerdict: h.verdict,
      });
    }
    case 'set_settlement': {
      const v = a.set_settlement as ActionOf<'set_settlement'>;
      if (v.payout_mode === 'wallet' && v.saved_address_id) {
        const to = await saved(v.saved_address_id);
        return out(`Settle checkout in ${v.dest_asset} straight to ${to.text}`, {
          asset: v.dest_asset,
          payoutMode: 'wallet',
          destination: to.a?.address ?? v.saved_address_id,
          destinationChain: to.a?.chain ?? '',
        });
      }
      return out(`Settle checkout in ${v.dest_asset} into the account's intents balance`, {
        asset: v.dest_asset,
        payoutMode: 'intents',
        destination: account.nearAccountId,
        destinationChain: 'near',
      });
    }
  }
}

async function accountOf(scope: { merchantId: string; livemode: boolean }) {
  return prisma.merchantAccount.findFirst({ where: scope });
}

const actionData = (sum: ActionSummary, extra: Record<string, string>) => ({
  ...sum.fields,
  kind: sum.kind,
  summary: sum.summary,
  ...extra,
});

/** Signers an executed action removed (they still hear about it). */
function removedBy(action: ActionJson): string[] {
  return 'remove_signer' in action ? [action.remove_signer.id] : [];
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
  await mailSigners(
    scope.merchantId,
    'proposal_needs_approval',
    actionData(sum, {
      proposalId: s(p.proposalId),
      livemode: String(scope.livemode),
      url: approvalUrl(s(p.proposalId)),
    }),
  );
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
  await mailSigners(
    scope.merchantId,
    'timelock_started',
    actionData(sum, {
      proposalId: s(p.proposalId),
      readyAt: s(p.readyAt),
      livemode: String(scope.livemode),
      cancelUrl: approvalUrl(s(p.proposalId)),
    }),
  );
}

/** `account.proposal.executed` → `proposal_executed`, also to signers the change removed. */
export async function onProposalExecuted(event: Event): Promise<void> {
  const scope = scopeOf(event);
  const p = payloadOf(event);
  const account = await accountOf(scope);
  const action = ActionSchema.safeParse(p.action);
  if (!account || !action.success) return;
  const sum = await summarizeAction(action.data, account);
  await mailSigners(
    scope.merchantId,
    'proposal_executed',
    actionData(sum, {
      proposalId: s(p.proposalId),
      livemode: String(scope.livemode),
      url: approvalUrl(s(p.proposalId)),
    }),
    removedBy(action.data),
  );
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
 * `account.recovery_session.opened` / `.passkey_registered` (R28 c) → the person and every
 * current signer of the store are told.
 */
async function onRecoverySession(event: Event, template: MailTemplate): Promise<void> {
  const scope = scopeOf(event);
  const p = payloadOf(event);
  const person = await prisma.user.findUnique({
    where: { id: s(p.userId) },
    select: { id: true, email: true },
  });
  if (!person) return;
  await mailSigners(
    scope.merchantId,
    template,
    { person: `${person.email} (${person.id})`, at: event.createdAt.toISOString() },
    [person.id],
  );
}

export const onRecoverySessionOpened = (e: Event) =>
  onRecoverySession(e, 'recovery_session_opened');
export const onRecoveryPasskeyRegistered = (e: Event) =>
  onRecoverySession(e, 'recovery_passkey_registered');

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
  registerEventHandler(
    T.recoverySessionOpened,
    'notify-recovery-session-opened',
    onRecoverySessionOpened,
  );
  registerEventHandler(
    T.recoveryPasskeyRegistered,
    'notify-recovery-passkey-registered',
    onRecoveryPasskeyRegistered,
  );
  registerEventHandler(T.signersChanged, 'mirror-test-signers', onSignersChanged, {
    attempts: 20,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}

/** Runs one job of the accounts or executors queue by name. */
export async function processAccountJob(name: string, data: unknown): Promise<void> {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case RECONCILE_JOB:
      await enqueueReconciles();
      return;
    case RECONCILE_ACCOUNT_JOB: {
      if (typeof d.merchantId !== 'string' || typeof d.livemode !== 'boolean') {
        throw new Error('reconcile-account job without merchantId/livemode');
      }
      await reconcileAccount(d.merchantId, d.livemode);
      return;
    }
    case EXECUTE_TIMELOCKS_JOB:
      await executeReadyTimelocks();
      await settleExpiredProposals();
      return;
    case EXECUTE_RECOVERY_JOB:
      await executeReadyRecovery();
      return;
    case RECOVERY_SOON_JOB: {
      if (typeof d.recoveryId !== 'string') {
        throw new Error('recovery-executes-soon job without recoveryId');
      }
      await sendRecoveryExecutesSoon(d.recoveryId);
      return;
    }
    default:
      throw new Error(`unknown accounts job ${name}`);
  }
}
