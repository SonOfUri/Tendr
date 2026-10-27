// Relayed gasless submissions: the checks every family shares before any gas is spent, the
// `gas_sponsorships` record of each submission, and what happens when the chain answers
// (project 5a, spec §2.2, §2.5, §2.6, §3.2, §8.1).
//
// A submission is a `gas_sponsorships` row tied to its quote (`quote_id`): the quote's own budget
// reservation when the merchant sponsors (`sponsor = merchant`), or a new row with
// `sponsor = shopper` when the shopper pays the fee in the token. Its id is the submission id.
//
//   submit      session open → quote current and unexpired → gasless on the quote → an existing
//               submission is returned as is → the reservation is still `reserved` (sponsored) →
//               the session's attempt limit → the family checks every signed field → the
//               signer's hourly limit → claim (session lock) → broadcast. Refusals before the
//               broadcast spend no gas.
//   broadcast   not broadcast → the row fails, the reservation is released, the session stays
//               open. Broadcast → `submitted`; the quote records the deposit tx (blocks re-quoting
//               until its deadline) and 1Click is told about it.
//   confirmed   `confirmed`; a reservation is settled at the quoted estimate (§8.1); a shopper fee
//               leg becomes `gas_reimbursement` revenue once the payment exists.
//   failed      `failed`; the reservation is released; gas the chain burned is Tendr's loss
//               (`recognizeTendrLoss`).
//
// Paid means detected: none of this marks a session or payment paid. Only the 1Click status and
// the watcher do; `onQuotePaymentDetected` is their hook back into the gas records.
import { Prisma, type Quote } from '@prisma/client';
import { keccak256, toUtf8Bytes } from 'ethers';
import { providerFor } from '../checkout/oneclick/index.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { releaseReservation, settleReservation } from '../gas/budget.js';
import { recognizeTendrLoss } from '../gas/loss-cap.js';
import { gasProvider } from '../gas/quote-fee.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import type { QuoteContext, SignedPayload, SubmissionStatus, SubmitResult } from './types.js';

type Tx = Prisma.TransactionClient;
type Scope = { merchantId: string; livemode: boolean };

/** Lifetime relayed-submit attempts per checkout session. */
export const SUBMITS_PER_SESSION = 5;
/** Relayed-submit attempts per shopper address per hour (all sessions, all stores). */
export const SUBMITS_PER_ADDRESS_PER_HOUR = 20;
const SESSION_LIMIT_TTL_S = 3 * 24 * 3600;

/** A transaction the relayer is asked to send. */
export interface RelayCall {
  chain: string;
  to: string;
  data: string;
}

/** Sends `call`; throws `RelayNotBroadcast` when nothing reached the chain. */
export type Broadcast = (
  call: RelayCall,
  submission: { id: string; giveUpAt: Date },
) => Promise<{ txHash: string; relayerTxId?: string }>;

/** The relayer refused or could not send: nothing reached the chain, no gas spent. */
export class RelayNotBroadcast extends Error {
  constructor(
    message: string,
    readonly reason: 'simulation_reverted' | 'fee_cap' | 'rejected' | 'unavailable',
  ) {
    super(message);
    this.name = 'RelayNotBroadcast';
  }
}

const ACTIVE: Prisma.GasSponsorshipWhereInput['status'] = {
  in: ['pending', 'submitted', 'confirmed'],
};

export const quoteExpired = (why: string) =>
  new AppError('QUOTE_EXPIRED', `This quote ${why}; request a new one`, 409);

export const gaslessNotAvailable = () =>
  new AppError(
    'GASLESS_NOT_AVAILABLE',
    'This quote is not for a gasless payment; request a gasless quote',
    409,
  );

/** Session open, quote current and unexpired, quote made for a gasless payment. */
export function assertRelayable(q: QuoteContext, now: Date): void {
  const s = q.session;
  if (s.status === 'EXPIRED' || s.expiresAt.getTime() <= now.getTime()) {
    throw new AppError('SESSION_EXPIRED', 'This checkout has expired; return to the store', 409);
  }
  if (s.status !== 'PENDING_DEPOSIT') {
    throw new AppError('CONFLICT', 'This checkout is no longer taking new payments', 409, {
      status: s.status,
    });
  }
  if (q.quote.supersededAt) throw quoteExpired('was replaced by a newer one');
  if (q.quote.deadline.getTime() <= now.getTime()) throw quoteExpired('has expired');
  if (!q.quote.walletAddress || !q.quote.networkFeeMethod || q.quote.networkFeeMode === 'native') {
    throw gaslessNotAvailable();
  }
}

/**
 * Counts one attempt against a limit (`key` expires `ttlS` after its first use); 429 when over.
 * Fails closed: the limits are what keep spam signatures from draining the relayer's gas.
 */
async function countAttempt(key: string, ttlS: number, max: number): Promise<void> {
  let count: number;
  try {
    const r = await getRedis().multi().incr(key).expire(key, ttlS, 'NX').exec();
    count = Number(r?.[0]?.[1]);
    if (!Number.isFinite(count)) throw new Error('no count');
  } catch (err) {
    log('warn', 'gasless submit: rate-limit store unavailable', { err: String(err) });
    throw new AppError('PROVIDER_UNAVAILABLE', 'Gasless payments are unavailable; try again', 503);
  }
  if (count > max) {
    throw new AppError('RATE_LIMITED', 'Too many payment attempts; try again later', 429, {
      max_per_session: SUBMITS_PER_SESSION,
      max_per_address_per_hour: SUBMITS_PER_ADDRESS_PER_HOUR,
    });
  }
}

/** Every attempt on the session counts, valid or not. */
const countSessionAttempt = (q: QuoteContext) =>
  countAttempt(
    `tendr:gasless:submit:ses:${q.session.id}`,
    SESSION_LIMIT_TTL_S,
    SUBMITS_PER_SESSION,
  );

/**
 * Per signer address, counted only once the signatures verify: anyone can name an address in a
 * quote, but only its owner can sign for it, so a stranger cannot use up another wallet's limit.
 */
const countAddressAttempt = (q: QuoteContext, now: Date) =>
  countAttempt(
    `tendr:gasless:submit:addr:${q.quote.walletAddress!.toLowerCase()}:${Math.floor(now.getTime() / 3_600_000)}`,
    3600,
    SUBMITS_PER_ADDRESS_PER_HOUR,
  );

async function activeSubmission(scope: Scope, quoteId: string) {
  return prisma.gasSponsorship.findFirst({
    where: { ...scope, quoteId, status: ACTIVE },
    orderBy: { createdAt: 'desc' },
  });
}

function asResult(row: {
  id: string;
  txHash: string | null;
  status: SubmissionStatus;
}): SubmitResult {
  return {
    submissionId: row.id,
    ...(row.txHash ? { txHash: row.txHash } : {}),
    status: row.status,
  };
}

/** Locks the session row and re-checks it can still take a payment. */
async function lockOpenSession(tx: Tx, scope: Scope, sessionId: string, now: Date) {
  const rows = await tx.$queryRaw<{ status: string; expires_at: Date }[]>`
    SELECT status::text AS status, expires_at FROM sessions
    WHERE id = ${sessionId} AND merchant_id = ${scope.merchantId} AND livemode = ${scope.livemode}
    FOR UPDATE`;
  const s = rows[0];
  if (!s) throw notFound('Session not found');
  if (s.status !== 'PENDING_DEPOSIT' || s.expires_at.getTime() <= now.getTime()) {
    throw new AppError('SESSION_EXPIRED', 'This checkout is no longer taking payments', 409);
  }
}

/**
 * Claims the submission's `gas_sponsorships` row under the session lock: the quote's reservation
 * (sponsored) or a new `sponsor = shopper` row. Returns the existing active submission instead
 * when a concurrent submit got there first.
 */
async function claim(
  q: QuoteContext,
  now: Date,
): Promise<{ id: string; existing: boolean; row?: SubmitResult }> {
  const scope = { merchantId: q.shopper.merchantId, livemode: q.shopper.livemode };
  return tenantTransaction(scope, async (tx) => {
    await lockOpenSession(tx, scope, q.session.id, now);
    const quote = await tx.quote.findFirst({
      where: { ...scope, id: q.quote.id, sessionId: q.session.id },
    });
    if (!quote || quote.supersededAt) throw quoteExpired('was replaced by a newer one');
    if (quote.deadline.getTime() <= now.getTime()) throw quoteExpired('has expired');
    const existing = await tx.gasSponsorship.findFirst({
      where: { ...scope, quoteId: quote.id, status: ACTIVE },
    });
    if (existing) return { id: existing.id, existing: true, row: asResult(existing) };

    const signer = quote.walletAddress!.toLowerCase();
    if (quote.networkFeePaidBy === 'merchant') {
      const { count } = await tx.gasSponsorship.updateMany({
        where: {
          ...scope,
          id: quote.gasSponsorshipId ?? '',
          reservationState: 'reserved',
          quoteId: null,
          status: 'pending',
        },
        data: { quoteId: quote.id, signerAddress: signer },
      });
      if (count !== 1) throw sponsorshipReleased();
      return { id: quote.gasSponsorshipId!, existing: false };
    }
    const id = newId('gas');
    const method = quote.networkFeeMethod!;
    await tx.gasSponsorship.create({
      data: {
        id,
        ...scope,
        sessionId: q.session.id,
        chain: q.origin.blockchain,
        method,
        provider: gasProvider(q.origin.blockchain, method as Parameters<typeof gasProvider>[1]),
        sponsor: 'shopper',
        status: 'pending',
        feeMode: 'token',
        feeAsset: quote.originAssetId,
        feeAmount: quote.networkFeeAmount,
        estimateUsd: quote.networkFeeUsd,
        quoteId: quote.id,
        signerAddress: signer,
      },
    });
    return { id, existing: false };
  });
}

const sponsorshipReleased = () =>
  new AppError(
    'SPONSORSHIP_RELEASED',
    'The network fee sponsorship for this quote is no longer held; request a new quote',
    409,
  );

/** Marks the submission failed before broadcast and releases its reservation. */
async function failUnbroadcast(q: QuoteContext, id: string, reason: string): Promise<void> {
  const scope = { merchantId: q.shopper.merchantId, livemode: q.shopper.livemode };
  await tenantTransaction(scope, async (tx) => {
    await tx.gasSponsorship.updateMany({
      where: { ...scope, id, status: 'pending' },
      data: { status: 'failed', lastError: reason.slice(0, 500) },
    });
    await releaseReservation(tx, id);
  });
}

function notBroadcastError(err: RelayNotBroadcast): AppError {
  switch (err.reason) {
    case 'simulation_reverted':
      return new AppError(
        'GASLESS_SUBMIT_FAILED',
        'The payment could not be submitted: the chain refused it. Check your balance and request a new quote',
        409,
        { reason: err.message.slice(0, 300) },
      );
    case 'fee_cap':
      return new AppError('NETWORK_FEE_UNAVAILABLE', 'The network fee is too high right now', 503);
    default:
      return new AppError(
        'PROVIDER_UNAVAILABLE',
        'Gasless payments are unavailable; try again',
        503,
      );
  }
}

/**
 * The shared submit pipeline (see the file header). `verify` checks every signed field against
 * the quote and returns the transaction to relay; it throws GASLESS_PAYLOAD_MISMATCH.
 */
export async function submitRelayed(
  q: QuoteContext,
  signed: SignedPayload,
  verify: (q: QuoteContext, signed: SignedPayload) => Promise<RelayCall>,
  broadcast: Broadcast,
  now: Date = new Date(),
): Promise<SubmitResult> {
  const scope = { merchantId: q.shopper.merchantId, livemode: q.shopper.livemode };
  assertRelayable(q, now);
  const existing = await activeSubmission(scope, q.quote.id);
  if (existing) return asResult(existing);
  if (q.quote.networkFeePaidBy === 'merchant') {
    const held = q.quote.gasSponsorshipId
      ? await prisma.gasSponsorship.findFirst({
          where: { ...scope, id: q.quote.gasSponsorshipId },
          select: { reservationState: true },
        })
      : null;
    if (held?.reservationState !== 'reserved') throw sponsorshipReleased();
  }
  await countSessionAttempt(q);
  const call = await verify(q, signed);
  await countAddressAttempt(q, now);

  const claimed = await claim(q, now);
  if (claimed.existing) return claimed.row!;
  let sent: { txHash: string; relayerTxId?: string };
  try {
    sent = await broadcast(call, { id: claimed.id, giveUpAt: q.quote.deadline });
  } catch (err) {
    if (err instanceof RelayNotBroadcast) {
      await failUnbroadcast(q, claimed.id, err.message);
      throw notBroadcastError(err);
    }
    // Anything else: the outcome is unknown. The row stays `pending`; the relayer's own record
    // (if any) reports the outcome through `applyRelayOutcome`.
    throw err;
  }
  await markSubmitted(q, claimed.id, sent);
  return { submissionId: claimed.id, txHash: sent.txHash, status: 'submitted' };
}

/** `submitted`: the row gets its hash; the quote records the deposit tx; 1Click is told. */
async function markSubmitted(
  q: QuoteContext,
  id: string,
  sent: { txHash: string; relayerTxId?: string },
): Promise<void> {
  const scope = { merchantId: q.shopper.merchantId, livemode: q.shopper.livemode };
  const now = new Date();
  await tenantTransaction(scope, async (tx) => {
    await tx.gasSponsorship.updateMany({
      where: { ...scope, id, status: 'pending' },
      data: {
        status: 'submitted',
        txHash: sent.txHash,
        ...(sent.relayerTxId ? { relayerTxId: sent.relayerTxId } : {}),
      },
    });
    await tx.quote.updateMany({
      where: { ...scope, id: q.quote.id },
      data: { depositTxHash: sent.txHash, depositTxSubmittedAt: now },
    });
  });
  try {
    await providerFor(q.shopper.livemode).submitDeposit(sent.txHash, q.quote.depositAddress);
  } catch (err) {
    // A hint only: 1Click detects the deposit on chain either way.
    log('warn', 'gasless submit: 1Click deposit notice failed', {
      submissionId: id,
      err: String(err),
    });
  }
}

export interface RelayOutcome {
  status: 'confirmed' | 'failed';
  txHash: string | null;
  gasUsed: bigint | null;
  /** What the chain charged (USD); null when unknown. */
  costUsd: string | null;
  reason: string | null;
}

/**
 * Applies the chain's final answer to a submission (idempotent: a row already final is left).
 * Confirmed: settles the reservation at the quoted estimate and records a fee leg's revenue.
 * Failed: releases the reservation; gas the chain charged becomes Tendr's loss.
 */
export async function applyRelayOutcome(
  submissionId: string,
  outcome: RelayOutcome,
  now: Date = new Date(),
): Promise<boolean> {
  const head = await prisma.gasSponsorship.findUnique({
    where: { id: submissionId },
    select: { merchantId: true, livemode: true, sessionId: true },
  });
  if (!head) {
    log('error', 'relay outcome for an unknown submission', { submissionId });
    return false;
  }
  const scope = { merchantId: head.merchantId, livemode: head.livemode };
  return tenantTransaction(scope, async (tx) => {
    // Session first: the lock order every budget path uses (session → month → sponsorship).
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${head.sessionId}
      AND merchant_id = ${scope.merchantId} AND livemode = ${scope.livemode} FOR UPDATE`;
    const sp = await tx.gasSponsorship.findFirstOrThrow({ where: { ...scope, id: submissionId } });
    if (sp.status === 'confirmed' || sp.status === 'failed') return false;
    const common = {
      ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      ...(outcome.gasUsed !== null ? { gasUsed: outcome.gasUsed.toString() } : {}),
      ...(outcome.costUsd !== null ? { costUsd: outcome.costUsd } : {}),
    };
    // The budget first (month row → sponsorship row), then the row's own status: the same row
    // lock order as `releaseReservation` in the stale-reservation sweep.
    if (outcome.status === 'confirmed') {
      if (sp.reservationState === 'reserved' && sp.estimateUsd) {
        await settleReservation(tx, sp.id, sp.estimateUsd.toFixed());
      }
      await tx.gasSponsorship.updateMany({
        where: { ...scope, id: sp.id },
        data: { ...common, status: 'confirmed' },
      });
      if (sp.sponsor === 'shopper') await recordFeeLegRevenue(tx, scope, sp.id);
      return true;
    }
    if (sp.reservationState === 'reserved') await releaseReservation(tx, sp.id);
    await tx.gasSponsorship.updateMany({
      where: { ...scope, id: sp.id },
      data: { ...common, status: 'failed', lastError: outcome.reason?.slice(0, 500) ?? null },
    });
    if (outcome.costUsd !== null && new Prisma.Decimal(outcome.costUsd).gt(0)) {
      await recognizeTendrLoss(tx, sp.id, outcome.costUsd, now);
    }
    return true;
  });
}

/**
 * Records a confirmed shopper-paid fee leg as `gas_reimbursement` revenue on the quote's payment
 * (one row per fee leg: `reference` = the submission id). A no-op until the payment exists, or
 * when already recorded.
 */
export async function recordFeeLegRevenue(
  tx: Tx,
  scope: Scope,
  submissionId: string,
): Promise<number> {
  const sp = await tx.gasSponsorship.findFirst({
    where: { ...scope, id: submissionId, sponsor: 'shopper', status: 'confirmed' },
  });
  if (!sp?.quoteId || !sp.feeAmount || !sp.feeAsset || sp.feeAmount.lte(0)) return 0;
  const payment = await tx.payment.findFirst({
    where: { ...scope, quoteId: sp.quoteId },
    select: { id: true },
  });
  if (!payment) return 0;
  const { count } = await tx.revenueEntry.createMany({
    data: [
      {
        id: newId('rev'),
        ...scope,
        paymentId: payment.id,
        source: 'gas_reimbursement',
        assetId: sp.feeAsset,
        amount: sp.feeAmount,
        amountUsd: sp.estimateUsd,
        txHash: sp.txHash,
        reference: sp.id,
      },
    ],
    skipDuplicates: true,
  });
  return count;
}

/**
 * The watcher found the quote's payment (inside its transaction, under the session lock): a
 * reservation still held is settled at the quoted estimate whatever way the shopper paid (a
 * sponsored quote paid by copy-address included: the deduction is in the merchant's proceeds), and
 * confirmed shopper fee legs become revenue.
 */
export async function onQuotePaymentDetected(
  tx: Tx,
  scope: Scope,
  quote: Pick<Quote, 'id' | 'gasSponsorshipId'>,
  paymentId: string,
): Promise<void> {
  if (quote.gasSponsorshipId) {
    const sp = await tx.gasSponsorship.findFirst({
      where: { ...scope, id: quote.gasSponsorshipId },
      select: { id: true, reservationState: true, estimateUsd: true, sponsor: true },
    });
    if (sp?.reservationState === 'reserved' && sp.estimateUsd) {
      await settleReservation(tx, sp.id, sp.estimateUsd.toFixed());
    }
    if (sp && sp.sponsor === 'merchant') {
      await tx.gasSponsorship.updateMany({
        where: { ...scope, id: sp.id, recoveredFromPaymentId: null },
        data: { recoveredFromPaymentId: paymentId },
      });
    }
  }
  const legs = await tx.gasSponsorship.findMany({
    where: { ...scope, quoteId: quote.id, sponsor: 'shopper', status: 'confirmed' },
    select: { id: true },
  });
  for (const leg of legs) await recordFeeLegRevenue(tx, scope, leg.id);
}

/** A submission's state, or NOT_FOUND. */
export async function submissionStatus(submissionId: string): Promise<SubmissionStatus> {
  const row = await prisma.gasSponsorship.findUnique({
    where: { id: submissionId },
    select: { status: true, quoteId: true },
  });
  if (!row?.quoteId) throw notFound('Submission not found');
  return row.status;
}

/** Test mode: a deterministic, obviously simulated transaction hash for a submission. */
export function simulatedRelayTxHash(submissionId: string): string {
  return keccak256(toUtf8Bytes(`tendr:simulated-relay:${submissionId}`));
}
