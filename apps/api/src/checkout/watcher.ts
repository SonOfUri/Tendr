// The payment watcher (spec §4, §6, §7; "Changes after external plan review" #1–#3, #7, #8).
//
// Polling: `scanDueDeposits` (every 5 s) claims due deposit addresses with a lease
// (`quotes.watch_next_at`) and enqueues one `pollDeposit(depositAddress)` job each. A poll reads
// 1Click's status, records/advances the address's payment and schedules the next poll: 5 s while
// the shopper's page read the session in the last 60 s, else 30 s. Polling stops for good when the
// payment is final, 24 h after the quote was created, or — for a superseded quote with no
// deposit — 30 min after its deadline (a manual send to an old address is still attributed to it).
//
// Paid means verified (never balance deltas): 1Click `SUCCESS`, then the specific settlement
// transfer — a NEP-245 `mt_transfer`/`mt_mint` (or NEP-141 `ft_transfer` for a NEAR payout
// address) of the settlement asset to the session's recipient for at least the quote's
// `amount_out`, emitted by the token's own contract in one of 1Click's `destinationChainTxHashes`
// — and that transaction not already settling another payment. Wallet payouts to chains without
// a verifier accept 1Click's `amountOut` + destination tx hash (`verified_by = 'oneclick'`).
//
// Every detected sender is screened (connected wallets too: the sender may differ). `block` holds
// the payment (non-custodial notice, hold.ts); `unavailable` leaves it SCREENING_PENDING at
// settlement time, retried by screening.ts, whose `allow` hook re-runs this settlement path.
import { Prisma, type Payment, type Quote, type Session } from '@prisma/client';
import type { SessionStatus } from '@tendr/contracts';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { transitionPayment, transitionSession } from '../events/transitions.js';
import { networkFeeView } from '../gas/quote-fee.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { nearClient, type NearClient, type TxStatusResult } from '../near/client.js';
import { matchingCredits } from '../near/events.js';
import { holdPaymentInTx } from './hold.js';
import { depositInFlight, SUPERSEDED_GRACE_MS } from './in-flight.js';
import {
  OneClickError,
  providerFor,
  simulatedOneClick,
  type OneClickProvider,
  type StatusResponse,
} from './oneclick/index.js';
import { keptSmallNetOfFee } from './return-fee.js';
import { onPaymentCollected, onQuotePaymentDetected } from '../relayer/submissions.js';
import { recordRevenue } from './revenue.js';
import { liveSenderResolvers } from './senders/index.js';
import { onScreeningAllowed, screenAddress, type ScreeningOutcome } from './screening.js';
import { expireInTx } from './sessions.js';
import { tokenInfo } from './tokens.js';

// ─── timings ─────────────────────────────────────────────────────────────────

/** Poll interval while the shopper's page is reading the session. */
export const FAST_POLL_MS = 5_000;
/** Poll interval otherwise. */
export const SLOW_POLL_MS = 30_000;
/** A page read keeps the fast interval for this long. */
export const VIEWED_TTL_S = 60;
/** No polling more than this long after the quote was created. */
export const WATCH_MAX_MS = 24 * 3_600_000;
/** A superseded quote with no deposit is polled until its deadline plus this (in-flight.ts). */
export { SUPERSEDED_GRACE_MS };
/** A claimed address is not picked up again for this long (a crashed poll is retried after it). */
export const POLL_LEASE_MS = 60_000;

const viewedKey = (sessionId: string) => `checkout:viewed:${sessionId}`;

/** Records that the shopper's page read the session (fast polling for VIEWED_TTL_S). Best effort. */
export async function markSessionViewed(sessionId: string): Promise<void> {
  try {
    await getRedis().set(viewedKey(sessionId), '1', 'EX', VIEWED_TTL_S);
  } catch {
    // Redis down: the watcher falls back to the slow interval.
  }
}

async function viewedRecently(sessionId: string): Promise<boolean> {
  try {
    return (await getRedis().exists(viewedKey(sessionId))) === 1;
  } catch {
    return false;
  }
}

// ─── classification (pure) ───────────────────────────────────────────────────

export type PaymentOutcome = 'settled' | 'underpaid' | 'overpaid' | 'late' | 'failed' | 'pending';

const big = (v: string | undefined | null): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);
const toBig = (d: Prisma.Decimal | bigint | string): bigint =>
  typeof d === 'bigint' ? d : BigInt(typeof d === 'string' ? d : d.toFixed(0));

/** True once 1Click has seen a deposit (or a reported deposit tx) for the address. */
export function depositSeen(status: StatusResponse): boolean {
  return status.status !== 'PENDING_DEPOSIT' || status.swapDetails.originChainTxHashes.length > 0;
}

/**
 * What a 1Click status means for a payment.
 * - `session.status` is the session's status as this payment sees it: `PENDING_DEPOSIT` /
 *   `PROCESSING` when the session is (still) waiting on it; anything else makes the deposit late.
 * - `late`: the session is closed for this payment, or the deposit was first observed
 *   (`observedAt`) after the quote deadline and 1Click did not swap it.
 * - `failed`: 1Click's swap FAILED, or it refunded a full deposit observed before the deadline
 *   (it could not swap it, e.g. slippage; M-1): reopened while unexpired, like a failed swap.
 * - `overpaid`: `SUCCESS` with `refundedAmount > 0`; `underpaid`: `INCOMPLETE_DEPOSIT`, or a
 *   short deposit refunded.
 */
export function classify(
  quote: { amountIn: Prisma.Decimal | bigint | string; deadline: Date },
  session: { status: SessionStatus | string },
  status: StatusResponse,
  observedAt?: Date,
): PaymentOutcome {
  if (!depositSeen(status)) return 'pending';
  if (status.status === 'FAILED') return 'failed';
  const open = session.status === 'PENDING_DEPOSIT' || session.status === 'PROCESSING';
  if (!open) return 'late';
  const afterDeadline = observedAt !== undefined && observedAt > quote.deadline;
  const deposited = big(status.swapDetails.depositedAmount);
  switch (status.status) {
    case 'SUCCESS':
      return big(status.swapDetails.refundedAmount) > 0n ? 'overpaid' : 'settled';
    case 'INCOMPLETE_DEPOSIT':
      return afterDeadline ? 'late' : 'underpaid';
    case 'REFUNDED':
      if (afterDeadline) return 'late';
      return deposited >= toBig(quote.amountIn) ? 'failed' : 'underpaid';
    default:
      return 'pending';
  }
}

// ─── dependencies & hooks ────────────────────────────────────────────────────

export interface WatcherDeps {
  now(): Date;
  provider(livemode: boolean): OneClickProvider;
  near(livemode: boolean): NearClient;
  screen(
    ctx: ScopeContext,
    input: { sessionId: string; address: string; chain: string },
  ): Promise<{ decision: ScreeningOutcome }>;
  /** CHECKOUT_TOPUP_ENABLED; unset: on in test mode, off in live mode. */
  topupEnabled(livemode: boolean): boolean;
  /**
   * TEST MODE ONLY: the simulated provider's destination tx for one of its settlement hashes
   * (null for any other hash). Never consulted for a live payment.
   */
  simulatedTx(hash: string): Promise<TxStatusResult | null>;
  /**
   * Every origin-chain sender of a deposit (senders/); [] when it cannot be told (the payment
   * then waits in SCREENING_PENDING). Never called in test mode, which uses the simulated sender.
   */
  resolveSenders(input: {
    livemode: boolean;
    chain: string;
    originAsset: string;
    depositAddress: string;
    originTxHashes: string[];
  }): Promise<string[]>;
}

const liveResolvers = liveSenderResolvers(() => deps.near(true));

/** Live mode: the per-family resolvers. Test mode: none (the simulator names the sender). */
async function defaultResolveSenders(input: {
  livemode: boolean;
  chain: string;
  originAsset: string;
  depositAddress: string;
  originTxHashes: string[];
}): Promise<string[]> {
  if (!input.livemode) return [];
  return liveResolvers.resolve(input);
}

/** Every known sender of a payment (`sender_addresses`, else the primary `sender_address`). */
export function paymentSenders(p: Pick<Payment, 'senderAddress' | 'senderAddresses'>): string[] {
  if (p.senderAddresses.length > 0) return p.senderAddresses;
  return p.senderAddress ? [p.senderAddress] : [];
}

/** Any `block` blocks; otherwise any `unavailable` (or no sender at all) is unavailable. */
export function combineDecisions(ds: ScreeningOutcome[]): ScreeningOutcome {
  if (ds.includes('block')) return 'block';
  if (ds.length === 0 || ds.includes('unavailable')) return 'unavailable';
  return 'allow';
}

const DEFAULT_DEPS: WatcherDeps = {
  now: () => new Date(),
  provider: providerFor,
  near: nearClient,
  screen: screenAddress,
  topupEnabled: (livemode) => env().CHECKOUT_TOPUP_ENABLED ?? !livemode,
  resolveSenders: defaultResolveSenders,
  simulatedTx: (hash) => simulatedOneClick().destinationTx(hash),
};
let deps: WatcherDeps = DEFAULT_DEPS;

/** Whether the shopper is offered an underpay top-up in this mode (CHECKOUT_TOPUP_ENABLED). */
export function topupEnabled(livemode: boolean): boolean {
  return deps.topupEnabled(livemode);
}

/** The watcher's clock (injectable in tests); the shopper view reads deadlines against it. */
export function watcherNow(): Date {
  return deps.now();
}

/** Test hook: overrides some dependencies; null restores the defaults. */
export function setWatcherDeps(overrides: Partial<WatcherDeps> | null): void {
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

export type ReturnReason = 'overpaid' | 'underpaid' | 'late' | 'failed' | 'sanctions';
/**
 * Money that landed in the merchant account must go back to the sender (Task 8 queues the
 * signer-approved return). Called after the payment's state change committed.
 */
export type ReturnNeededHook = (
  payment: Payment,
  info: { reason: ReturnReason; assetId: string; amount: string },
) => Promise<void>;

const logReturn: ReturnNeededHook = async (payment, info) => {
  log('warn', 'return to sender needed (no return handler registered)', {
    paymentId: payment.id,
    ...info,
  });
};
let returnHook: ReturnNeededHook = logReturn;
/** Task 8 registers its `queueReturn`; null restores the logging default. */
export function onReturnNeeded(hook: ReturnNeededHook | null): void {
  returnHook = hook ?? logReturn;
}

async function returnNeeded(
  paymentId: string,
  info: { reason: ReturnReason; assetId: string; amount: string },
): Promise<void> {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) return;
  try {
    await returnHook(p, info);
  } catch (err) {
    log('error', 'return-to-sender hook failed', { paymentId, err: String(err) });
  }
}

// ─── polling ─────────────────────────────────────────────────────────────────

type QuoteRow = Quote;
type Loaded = { quote: QuoteRow; session: Session; ctx: ScopeContext };

/** Final for the watcher: nothing more will happen on this address. */
const DONE_PAYMENT = new Set(['SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'HELD']);

/**
 * A HELD payment is watched until its amounts are known (C40): until 1Click refunded it, or
 * swapped it (SUCCESS) and the verified transfer is claimed. Held at detection while 1Click is
 * still PROCESSING, it would otherwise never learn what reached the merchant account (the held
 * return would stay `amount_unknown`). Watching never settles, credits or un-holds anything: the
 * HELD branch of `advance` only records 1Click's facts, claims the transfer and queues the excess
 * (in review). The 24 h window still stops it.
 */
function watchHeld(p: Pick<Payment, 'status' | 'oneclickStatus'>, claimed: boolean): boolean {
  if (p.status !== 'HELD' || p.oneclickStatus === 'REFUNDED') return false;
  return !(p.oneclickStatus === 'SUCCESS' && claimed);
}

const isClaimed = async (paymentId: string) =>
  (await prisma.settlementClaim.count({ where: { paymentId } })) > 0;

export interface PollResult {
  depositAddress: string;
  outcome: PaymentOutcome | 'none';
  stopped: boolean;
}

/**
 * Polls one deposit address (the BullMQ job body): reads 1Click's status, records and advances
 * the address's payment, and schedules the next poll (or stops polling). `livemode` narrows the
 * lookup when the same address string exists in both modes.
 */
export async function pollDeposit(
  depositAddress: string,
  opts: { livemode?: boolean } = {},
): Promise<PollResult[]> {
  const quotes = await prisma.quote.findMany({
    where: { depositAddress, ...(opts.livemode !== undefined ? { livemode: opts.livemode } : {}) },
  });
  const out: PollResult[] = [];
  for (const q of quotes) out.push(await pollQuote(q));
  return out;
}

async function load(quoteId: string): Promise<Loaded | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { session: true },
  });
  if (!quote) return null;
  const { session, ...q } = quote;
  return { quote: q, session, ctx: { merchantId: q.merchantId, livemode: q.livemode } };
}

async function pollQuote(q0: QuoteRow): Promise<PollResult> {
  const now = deps.now();
  const result = (outcome: PollResult['outcome'], stopped: boolean): PollResult => ({
    depositAddress: q0.depositAddress,
    outcome,
    stopped,
  });
  if (q0.watchStoppedAt) return result('none', true);
  const existing = await prisma.payment.findFirst({ where: { quoteId: q0.id } });
  if (
    existing &&
    DONE_PAYMENT.has(existing.status) &&
    !(existing.status === 'HELD' && watchHeld(existing, await isClaimed(existing.id)))
  ) {
    await stopWatching(q0.id, now);
    return result('none', true);
  }
  if (now.getTime() >= q0.createdAt.getTime() + WATCH_MAX_MS) {
    await stopAfterWindow(q0.id, now);
    return result('none', true);
  }

  let status: StatusResponse;
  try {
    status = await deps.provider(q0.livemode).status(q0.depositAddress);
  } catch (err) {
    const notFound = err instanceof OneClickError && err.status === 404;
    log(notFound ? 'warn' : 'error', 'watcher: 1Click status failed', {
      depositAddress: q0.depositAddress,
      err: String(err),
    });
    await scheduleNext(q0, now, false);
    return result('none', false);
  }

  let outcome: PaymentOutcome | 'none' = 'none';
  let done = false;
  let payment = existing;
  if (!payment && depositSeen(status)) payment = await detect(q0, status);
  if (payment) {
    ({ outcome, done } = await advance(payment.id, status));
  } else if (q0.supersededAt && now.getTime() > q0.deadline.getTime() + SUPERSEDED_GRACE_MS) {
    done = true;
  }
  if (done) {
    await stopWatching(q0.id, now);
  } else {
    await scheduleNext(q0, now);
  }
  return result(outcome, done);
}

async function stopWatching(quoteId: string, now: Date): Promise<void> {
  await prisma.quote.updateMany({
    where: { id: quoteId, watchStoppedAt: null },
    data: { watchStoppedAt: now, watchNextAt: null, watchPolledAt: now },
  });
}

/** Records an ops event once per payment (`payment.verification_blocked` / `_timeout`). */
async function opsEventOnce(
  ctx: ScopeContext,
  paymentId: string,
  type: 'payment.verification_blocked' | 'payment.verification_timeout',
  payload: object,
): Promise<void> {
  await tenantTransaction(ctx, async (tx) => {
    await lockRow(tx, 'payments', paymentId);
    const seen = await tx.event.findFirst({
      where: { aggregateType: 'payment', aggregateId: paymentId, type },
      select: { id: true },
    });
    if (seen) return;
    await recordEvent(tx, ctx, { aggregateType: 'payment', aggregateId: paymentId, type, payload });
  });
  log('error', `OPS ALERT: ${type}`, { paymentId, ...payload });
}

/**
 * The 24 h window is over: polling stops. A payment 1Click reported SUCCESS for but whose
 * settlement transfer was never verified raises `payment.verification_timeout` for ops.
 */
async function stopAfterWindow(quoteId: string, now: Date): Promise<void> {
  await stopWatching(quoteId, now);
  const p = await prisma.payment.findFirst({ where: { quoteId } });
  if (
    p &&
    (p.status === 'PROCESSING' || p.status === 'SCREENING_PENDING') &&
    p.oneclickStatus === 'SUCCESS'
  ) {
    await opsEventOnce(
      { merchantId: p.merchantId, livemode: p.livemode },
      p.id,
      'payment.verification_timeout',
      {
        payment_id: p.id,
        session_id: p.sessionId,
        quote_id: quoteId,
      },
    );
  }
}

/** Sets the next poll; `polled` records a completed poll (not a failed 1Click call). */
async function scheduleNext(q: QuoteRow, now: Date, polled = true): Promise<void> {
  const fast = await viewedRecently(q.sessionId);
  await prisma.quote.updateMany({
    where: { id: q.id, watchStoppedAt: null },
    data: {
      watchNextAt: new Date(now.getTime() + (fast ? FAST_POLL_MS : SLOW_POLL_MS)),
      ...(polled ? { watchPolledAt: now } : {}),
    },
  });
}

/**
 * Scheduled every 5 s: claims every due, still-watched deposit address (lease POLL_LEASE_MS, so
 * overlapping scans and workers never poll one address twice at once) and hands it to `enqueue`
 * (the worker adds a `poll-deposit` job). Quotes past the 24 h window are stopped here. Returns
 * how many addresses were enqueued.
 */
export async function scanDueDeposits(
  enqueue: (job: { depositAddress: string; livemode: boolean }) => Promise<unknown>,
  now: Date = deps.now(),
): Promise<number> {
  const due = await prisma.quote.findMany({
    where: {
      watchStoppedAt: null,
      OR: [{ watchNextAt: null }, { watchNextAt: { lte: now } }],
    },
    orderBy: [{ watchNextAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: 500,
    select: { id: true, depositAddress: true, livemode: true, watchNextAt: true, createdAt: true },
  });
  let n = 0;
  for (const q of due) {
    if (now.getTime() >= q.createdAt.getTime() + WATCH_MAX_MS) {
      await stopAfterWindow(q.id, now);
      continue;
    }
    const claim = await prisma.quote.updateMany({
      where: { id: q.id, watchStoppedAt: null, watchNextAt: q.watchNextAt },
      data: { watchNextAt: new Date(now.getTime() + POLL_LEASE_MS) },
    });
    if (claim.count === 0) continue;
    try {
      await enqueue({ depositAddress: q.depositAddress, livemode: q.livemode });
      n++;
    } catch (err) {
      log('error', 'watcher: could not enqueue a poll', { quoteId: q.id, err: String(err) });
    }
  }
  return n;
}

// ─── detection ───────────────────────────────────────────────────────────────

async function chainOf(livemode: boolean, assetId: string): Promise<string> {
  try {
    return (await tokenInfo(livemode, assetId)).blockchain;
  } catch {
    return 'unknown';
  }
}

async function lockRow(tx: Prisma.TransactionClient, table: 'sessions' | 'payments', id: string) {
  if (table === 'sessions') {
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${id} FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${id} FOR UPDATE`;
  }
}

/**
 * First sight of a deposit to the address: creates its payment (DETECTED → PROCESSING, with
 * `payment.detected` + `payment.processing`), moves the session (PENDING_DEPOSIT → PROCESSING,
 * EXPIRED → LATE_DEPOSIT; any other status makes the payment late, `payment.late`), then screens
 * the sender. Returns null if another poll created it first.
 */
async function detect(q: QuoteRow, status: StatusResponse): Promise<Payment | null> {
  const ctx = { merchantId: q.merchantId, livemode: q.livemode };
  const chain = await chainOf(q.livemode, q.originAssetId);
  const origin = status.swapDetails.originChainTxHashes.map((h) => h.hash);
  const now = deps.now();
  let created: Payment | null;
  try {
    created = await tenantTransaction(ctx, async (tx) => {
      await lockRow(tx, 'sessions', q.sessionId);
      if (await tx.payment.findFirst({ where: { quoteId: q.id }, select: { id: true } })) {
        return null;
      }
      const s = await tx.session.findFirstOrThrow({
        where: { id: q.sessionId, merchantId: ctx.merchantId, livemode: ctx.livemode },
      });
      const late = s.status !== 'PENDING_DEPOSIT' && s.status !== 'PROCESSING';
      const p = await tx.payment.create({
        data: {
          id: newId('pay'),
          merchantId: ctx.merchantId,
          livemode: ctx.livemode,
          sessionId: q.sessionId,
          quoteId: q.id,
          originTxHash: origin[0] ?? q.depositTxHash ?? null,
          amountReceived: big(status.swapDetails.depositedAmount).toString(),
          isLate: late,
          senderChain: chain,
          oneclickStatus: status.status,
          amountInUsd: q.amountInUsd,
          createdAt: now,
        },
      });
      const base = {
        payment_id: p.id,
        session_id: s.id,
        external_ref: s.externalRef,
        quote_id: q.id,
        deposit_address: q.depositAddress,
        origin_asset: q.originAssetId,
        amount_received: p.amountReceived,
        origin_tx_hash: p.originTxHash,
      };
      await recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: p.id,
        type: 'payment.detected',
        payload: base,
      });
      await transitionPayment(tx, ctx, p.id, 'PROCESSING', { oneclick_status: status.status });
      await recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: p.id,
        type: 'payment.processing',
        payload: base,
      });
      // Confirmed shopper fee legs become revenue once the payment exists.
      await onQuotePaymentDetected(tx, ctx, q, p.id);
      if (s.status === 'PENDING_DEPOSIT') {
        await transitionSession(tx, ctx, s.id, 'PROCESSING', { payment_id: p.id });
      } else if (s.status === 'EXPIRED') {
        await transitionSession(tx, ctx, s.id, 'LATE_DEPOSIT', { payment_id: p.id });
      }
      if (late) {
        await recordEvent(tx, ctx, {
          aggregateType: 'payment',
          aggregateId: p.id,
          type: 'payment.late',
          payload: { ...base, session_status: s.status },
        });
      }
      return tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
  if (!created) return prisma.payment.findFirst({ where: { quoteId: q.id } });

  await syncSenders(created.id, q, status);
  return prisma.payment.findUnique({ where: { id: created.id } });
}

/** Statuses in which a newly found sender is screened (and a block holds the payment). */
const SCREENABLE = new Set(['DETECTED', 'PROCESSING', 'SCREENING_PENDING']);

/**
 * Resolves the senders of every origin transaction of the deposit not resolved yet (a top-up adds
 * one, possibly from another wallet), records them, and screens each new address — every
 * detected sender, connected wallets included; any `block` holds the payment. A transaction whose
 * senders cannot be read stays unresolved (and blocks settlement) until a later poll reads it.
 */
async function syncSenders(paymentId: string, q: QuoteRow, status: StatusResponse): Promise<void> {
  const ctx = { merchantId: q.merchantId, livemode: q.livemode };
  const p0 = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const hashes = status.swapDetails.originChainTxHashes.map((h) => h.hash);
  const pending = hashes.filter((h) => !p0.senderOriginHashes.includes(h));
  if (pending.length === 0) return;
  const chain = p0.senderChain ?? (await chainOf(q.livemode, q.originAssetId));
  // Test mode: the simulator names the sender of its latest deposit; live: read the chain.
  const found = status.swapDetails.senderAddress
    ? [status.swapDetails.senderAddress]
    : await deps.resolveSenders({
        livemode: q.livemode,
        chain,
        originAsset: q.originAssetId,
        depositAddress: q.depositAddress,
        originTxHashes: pending,
      });
  if (found.length === 0) {
    log('warn', 'watcher: deposit sender unknown; settlement waits for screening', {
      paymentId,
      chain,
      pending,
    });
    return;
  }
  const fresh = await tenantTransaction(ctx, async (tx) => {
    await lockRow(tx, 'payments', paymentId);
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const add = found.filter((a) => !p.senderAddresses.includes(a));
    await tx.payment.updateMany({
      where: { id: p.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
      data: {
        senderAddresses: [...p.senderAddresses, ...add],
        senderOriginHashes: [...new Set([...p.senderOriginHashes, ...pending])],
        senderAddress: p.senderAddress ?? found[0]!,
        senderChain: chain,
      },
    });
    return { add, status: p.status };
  });
  if (!SCREENABLE.has(fresh.status)) return;
  let blocked = false;
  for (const address of fresh.add) {
    const { decision } = await deps.screen(ctx, { sessionId: q.sessionId, address, chain });
    if (decision === 'block') blocked = true;
  }
  if (blocked) await tenantTransaction(ctx, (tx) => holdPaymentInTx(tx, ctx, paymentId));
}

// ─── advancing a payment ─────────────────────────────────────────────────────

/** The session's status as this payment sees it (closed sessions make the payment late). */
function sessionStatusFor(session: Session, payment: Payment): string {
  if (payment.isLate) return 'LATE';
  if (session.status === 'SCREENING_PENDING' && payment.status === 'SCREENING_PENDING') {
    return 'PROCESSING';
  }
  return session.status;
}

async function advance(
  paymentId: string,
  status: StatusResponse,
): Promise<{ outcome: PaymentOutcome; done: boolean }> {
  let payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const l = await load(payment.quoteId);
  if (!l) throw new Error(`quote ${payment.quoteId} vanished`);
  const { quote: q, session, ctx } = l;
  const sd = status.swapDetails;

  // Observed facts, whatever the state.
  await prisma.payment.updateMany({
    where: { id: payment.id },
    data: {
      oneclickStatus: status.status,
      ...(sd.depositedAmount !== undefined
        ? { amountReceived: big(sd.depositedAmount).toString() }
        : {}),
      ...(sd.refundedAmount !== undefined && big(sd.refundedAmount) > 0n
        ? { refundedAmount: big(sd.refundedAmount).toString() }
        : {}),
      ...(!payment.originTxHash && sd.originChainTxHashes[0]
        ? { originTxHash: sd.originChainTxHashes[0].hash }
        : {}),
    },
  });
  payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (SCREENABLE.has(payment.status)) {
    await syncSenders(payment.id, q, status);
    payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  }

  const outcome = classify(
    q,
    { status: sessionStatusFor(session, payment) },
    status,
    payment.createdAt,
  );
  if (payment.status === 'HELD') {
    // Held funds are never refunded by Tendr; 1Click may refund them to the shopper's address.
    if (status.status === 'REFUNDED' && q.refundType === 'ORIGIN_CHAIN') {
      await refund(l, payment, 'sanctions', status);
    }
    // A held SUCCESS: claim the verified transfer (M-3) so the held return is sized from it, and
    // queue the excess 1Click refunded into the account (M-2) — in review, like every return of
    // a sanctions-held payment (C40).
    let claimed = false;
    if (status.status === 'SUCCESS') {
      claimed = await claimHeld(l, payment, status);
      const excess = big(status.swapDetails.refundedAmount);
      if (excess > 0n && q.refundType !== 'ORIGIN_CHAIN') {
        await returnNeeded(payment.id, {
          reason: 'overpaid',
          assetId: q.originAssetId,
          amount: excess.toString(),
        });
      }
    }
    return { outcome, done: !watchHeld(payment, claimed) };
  }
  if (DONE_PAYMENT.has(payment.status)) return { outcome, done: true };
  if (payment.status === 'REFUNDING') {
    // A recorded refund is final here (returns via the store are Task 8's). Otherwise this is a
    // FAILED swap waiting for 1Click's own refund.
    if (payment.refundsRecorded.length > 0) return { outcome, done: true };
    if (status.status === 'REFUNDED') {
      await refund(l, payment, payment.isLate ? 'late' : 'failed', status);
      return { outcome, done: true };
    }
    return { outcome, done: payment.oneclickStatus !== 'FAILED' && status.status !== 'FAILED' };
  }

  switch (outcome) {
    case 'pending':
      return { outcome, done: false };
    case 'failed':
      await failed(l, payment);
      if (status.status === 'REFUNDED') {
        // A full deposit 1Click already refunded (M-1): record the refund now.
        payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
        await refund(l, payment, 'failed', status);
        return { outcome, done: true };
      }
      return { outcome, done: false };
    case 'underpaid':
      if (status.status === 'REFUNDED') {
        await refund(l, payment, 'underpaid', status);
        return { outcome, done: true };
      }
      if (!(deps.topupEnabled(ctx.livemode) && deps.now() < q.deadline)) {
        await reopen(l, payment, 'underpaid');
      }
      return { outcome, done: false };
    case 'late':
      return { outcome, done: await late(l, payment, status) };
    case 'settled':
    case 'overpaid':
      return { outcome, done: await trySettle(l, payment, status) };
  }
}

/** Underpaid with no top-up on offer: the session takes a new quote while 1Click refunds. */
async function reopen(l: Loaded, payment: Payment, reason: string): Promise<void> {
  const { session, ctx } = l;
  if (payment.isLate || session.status !== 'PROCESSING') return;
  if (session.expiresAt.getTime() <= deps.now().getTime()) return;
  await tenantTransaction(ctx, async (tx) => {
    await lockRow(tx, 'sessions', session.id);
    const s = await tx.session.findFirstOrThrow({
      where: { id: session.id },
      select: { status: true },
    });
    if (s.status !== 'PROCESSING' || (await otherInFlight(tx, session.id, payment.id))) return;
    await transitionSession(tx, ctx, session.id, 'PENDING_DEPOSIT', {
      reason,
      payment_id: payment.id,
    });
    await supersedeCurrentQuote(tx, ctx, session.id);
  });
}

/**
 * A reopened session never takes a second deposit at an address that already holds one (C34):
 * the current quote is superseded in the same locked transaction, so a retry always needs a fresh
 * quote and deposit address. The watcher keeps polling the superseded quote through its grace
 * period (the deposit already made there still finishes: refund, late, …).
 */
async function supersedeCurrentQuote(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  sessionId: string,
): Promise<void> {
  await tx.quote.updateMany({
    where: { merchantId: ctx.merchantId, livemode: ctx.livemode, sessionId, supersededAt: null },
    data: { supersededAt: deps.now() },
  });
}

/** 1Click's swap FAILED: the payment is REFUNDING until 1Click refunds; ops are alerted. */
async function failed(l: Loaded, payment: Payment): Promise<void> {
  const { session, ctx } = l;
  log('error', 'OPS ALERT: 1Click swap failed', {
    paymentId: payment.id,
    sessionId: session.id,
    depositAddress: l.quote.depositAddress,
  });
  if (payment.status !== 'PROCESSING' && payment.status !== 'DETECTED') return;
  await tenantTransaction(ctx, async (tx) => {
    await lockRow(tx, 'payments', payment.id);
    const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (p.status !== 'PROCESSING' && p.status !== 'DETECTED') return;
    await transitionPayment(tx, ctx, p.id, 'REFUNDING', { reason: 'failed' });
    await releaseSession(tx, ctx, session.id, p.id, { reopen: true });
  });
}

/**
 * The session no longer waits on this payment. A PROCESSING session with no other deposit in
 * flight goes back to PENDING_DEPOSIT (a new quote) only when `reopen` (an underpay retry or a
 * FAILED swap; Ruling C15 as amended) and it is unexpired; otherwise — late or sanctions refunds —
 * it is REFUNDED. LATE_DEPOSIT, and HELD / SCREENING_PENDING with nothing else open, become
 * REFUNDED.
 */
async function releaseSession(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  sessionId: string,
  paymentId: string,
  opts: { reopen: boolean },
): Promise<void> {
  await lockRow(tx, 'sessions', sessionId);
  const s = await tx.session.findFirstOrThrow({
    where: { id: sessionId, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (s.status === 'LATE_DEPOSIT') {
    await transitionSession(tx, ctx, s.id, 'REFUNDED', { payment_id: paymentId });
  } else if (
    (s.status === 'HELD' || s.status === 'SCREENING_PENDING') &&
    (await tx.payment.count({
      where: {
        sessionId: s.id,
        id: { not: paymentId },
        status: { in: ['DETECTED', 'PROCESSING', 'SCREENING_PENDING', 'HELD'] },
      },
    })) === 0
  ) {
    await transitionSession(tx, ctx, s.id, 'REFUNDED', { payment_id: paymentId });
  } else if (s.status === 'PROCESSING' && !(await otherInFlight(tx, s.id, paymentId))) {
    const unexpired = s.expiresAt.getTime() > deps.now().getTime();
    const reopen = opts.reopen && unexpired;
    await transitionSession(tx, ctx, s.id, reopen ? 'PENDING_DEPOSIT' : 'REFUNDED', {
      payment_id: paymentId,
    });
    if (reopen) await supersedeCurrentQuote(tx, ctx, s.id);
  }
}

/** Another payment of the session is still in flight (so the session waits on it). */
async function otherInFlight(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  sessionId: string,
  paymentId: string,
): Promise<boolean> {
  const n = await db.payment.count({
    where: {
      sessionId,
      id: { not: paymentId },
      isLate: false,
      status: { in: ['DETECTED', 'PROCESSING', 'SCREENING_PENDING'] },
    },
  });
  return n > 0;
}

async function markLateInTx(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  l: Loaded,
  p: Payment,
): Promise<void> {
  if (p.isLate) return;
  await tx.payment.updateMany({
    where: { id: p.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
    data: { isLate: true },
  });
  const s = await tx.session.findFirstOrThrow({
    where: { id: p.sessionId },
    select: { status: true, externalRef: true },
  });
  await recordEvent(tx, ctx, {
    aggregateType: 'payment',
    aggregateId: p.id,
    type: 'payment.late',
    payload: {
      payment_id: p.id,
      session_id: p.sessionId,
      external_ref: s.externalRef,
      quote_id: l.quote.id,
      session_status: s.status,
    },
  });
}

/**
 * 1Click refunded the deposit. Refunds to the shopper's own address (`ORIGIN_CHAIN`) are done →
 * REFUNDED. Refunds into the merchant's intents account (`INTENTS`) wait in REFUNDING for the
 * signer-approved return (Task 8, `onReturnNeeded`). `payment.refunded` carries the reason.
 */
async function refund(
  l: Loaded,
  payment: Payment,
  reason: ReturnReason,
  status: StatusResponse,
): Promise<void> {
  const { quote: q, ctx } = l;
  const direct = q.refundType === 'ORIGIN_CHAIN';
  const refunded =
    big(status.swapDetails.refundedAmount) || big(status.swapDetails.depositedAmount);
  const changed = await tenantTransaction(ctx, async (tx) => {
    await lockRow(tx, 'payments', payment.id);
    const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    // HELD / SCREENING_PENDING: only 1Click's own refund to the shopper's address moves them
    // (Tendr never refunds held funds; a store-path refund waits for the signers).
    const movable =
      ['PROCESSING', 'DETECTED', 'REFUNDING'].includes(p.status) ||
      (direct && (p.status === 'HELD' || p.status === 'SCREENING_PENDING'));
    if (!movable) {
      if (p.status === 'SCREENING_PENDING') {
        log('error', 'watcher: 1Click refunded a payment waiting on screening into the store', {
          paymentId: p.id,
        });
      }
      return false;
    }
    // Once per payment and reason: a second poll (or the sweeper) is a no-op.
    if (p.refundsRecorded.includes(reason)) return false;
    if (reason === 'late') await markLateInTx(tx, ctx, l, p);
    if (p.status !== 'REFUNDING') await transitionPayment(tx, ctx, p.id, 'REFUNDING', { reason });
    if (direct) await transitionPayment(tx, ctx, p.id, 'REFUNDED', { reason });
    await tx.payment.updateMany({
      where: { id: p.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
      data: {
        refundedAmount: refunded.toString(),
        refundsRecorded: [...p.refundsRecorded, reason],
      },
    });
    const s = await tx.session.findFirstOrThrow({
      where: { id: p.sessionId },
      select: { externalRef: true },
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'payment',
      aggregateId: p.id,
      type: 'payment.refunded',
      payload: {
        payment_id: p.id,
        session_id: p.sessionId,
        external_ref: s.externalRef,
        reason,
        refunded_amount: refunded.toString(),
        asset: q.originAssetId,
        refund_via: direct ? 'origin_chain' : 'store',
        refund_reason: status.swapDetails.refundReason ?? null,
      },
    });
    await releaseSession(tx, ctx, p.sessionId, p.id, {
      reopen: reason === 'underpaid' || reason === 'failed',
    });
    return true;
  });
  if (changed && !direct && refunded > 0n) {
    await returnNeeded(payment.id, {
      reason,
      assetId: q.originAssetId,
      amount: refunded.toString(),
    });
  }
}

/**
 * A late deposit: never `succeeded`. 1Click refunded it → refund (reason late). 1Click swapped it
 * into the merchant account (a deposit after expiry, or a second payment into a settled session)
 * → once the transfer is verified, REFUNDING and returned to the sender. Returns true when done.
 */
async function late(l: Loaded, payment: Payment, status: StatusResponse): Promise<boolean> {
  const { quote: q, session, ctx } = l;
  if (!payment.isLate) {
    await tenantTransaction(ctx, async (tx) => {
      await lockRow(tx, 'payments', payment.id);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      await markLateInTx(tx, ctx, l, p);
    });
    payment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }
  if (status.status === 'REFUNDED') {
    await refund(l, payment, 'late', status);
    return true;
  }
  if (status.status === 'FAILED') {
    await failed(l, payment);
    return false;
  }
  if (status.status !== 'SUCCESS') return false;
  const v = await verifyOrReport(l, payment, status);
  if (!v) return false;
  const amountOut = big(status.swapDetails.amountOut) || toBig(q.amountOut);
  let changed: boolean;
  try {
    changed = await tenantTransaction(ctx, async (tx) => {
      await lockRow(tx, 'payments', payment.id);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (p.status !== 'PROCESSING' && p.status !== 'DETECTED') return false;
      // The late transfer is claimed too: one event is returned (or settles) once.
      await claimInTx(tx, ctx, p.id, v);
      await transitionPayment(tx, ctx, p.id, 'REFUNDING', { reason: 'late' });
      await tx.payment.updateMany({
        where: { id: p.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
        data: { amountOut: amountOut.toString() },
      });
      // A LATE_DEPOSIT session stays so until the return completes (Task 8).
      return true;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
  if (changed) {
    await returnNeeded(payment.id, {
      reason: 'late',
      assetId: session.destAsset,
      amount: amountOut.toString(),
    });
    // An overpaid late deposit: 1Click refunded the excess into the merchant account too (an
    // INTENTS refund). It goes back as its own `overpaid` return, in the origin asset (M-2);
    // queued once per (payment, reason), screened before drafting like every return.
    const excess = big(status.swapDetails.refundedAmount);
    if (excess > 0n && q.refundType !== 'ORIGIN_CHAIN') {
      await returnNeeded(payment.id, {
        reason: 'overpaid',
        assetId: q.originAssetId,
        amount: excess.toString(),
      });
    }
  }
  return true;
}

// ─── settlement ──────────────────────────────────────────────────────────────

export interface Verification {
  txHash: string;
  verifiedBy: 'receipt' | 'oneclick';
  /** The claimed transfer event (`oneclick`: no receipt, one claim per destination tx). */
  receiptId: string;
  eventKey: string;
  amount: bigint;
}

/** `ok`: an unclaimed matching event; `blocked`: the only matching events are already claimed. */
export type VerifyResult = { ok: Verification } | { blocked: string[] } | null;

function intentsContractFor(livemode: boolean): string {
  return livemode ? env().INTENTS_CONTRACT_LIVE : env().INTENTS_CONTRACT_TEST;
}

/** Destination chains with a transfer verifier for wallet payouts (NEP-141 on NEAR). */
const WALLET_VERIFIED_CHAINS = new Set(['near']);

/** Whether this (tx, receipt, event) is claimed by a payment other than `paymentId`. */
async function claimedByOther(
  livemode: boolean,
  c: { txHash: string; receiptId: string; eventKey: string },
  paymentId: string,
): Promise<boolean> {
  const row = await prisma.settlementClaim.findFirst({
    where: { livemode, txHash: c.txHash, receiptId: c.receiptId, eventKey: c.eventKey },
    select: { paymentId: true },
  });
  return row !== null && row.paymentId !== paymentId;
}

/** Records the claim of a transfer event for a payment; a lost race is P2002. */
async function claimInTx(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  paymentId: string,
  v: Verification,
): Promise<void> {
  const mine = await tx.settlementClaim.findFirst({ where: { paymentId } });
  if (mine) {
    if (
      mine.txHash === v.txHash &&
      mine.receiptId === v.receiptId &&
      mine.eventKey === v.eventKey
    ) {
      return;
    }
    throw new Error(`payment ${paymentId} already claimed another transfer`);
  }
  await tx.settlementClaim.create({
    data: {
      id: newId('scl'),
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      paymentId,
      txHash: v.txHash,
      receiptId: v.receiptId,
      eventKey: v.eventKey,
      amount: v.amount.toString(),
    },
  });
}

/**
 * A destination tx as the chain reports it. Test mode falls back to the simulated provider, which
 * answers only for its own settlement hashes (it credits the merchant through the mock verifier,
 * then reports a synthetic hash no chain knows): with the deployed rpc driver testnet answers
 * UNKNOWN_TRANSACTION (null) for that hash, so without the fallback test mode could never settle
 * (I-2). Live mode reads only the chain: the simulator can never verify a live payment.
 */
async function destinationTxStatus(
  livemode: boolean,
  hash: string,
  route: string,
): Promise<TxStatusResult | null> {
  if (livemode) return deps.near(true).txStatus(hash, route);
  let chainErr: unknown = null;
  try {
    const tx = await deps.near(false).txStatus(hash, route);
    if (tx) return tx;
  } catch (err) {
    chainErr = err;
  }
  const simulated = await deps.simulatedTx(hash);
  if (simulated) return simulated;
  if (chainErr) throw chainErr;
  return null;
}

/**
 * Per-transfer verification of a `SUCCESS` (never balance deltas): an event in one of 1Click's
 * destination transactions crediting at least the quote's `amount_out` of the settlement asset to
 * the session's recipient, not claimed by another payment. Among several the smallest sufficient
 * one is taken (batched settlements: each payment takes its own event).
 */
export async function verify(
  l: Loaded,
  payment: Payment,
  status: StatusResponse,
): Promise<VerifyResult> {
  const { quote: q, session, ctx } = l;
  const required = toBig(q.amountOut);
  const hashes = status.swapDetails.destinationChainTxHashes.map((h) => h.hash);
  const blocked: string[] = [];
  const viaReceipts = async (opts: { intentsContract?: string; route: string }) => {
    for (const hash of hashes) {
      let tx: TxStatusResult | null;
      try {
        tx = await destinationTxStatus(ctx.livemode, hash, opts.route);
      } catch (err) {
        log('warn', 'watcher: destination tx lookup failed', { hash, err: String(err) });
        continue;
      }
      if (!tx) continue;
      const credits = matchingCredits(tx.receipts, {
        assetId: session.destAsset,
        receiver: session.recipient,
        ...(opts.intentsContract ? { intentsContract: opts.intentsContract } : {}),
      })
        .filter((c) => c.amount >= required)
        .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
      for (const c of credits) {
        const claim = { txHash: hash, receiptId: c.receiptId, eventKey: c.eventKey };
        if (await claimedByOther(ctx.livemode, claim, payment.id)) {
          blocked.push(`${hash}/${c.receiptId}/${c.eventKey}`);
          continue;
        }
        return { ok: { ...claim, verifiedBy: 'receipt' as const, amount: c.amount } };
      }
    }
    return blocked.length > 0 ? { blocked } : null;
  };

  if (session.recipientType === 'INTENTS') {
    const intents = intentsContractFor(ctx.livemode);
    return viaReceipts({ intentsContract: intents, route: intents });
  }
  if (WALLET_VERIFIED_CHAINS.has(session.destChain.toLowerCase())) {
    if (!session.destAsset.startsWith('nep141:')) return null;
    return viaReceipts({ route: session.destAsset.slice('nep141:'.length) });
  }
  // No verifier for this payout chain: 1Click's amountOut and destination tx hash (one claim per
  // destination tx).
  const out = big(status.swapDetails.amountOut);
  const hash = hashes[0];
  if (!hash || out < required) return null;
  const claim = { txHash: hash, receiptId: '', eventKey: 'oneclick' };
  if (await claimedByOther(ctx.livemode, claim, payment.id)) return { blocked: [hash] };
  return { ok: { ...claim, verifiedBy: 'oneclick', amount: out } };
}

/**
 * `verify`, raising `payment.verification_blocked` (once) for ops when 1Click reports SUCCESS but
 * the only matching transfer events already settle other payments. Null unless verified.
 */
async function verifyOrReport(
  l: Loaded,
  payment: Payment,
  status: StatusResponse,
): Promise<Verification | null> {
  const r = await verify(l, payment, status);
  if (r && 'ok' in r) return r.ok;
  if (r && 'blocked' in r) {
    await opsEventOnce(l.ctx, payment.id, 'payment.verification_blocked', {
      payment_id: payment.id,
      session_id: payment.sessionId,
      quote_id: l.quote.id,
      claimed_events: r.blocked,
    });
  }
  return null;
}

/**
 * The sanctions decision for the deposit: every origin transaction's senders must be known (a
 * top-up's too) and every sender screened at or after detection; any block blocks, anything
 * unknown or unavailable is unavailable.
 */
async function senderDecision(
  l: Loaded,
  payment: Payment,
  status: StatusResponse,
): Promise<ScreeningOutcome> {
  const { ctx } = l;
  const hashes = status.swapDetails.originChainTxHashes.map((h) => h.hash);
  if (hashes.some((h) => !payment.senderOriginHashes.includes(h))) return 'unavailable';
  const senders = paymentSenders(payment);
  if (senders.length === 0) return 'unavailable';
  const decisions: ScreeningOutcome[] = [];
  for (const address of senders) {
    const row = await prisma.screeningResult.findFirst({
      where: {
        sessionId: payment.sessionId,
        merchantId: ctx.merchantId,
        livemode: ctx.livemode,
        address,
        createdAt: { gte: payment.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      select: { decision: true },
    });
    if (row) {
      decisions.push(row.decision);
    } else if (payment.status === 'SCREENING_PENDING') {
      // A SCREENING_PENDING payment is re-screened by screening.ts's retries, not every poll.
      decisions.push('unavailable');
    } else {
      const { decision } = await deps.screen(ctx, {
        sessionId: payment.sessionId,
        address,
        chain: payment.senderChain ?? 'unknown',
      });
      decisions.push(decision);
    }
  }
  return combineDecisions(decisions);
}

/**
 * A HELD payment whose swap 1Click reports SUCCESS: claims its verified transfer event (once), so
 * `heldAmount` sizes the return from what verifiably reached the account (C21, M-3). An event
 * another payment already claimed is left alone (`verify` reports it blocked).
 */
async function claimHeld(l: Loaded, payment: Payment, status: StatusResponse): Promise<boolean> {
  const { ctx } = l;
  if (await isClaimed(payment.id)) return true;
  const r = await verify(l, payment, status);
  if (!r || !('ok' in r)) return false;
  try {
    await tenantTransaction(ctx, async (tx) => {
      await lockRow(tx, 'payments', payment.id);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (p.status === 'HELD') await claimInTx(tx, ctx, p.id, r.ok);
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
  return isClaimed(payment.id);
}

/** SUCCESS: verify the transfer, gate on screening, settle. Returns true when done. */
async function trySettle(l: Loaded, payment: Payment, status: StatusResponse): Promise<boolean> {
  const { ctx, session } = l;
  const v = await verifyOrReport(l, payment, status);
  if (!v) return false;
  const decision = await senderDecision(l, payment, status);
  if (decision === 'block') {
    // The verified transfer is claimed with the hold (M-3), so the held return is sized from the
    // verified delivered amount (heldAmount reads the claim), never 1Click's reported number.
    try {
      await tenantTransaction(ctx, async (tx) => {
        await lockRow(tx, 'payments', payment.id);
        const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
        if (SCREENABLE.has(p.status)) await claimInTx(tx, ctx, p.id, v);
        await holdPaymentInTx(tx, ctx, payment.id);
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // The event is another payment's: hold anyway (the sender is sanctioned), unclaimed.
      await tenantTransaction(ctx, (tx) => holdPaymentInTx(tx, ctx, payment.id));
    }
    return true;
  }
  if (decision === 'unavailable') {
    if (payment.status === 'PROCESSING' || payment.status === 'DETECTED') {
      await tenantTransaction(ctx, async (tx) => {
        await lockRow(tx, 'payments', payment.id);
        const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
        if (p.status !== 'PROCESSING') return;
        await transitionPayment(tx, ctx, p.id, 'SCREENING_PENDING', {
          reason: 'screening_unavailable',
        });
        await lockRow(tx, 'sessions', session.id);
        const s = await tx.session.findFirstOrThrow({
          where: { id: session.id },
          select: { status: true },
        });
        if (s.status === 'PROCESSING') {
          await transitionSession(tx, ctx, session.id, 'SCREENING_PENDING', { payment_id: p.id });
        }
      });
    }
    return false;
  }
  const r = await settle(l, payment, status, v);
  if (r === 'late') return late(l, payment, status);
  return r !== 'unverified';
}

type SettleResult = 'settled' | 'noop' | 'late' | 'unverified';

/** Settles in one transaction: payment + session SETTLED, revenue rows, `payment.succeeded`. */
async function settle(
  l: Loaded,
  payment: Payment,
  status: StatusResponse,
  v: Verification,
): Promise<SettleResult> {
  const { quote: q, ctx } = l;
  const sd = status.swapDetails;
  const refunded = big(sd.refundedAmount);
  const overpaid = refunded > 0n;
  // 1Click returns an excess straight to an ORIGIN_CHAIN refund address; an INTENTS refund lands
  // in the merchant account, where a return worth under SMALL_OVERPAY_USD NET of the estimated
  // return fee is kept — decided here with the return path's own arithmetic (return-fee.ts), so
  // the first payment.succeeded already carries the right kept_small_overpayment (M-8).
  const viaStore = q.refundType !== 'ORIGIN_CHAIN';
  const keptSmall =
    overpaid &&
    viaStore &&
    !!payment.senderAddress &&
    !!payment.senderChain &&
    (await keptSmallNetOfFee(ctx.livemode, q.originAssetId, refunded, payment.senderChain, q)) ===
      true;
  const needsReturn = overpaid && viaStore && !keptSmall;
  const amountOut = big(sd.amountOut) || toBig(q.amountOut);

  let result: SettleResult;
  try {
    result = await tenantTransaction(ctx, async (tx) => {
      await lockRow(tx, 'payments', payment.id);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (!['PROCESSING', 'DETECTED', 'SCREENING_PENDING'].includes(p.status)) return 'noop';
      await lockRow(tx, 'sessions', p.sessionId);
      const s = await tx.session.findFirstOrThrow({
        where: { id: p.sessionId, merchantId: ctx.merchantId, livemode: ctx.livemode },
      });
      if (p.isLate || !['PROCESSING', 'SCREENING_PENDING', 'PENDING_DEPOSIT'].includes(s.status)) {
        return 'late';
      }
      await claimInTx(tx, ctx, p.id, v);
      const now = deps.now();
      await transitionPayment(tx, ctx, p.id, 'SETTLED', { settle_tx: v.txHash });
      await tx.payment.updateMany({
        where: { id: p.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
        data: {
          settleTx: v.txHash,
          verifiedBy: v.verifiedBy,
          amountOut: amountOut.toString(),
          amountInUsd: q.amountInUsd,
          settledAt: now,
          overpaidAmount: overpaid ? refunded.toString() : null,
          refundedAmount: overpaid ? refunded.toString() : p.refundedAmount,
          keptSmallOverpayment: keptSmall,
          // Per reason (C40): only the overpaid return is decided here.
          keptSmallReasons: keptSmall
            ? [...new Set([...p.keptSmallReasons, 'overpaid'])]
            : p.keptSmallReasons,
        },
      });
      if (s.status === 'PENDING_DEPOSIT') {
        await transitionSession(tx, ctx, s.id, 'PROCESSING', { payment_id: p.id });
      }
      await transitionSession(tx, ctx, s.id, 'SETTLED', { payment_id: p.id });
      await recordRevenue(tx, ctx, p.id);
      // The proceeds are collected here: a held gas sponsorship is charged at its estimate.
      await onPaymentCollected(tx, ctx, q, p.id);
      await recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: p.id,
        type: 'payment.succeeded',
        payload: {
          payment_id: p.id,
          session_id: s.id,
          external_ref: s.externalRef,
          quote_id: q.id,
          origin_asset: q.originAssetId,
          amount_in: q.amountIn,
          amount_out: amountOut.toString(),
          settlement_asset: s.destAsset,
          settle_tx: v.txHash,
          verified_by: v.verifiedBy,
          overpaid_amount: overpaid ? refunded.toString() : null,
          kept_small_overpayment: keptSmall,
          network_fee: networkFeeView(q),
        },
      });
      return 'settled';
    });
  } catch (err) {
    // The unique claim per (tx, receipt, event): another payment claimed this event first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return 'unverified';
    }
    throw err;
  }
  if (result === 'settled' && needsReturn) {
    await returnNeeded(payment.id, {
      reason: 'overpaid',
      assetId: q.originAssetId,
      amount: refunded.toString(),
    });
  }
  return result;
}

/**
 * The screening `allow` hook (screening.ts retries): re-runs this settlement path for the
 * payment's address. A settled payment is a no-op; if the transfer is not verified yet the
 * payment stays SCREENING_PENDING and the next poll settles it.
 */
export async function settleAfterScreening(paymentId: string, ctx: ScopeContext): Promise<void> {
  const p = await prisma.payment.findFirst({
    where: { id: paymentId, merchantId: ctx.merchantId, livemode: ctx.livemode },
    include: { quote: true },
  });
  if (!p || p.status !== 'SCREENING_PENDING') return;
  let status: StatusResponse;
  try {
    status = await deps.provider(ctx.livemode).status(p.quote.depositAddress);
  } catch (err) {
    log('warn', 'screening allowed: 1Click status failed; the next poll settles', {
      paymentId,
      err: String(err),
    });
    return;
  }
  await advance(p.id, status);
}

/** Wires the screening `allow` hook (call once per process; worker and tests). */
export function registerWatcherHooks(): void {
  onScreeningAllowed(settleAfterScreening);
}

// ─── session expiry ──────────────────────────────────────────────────────────

/**
 * Scheduled every minute (Ruling C9): PENDING_DEPOSIT sessions past `expires_at` with no deposit
 * in flight → EXPIRED (`timeout`) + `checkout.session.expired`. Each session's watched addresses
 * must have been polled after the expiry first (the sweep polls a due one itself, under the
 * scan's lease, never alongside a running poll), so a deposit made before expiry is attributed,
 * not turned late. A deposit is in flight while a payment is DETECTED / PROCESSING /
 * SCREENING_PENDING, or a reported deposit tx has no payment yet and its quote deadline plus
 * SUPERSEDED_GRACE_MS has not passed. Returns how many sessions expired.
 */
export async function expireSessions(now: Date = deps.now()): Promise<number> {
  const due = await prisma.session.findMany({
    where: { status: 'PENDING_DEPOSIT', expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: 200,
  });
  let expired = 0;
  for (const s of due) {
    try {
      const quotes = await prisma.quote.findMany({
        where: { sessionId: s.id, watchStoppedAt: null },
      });
      // Every watched address must have been polled after the session expired. One that was not
      // is polled here, but only if it is due (never under a running poll's lease); otherwise
      // the next sweep decides.
      let waiting = false;
      for (const q of quotes) {
        if (q.watchPolledAt && q.watchPolledAt >= s.expiresAt) continue;
        const due = q.watchNextAt === null || q.watchNextAt <= now;
        const claim = due
          ? await prisma.quote.updateMany({
              where: { id: q.id, watchStoppedAt: null, watchNextAt: q.watchNextAt },
              data: { watchNextAt: new Date(now.getTime() + POLL_LEASE_MS) },
            })
          : { count: 0 };
        if (claim.count === 0) {
          waiting = true;
          continue;
        }
        await pollQuote(q);
      }
      if (waiting) continue;
      // The shared in-flight test (in-flight.ts), also used by createSession and the store's
      // /expire: a payment in flight, a reported deposit inside its deadline plus the grace, or
      // a watched address still not polled after the expiry (e.g. its poll just failed).
      if (await depositInFlight(prisma, s, now)) continue;
      const ctx = { merchantId: s.merchantId, livemode: s.livemode };
      const did = await tenantTransaction(ctx, async (tx) => {
        await lockRow(tx, 'sessions', s.id);
        const cur = await tx.session.findFirstOrThrow({
          where: { id: s.id },
          select: { status: true },
        });
        if (cur.status !== 'PENDING_DEPOSIT') return false;
        await expireInTx(tx, ctx, s.id, s.externalRef, 'timeout');
        return true;
      });
      if (did) expired++;
    } catch (err) {
      log('error', 'session expiry failed', { sessionId: s.id, err: String(err) });
    }
  }
  return expired;
}
