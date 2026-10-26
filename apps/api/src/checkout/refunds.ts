// Returning money to senders (spec §6, "Decided by the user after the builder check" return costs,
// "Changes after external plan review" #3 and #6; Rulings C2, C3).
//
// Money that 1Click refunded into the merchant's intents account (`refundType INTENTS`: a manual
// send without a refund address), or a late deposit 1Click swapped into it, goes back to the
// sender through a project 2 `refund` proposal that a signer approves. Tendr only drafts it.
//
// - `queueReturn` (the watcher's `onReturnNeeded` hook): the estimated cross-chain return fee
//   (gas-estimates.ts) is deducted; a net worth under SMALL_OVERPAY_USD is kept by the merchant
//   (`kept_small_overpayment`, no signer). A known exchange sender (exchanges.ts) is held as
//   `needs_address` (`refund.needs_address`, the shopper is emailed or the checkout asks). Any
//   other sender gets a refund row and a `refund` draft (`refund.pending`).
// - Durable and idempotent: one refund row per (payment, reason) (unique index). The hook runs
//   after the watcher's commit, so `sweepReturns` (every minute) re-queues any return the hook
//   missed and retries drafts that could not be made yet (screening unavailable, account busy).
// - Never a draft to a sanctioned address: the destination is screened right before drafting; a
//   block leaves no draft, marks the refund failed with `review_reason = sanctions` and records
//   `payment.held` (once). A held payment's return also needs `acknowledged_legal_at` (Task 10).
// - Routes mirror the contract: a NEAR destination is a plain `ft_withdraw` (Poa route with the
//   asset's own token contract); another chain needs a PoA bridge token of that chain. Anything
//   else would need a Swap route through a 1Click INTENTS-deposit quote, which the provider seam
//   does not offer, so it is marked `review_reason = needs_swap_route` for a person.
// - 1Click refunds to an `ORIGIN_CHAIN` refund address (connected wallet, or a manual send with a
//   refund address) are only recorded (status confirmed, no proposal): 1Click already sent them.
// - `account.proposal.executed` on a refund proposal → refund `confirmed`, `refund.sent`, and the
//   payment (and a late / held session) completes as REFUNDED.
// - A refund proposal that ends without executing (rejected, expired, failed on chain) sends the
//   return back to review (`refund.needs_review`, internal) and records the public
//   `refund.cancelled` / `refund.failed` once per (refund, proposal) — see `recordRefundOutcome`.
import {
  Prisma,
  type AccountProposal,
  type Event,
  type Payment,
  type Quote,
  type Refund,
  type Session,
} from '@prisma/client';
import { SMALL_OVERPAY_USD } from '@tendr/contracts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  applyProposalView,
  createSystemDraftInTx,
  RELAY_CLAIM_LEASE_MS,
  SUPPORTED_CHAINS,
  type ContractProposalView,
} from '../accounts/proposals.js';
import { getBalances } from '../accounts/accounts.js';
import { nearClient } from '../near/client.js';
import {
  poaRouteError,
  poaTokenOf,
  POA_CHAIN_PREFIXES,
  type WithdrawRoute,
} from '../accounts/encoding.js';
import { AccountEventTypes } from '../accounts/watcher.js';
import { getMailer } from '../auth/mailer.js';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import { transitionPayment, transitionSession } from '../events/transitions.js';
import { env } from '../env.js';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { registerEventHandler, handlerNamesFor } from '../jobs/handlers.js';
import { isValidAddress } from './address-format.js';
import { isExchangeAddress } from './exchanges.js';
import { gasEstimateUsd } from './gas-estimates.js';
import { grossUpForReturnFee, netOfReturnFee, usdPerUnit } from './return-fee.js';
import { HOLD_NOTICE } from './hold.js';
import { screenAddress, type ScreeningOutcome } from './screening.js';
import type { ShopperCtx } from './quotes.js';
import { providerFor, type StatusResponse } from './oneclick/index.js';
import { tokenInfo } from './tokens.js';
import { onReturnNeeded, type ReturnReason } from './watcher.js';

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export type ReturnInfo = { reason: ReturnReason; assetId: string; amount: string };

/** Review reasons: the return needs a person before it can be drafted. */
export const REVIEW = {
  sanctions: 'sanctions',
  needsSwapRoute: 'needs_swap_route',
  priceUnavailable: 'price_unavailable',
  noSender: 'no_sender',
  unsupportedChain: 'unsupported_chain',
  draftRejected: 'draft_rejected',
  transferFailed: 'transfer_failed',
  proposalCancelled: 'proposal_cancelled',
  proposalExpired: 'proposal_expired',
  amountUnknown: 'amount_unknown',
  /** Re-netted for a new destination in the review queue, the return fell under SMALL_OVERPAY_USD. */
  keptSmall: 'kept_small',
  /** A merchant refund the store cancelled before any proposal existed (terminal, W14). */
  storeCancelled: 'store_cancelled',
} as const;

// ─── dependencies ────────────────────────────────────────────────────────────

export interface RefundDeps {
  screen(
    ctx: ScopeContext,
    input: { sessionId: string; address: string; chain: string },
  ): Promise<{ decision: ScreeningOutcome }>;
}
const DEFAULT_DEPS: RefundDeps = { screen: screenAddress };
let deps: RefundDeps = DEFAULT_DEPS;
/** Test hook: overrides some dependencies; null restores the defaults. */
export function setRefundDeps(overrides: Partial<RefundDeps> | null): void {
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

/** Sanctions-screens a return destination (the same seam `draftReturn` uses). */
export function screenDestination(
  ctx: ScopeContext,
  input: { sessionId: string; address: string; chain: string },
): Promise<{ decision: ScreeningOutcome }> {
  return deps.screen(ctx, input);
}

// ─── chains and routes ───────────────────────────────────────────────────────

/** Contract chain names (proposals' SUPPORTED_CHAINS) → 1Click `blockchain` ids where they differ. */
const ONECLICK_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(POA_CHAIN_PREFIXES)
    .filter(([prefix, chain]) => prefix !== chain)
    .map(([prefix, chain]) => [chain, prefix]),
);

/** The contract's chain name for a 1Click `blockchain` id (or a contract name); null if unsupported. */
export function contractChainOf(chain: string): string | null {
  const c = chain.toLowerCase();
  const mapped = Object.hasOwn(POA_CHAIN_PREFIXES, c) ? POA_CHAIN_PREFIXES[c]! : c;
  return SUPPORTED_CHAINS.includes(mapped) ? mapped : null;
}

/** The 1Click `blockchain` id for a contract chain name (address formats, gas estimates). */
export function oneclickChainOf(contractChain: string): string {
  return Object.hasOwn(ONECLICK_OF, contractChain) ? ONECLICK_OF[contractChain]! : contractChain;
}

/**
 * The route that returns `asset` to `address` on `chain` (a contract chain name) by a PoA
 * `ft_withdraw`, or null when there is none (a Swap route would be needed). Checked with the
 * same rules the contract applies (`poaRouteError`).
 */
export function returnRoute(asset: string, chain: string, address: string): WithdrawRoute | null {
  const token = poaTokenOf(asset);
  if (!token) return null;
  const route: WithdrawRoute = { poa: { token_contract: token } };
  return poaRouteError(asset, route, chain, address) ? null : route;
}

/** Contract chains `asset` can be returned to directly: `near`, plus its PoA bridge's chain. */
export function returnChainsOf(asset: string): string[] {
  const token = poaTokenOf(asset);
  if (!token) return [];
  const label = token.endsWith('.omft.near') ? (token.split(/[-.]/)[0] ?? '') : '';
  const bridged = Object.hasOwn(POA_CHAIN_PREFIXES, label) ? POA_CHAIN_PREFIXES[label] : null;
  return bridged ? ['near', bridged] : ['near'];
}

// ─── amounts ─────────────────────────────────────────────────────────────────

export { netOfReturnFee, usdPerUnit } from './return-fee.js';

// ─── queueing ────────────────────────────────────────────────────────────────

const tenantOf = (ctx: ScopeContext) => ({ merchantId: ctx.merchantId, livemode: ctx.livemode });

export async function lockPayment(tx: Tx, ctx: ScopeContext, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${id} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
}
export async function lockRefund(tx: Tx, ctx: ScopeContext, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${id} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Inserts a refund row; an existing row for the same (payment, reason) wins. Returns the row. */
async function insertRefund(
  ctx: ScopeContext,
  data: Omit<Prisma.RefundUncheckedCreateInput, 'id' | 'merchantId' | 'livemode'> & {
    paymentId: string;
    reason: ReturnReason;
  },
  inTx?: (tx: Tx, refund: Refund) => Promise<void>,
): Promise<{ refund: Refund; created: boolean }> {
  try {
    const refund = await tenantTransaction(ctx, async (tx) => {
      const row = await tx.refund.create({
        data: { id: newId('ref'), ...tenantOf(ctx), ...data },
      });
      if (inTx) await inTx(tx, row);
      return row;
    });
    return { refund, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const refund = await prisma.refund.findFirstOrThrow({
      where: { paymentId: data.paymentId, reason: data.reason, ...tenantOf(ctx) },
    });
    return { refund, created: false };
  }
}

/** Whether the money was returned by 1Click itself (to an ORIGIN_CHAIN refund address). */
function refundedDirectly(q: Pick<Quote, 'refundType'>, p: Payment, reason: ReturnReason) {
  return (
    q.refundType === 'ORIGIN_CHAIN' && (p.refundsRecorded.includes(reason) || reason === 'overpaid')
  );
}

/**
 * Queues the return of `info.amount` of `info.assetId` (now in the merchant account) to the
 * payment's sender. Idempotent per (payment, reason); safe to call again (the sweeper does).
 */
export async function queueReturn(
  ctx: ScopeContext,
  payment: Payment,
  info: ReturnInfo,
): Promise<Refund | null> {
  const p = await prisma.payment.findFirst({ where: { id: payment.id, ...tenantOf(ctx) } });
  if (!p) throw notFound('Payment not found');
  const q = await prisma.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
  if (refundedDirectly(q, p, info.reason)) {
    return recordDirectRefund(ctx, p, q, info.reason, info.amount);
  }
  const existing = await prisma.refund.findFirst({
    where: { paymentId: p.id, reason: info.reason, ...tenantOf(ctx) },
  });
  if (existing) return draftIfReady(ctx, existing.id);
  // Kept small is per reason (C40): keeping one return never keeps another.
  if (p.keptSmallReasons.includes(info.reason)) return null;

  const amount = BigInt(info.amount);
  if (amount <= 0n) return null;
  const sender = p.senderAddress;
  const senderChain = p.senderChain;
  const base = { paymentId: p.id, reason: info.reason, assetId: info.assetId } as const;
  if (!sender || !senderChain) {
    const { refund } = await insertRefund(ctx, {
      ...base,
      amount: amount.toString(),
      reviewReason: REVIEW.noSender,
    });
    log('warn', 'return to sender needs review: no sender', { refundId: refund.id });
    return refund;
  }
  const perUnit = await usdPerUnit(ctx.livemode, info.assetId, q);
  if (!perUnit) {
    const { refund } = await insertRefund(ctx, {
      ...base,
      amount: amount.toString(),
      reviewReason: REVIEW.priceUnavailable,
    });
    log('warn', 'return to sender needs review: no price', { refundId: refund.id });
    return refund;
  }
  const { fee, net, netUsd } = netOfReturnFee(amount, perUnit, D(gasEstimateUsd(senderChain)));
  if (net <= 0n || netUsd.lt(SMALL_OVERPAY_USD)) {
    await keepSmall(ctx, p.id, info.reason);
    return null;
  }

  const chain = contractChainOf(senderChain);
  // A sanctions-held payment's funds (its excess included) never go back by themselves (C40):
  // the row waits in the review queue for the owner's legal acknowledgement and a merchant-given,
  // screened destination that is not the sender (`refundFromReview`).
  if (p.heldReason === 'sanctions') {
    const { refund } = await insertRefund(ctx, {
      ...base,
      amount: net.toString(),
      returnFee: fee.toString(),
      reviewReason: REVIEW.sanctions,
    });
    return refund;
  }
  const exchange = isExchangeAddress(senderChain, sender);
  const session = await prisma.session.findFirstOrThrow({
    where: { id: p.sessionId, ...tenantOf(ctx) },
    select: { externalRef: true, customerEmail: true },
  });
  const { refund, created } = await insertRefund(
    ctx,
    {
      ...base,
      amount: net.toString(),
      returnFee: fee.toString(),
      destination: exchange ? null : sender,
      destinationChain: exchange ? null : chain,
      needsAddress: exchange,
      reviewReason: exchange || chain ? null : REVIEW.unsupportedChain,
    },
    async (tx, row) => {
      if (!exchange) return;
      await recordEvent(tx, ctx, {
        aggregateType: 'refund',
        aggregateId: row.id,
        type: 'refund.needs_address',
        payload: {
          ...refundPayload(row, p.sessionId, session.externalRef),
          sender_address: sender,
          sender_chain: senderChain,
          customer_email_on_file: session.customerEmail !== null,
        },
      });
    },
  );
  if (exchange) {
    if (created && session.customerEmail) await emailNeedsAddress(ctx, refund.id);
    return refund;
  }
  return draftIfReady(ctx, refund.id);
}

/** Records a refund 1Click made itself (to an ORIGIN_CHAIN address): no draft, no signer. */
async function recordDirectRefund(
  ctx: ScopeContext,
  p: Payment,
  q: Quote,
  reason: ReturnReason,
  amount: string,
): Promise<Refund> {
  const chain = p.senderChain ?? null;
  const { refund } = await insertRefund(ctx, {
    paymentId: p.id,
    reason,
    assetId: q.originAssetId,
    amount,
    destination: q.refundTo,
    destinationChain: chain ? (contractChainOf(chain) ?? chain) : null,
    status: 'confirmed',
  });
  return refund;
}

/**
 * The return for `reason` is worth less than SMALL_OVERPAY_USD after the return fee: the merchant
 * keeps it, no signer. Recorded per reason (`kept_small_reasons`, C40), plus the store-facing
 * `kept_small_overpayment` flag. A payment waiting in REFUNDING is done (REFUNDED) — and a
 * late-deposit session waiting on it closes — only once no other return of it is still open.
 */
export async function keepSmall(ctx: ScopeContext, paymentId: string, reason: ReturnReason) {
  await tenantTransaction(ctx, async (tx) => {
    await lockPayment(tx, ctx, paymentId);
    const p = await tx.payment.findFirstOrThrow({ where: { id: paymentId, ...tenantOf(ctx) } });
    if (p.keptSmallReasons.includes(reason)) return;
    const kept = [...p.keptSmallReasons, reason];
    await tx.payment.updateMany({
      where: { id: p.id, ...tenantOf(ctx) },
      data: { keptSmallOverpayment: true, keptSmallReasons: kept },
    });
    if (
      p.status === 'REFUNDING' &&
      !(await otherReturnOpen(tx, ctx, { ...p, keptSmallReasons: kept }, reason))
    ) {
      await transitionPayment(tx, ctx, p.id, 'REFUNDED', {
        reason,
        kept_small_overpayment: true,
      });
      await closeSession(tx, ctx, p.sessionId, p.id);
    }
  });
}

/** Refund statuses of a return that still needs something (C41): not sent, or in review. */
export const OPEN_RETURN_STATUSES = ['pending', 'submitted', 'failed'] as const;

/** Review reasons `detachProposal` sets when a refund's proposal ended without executing. */
export const PROPOSAL_ENDED_REVIEW: ReadonlySet<string> = new Set([
  REVIEW.proposalCancelled,
  REVIEW.proposalExpired,
  REVIEW.transferFailed,
]);

/** Review reasons that close a merchant refund (`isClosedMerchantRefund`). */
const MERCHANT_CLOSED_REVIEW_LIST: readonly string[] = [
  ...PROPOSAL_ENDED_REVIEW,
  REVIEW.storeCancelled,
];
export const MERCHANT_CLOSED_REVIEW: ReadonlySet<string> = new Set(MERCHANT_CLOSED_REVIEW_LIST);

/**
 * A `where` fragment that leaves closed merchant refunds out (`isClosedMerchantRefund` in SQL), so
 * a write that would reopen or redirect a refund is refused by the database itself if the row was
 * closed after it was read. NULL-safe: an open row with no review reason still matches.
 */
export const NOT_CLOSED_MERCHANT = {
  AND: [
    {
      OR: [
        { reason: { not: 'merchant' as const } },
        { status: 'confirmed' as const },
        { reviewReason: null },
        { reviewReason: { notIn: [...MERCHANT_CLOSED_REVIEW_LIST] } },
      ],
    },
  ],
} satisfies Prisma.RefundWhereInput;

/**
 * A merchant-initiated refund that is closed: its proposal ended without executing (rejected,
 * expired, its transfer failed), or the store cancelled it before any proposal existed
 * (`cancelMerchantRefund`: status `failed` + `store_cancelled`, terminal). The store was told
 * (`refund.cancelled` / `refund.failed`) and undid its own refund, so the row never goes to the
 * review queue, is never drafted again (a new request from the store is a new refund) and no
 * longer counts against the refundable amount. A proposal-ended row is closed only by this
 * marking (it stays `pending` + the review reason, with no proposal), so every on-chain safety net
 * still applies to it: a revived proposal re-links it (`relinkRevivedRefundTx`) and an executed
 * detached one confirms it (`detachedRefundFor`) — it then counts again, as the money did leave.
 */
export function isClosedMerchantRefund(r: {
  reason: string;
  status: string;
  reviewReason: string | null;
}): boolean {
  return (
    r.reason === 'merchant' &&
    r.status !== 'confirmed' &&
    r.reviewReason !== null &&
    MERCHANT_CLOSED_REVIEW.has(r.reviewReason)
  );
}

/**
 * Whether a return is still open: pending, submitted, or failed into the review queue (a blocked
 * destination, a cancelled proposal, …) — anything but sent, kept small, or a closed merchant
 * refund. The review queue and `keepSmall` share this rule (C41).
 */
export function isOpenReturn(r: {
  reason: string;
  status: string;
  reviewReason: string | null;
}): boolean {
  return (
    (OPEN_RETURN_STATUSES as readonly string[]).includes(r.status) &&
    r.reviewReason !== REVIEW.keptSmall &&
    !isClosedMerchantRefund(r)
  );
}

/**
 * Whether a return of `p` other than `reason` is still open (`isOpenReturn`: a row not sent and
 * not kept small, review items included),
 * or a return a late deposit swapped into the account is due (its `late` return, and the `overpaid`
 * excess of M-2) that is neither queued nor kept yet — its hook may run after this one, or only in
 * the sweeper.
 */
async function otherReturnOpen(
  tx: Tx,
  ctx: ScopeContext,
  p: Payment,
  reason: ReturnReason,
): Promise<boolean> {
  const rows = await tx.refund.findMany({
    where: { paymentId: p.id, ...tenantOf(ctx), reason: { not: reason } },
    select: { reason: true, status: true, reviewReason: true },
  });
  if (rows.some((r) => isOpenReturn(r))) return true;
  if (!p.isLate || p.oneclickStatus !== 'SUCCESS') return false;
  const due: ReturnReason[] = [];
  if (p.amountOut?.gt(0)) due.push('late');
  if (p.refundedAmount?.gt(0)) {
    const q = await tx.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
    if (q.refundType !== 'ORIGIN_CHAIN') due.push('overpaid');
  }
  return due.some(
    (d) => d !== reason && !p.keptSmallReasons.includes(d) && !rows.some((r) => r.reason === d),
  );
}

/** A late / held session waiting on this payment's return is REFUNDED once nothing else is open. */
async function closeSession(tx: Tx, ctx: ScopeContext, sessionId: string, paymentId: string) {
  await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${sessionId} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
  const s = await tx.session.findFirstOrThrow({
    where: { id: sessionId, ...tenantOf(ctx) },
    select: { status: true },
  });
  if (s.status !== 'LATE_DEPOSIT' && s.status !== 'HELD') return;
  const open = await tx.payment.count({
    where: {
      sessionId,
      id: { not: paymentId },
      status: { in: ['DETECTED', 'PROCESSING', 'SCREENING_PENDING', 'HELD', 'REFUNDING'] },
    },
  });
  if (open === 0)
    await transitionSession(tx, ctx, sessionId, 'REFUNDED', { payment_id: paymentId });
}

/**
 * `refund_external_ref` (W7): a merchant refund's own reference (the WooCommerce refund id), on
 * every `refund.*` event of it. `external_ref` stays the order's (the session's) reference. The
 * key is present only on refunds that have one, so automatic returns' payloads are unchanged.
 */
export const refundRef = (r: Pick<Refund, 'externalRef'>) =>
  r.externalRef === null ? {} : { refund_external_ref: r.externalRef };

/**
 * The USD order amount a SETTLED payment settled — what merchant-initiated refunds of it may
 * return in total: the session's USD amount (after a Task 4 conversion, the converted amount),
 * or, for a session priced in the settlement asset, 1Click's USD value of the quoted output.
 * Fixed at settlement, so the refundable amount never drifts with prices. Null when unknown.
 * (One payment per session settles; a later deposit into the session is late, never SETTLED.)
 */
export function settledUsdOf(
  s: Pick<Session, 'amount' | 'amountCurrency'>,
  q: Pick<Quote, 'amountOutUsd'>,
): Prisma.Decimal | null {
  if (s.amountCurrency === 'USD') return s.amount;
  return q.amountOutUsd && q.amountOutUsd.gt(0) ? q.amountOutUsd.toDecimalPlaces(2, 1) : null;
}

/**
 * A merchant refund of payment `p` executed (its row already `confirmed`, inside the caller's
 * transaction, payment row locked): the payment becomes PARTIALLY_REFUNDED, or REFUNDED once the
 * merchant refunds sent cover its whole settled order amount. Returns whether it is now fully
 * refunded by this one (the caller then records `payment.refunded`, once). A payment in any other
 * status (a merchant refund of a payment that was HELD meanwhile cannot exist: only SETTLED ones
 * are refundable, and SETTLED never becomes HELD) is left as it is.
 */
async function merchantRefundSent(
  tx: Tx,
  ctx: ScopeContext,
  p: Payment,
  refundId: string,
): Promise<boolean> {
  if (p.status !== 'SETTLED' && p.status !== 'PARTIALLY_REFUNDED') return false;
  const s = await tx.session.findFirstOrThrow({
    where: { id: p.sessionId, ...tenantOf(ctx) },
    select: { amount: true, amountCurrency: true },
  });
  const q = await tx.quote.findFirstOrThrow({
    where: { id: p.quoteId, ...tenantOf(ctx) },
    select: { amountOutUsd: true },
  });
  const settled = settledUsdOf(s, q);
  const sent = await tx.refund.findMany({
    where: { paymentId: p.id, ...tenantOf(ctx), reason: 'merchant', status: 'confirmed' },
    select: { requestedAmountUsd: true },
  });
  const total = sent.reduce((sum, x) => sum.add(x.requestedAmountUsd ?? 0), D(0));
  if (settled && total.gte(settled)) {
    await transitionPayment(tx, ctx, p.id, 'REFUNDED', { reason: 'merchant', refund_id: refundId });
    return true;
  }
  if (p.status === 'SETTLED') {
    await transitionPayment(tx, ctx, p.id, 'PARTIALLY_REFUNDED', {
      reason: 'merchant',
      refund_id: refundId,
    });
  }
  return false;
}

export function refundPayload(r: Refund, sessionId: string, externalRef: string | null) {
  return {
    refund_id: r.id,
    payment_id: r.paymentId,
    session_id: sessionId,
    external_ref: externalRef,
    ...refundRef(r),
    reason: r.reason,
    asset: r.assetId,
    amount: r.amount,
    return_fee: r.returnFee,
    destination: r.destination,
    destination_chain: r.destinationChain,
    proposal_id: r.proposalId,
  };
}

// ─── drafting ────────────────────────────────────────────────────────────────

/** A held payment's return needs the typed legal acknowledgement first (Task 10's action). */
export const legalAckRequired = () =>
  new AppError(
    'LEGAL_ACK_REQUIRED',
    'Returning funds from a held payment needs the legal-clearance acknowledgement first',
    409,
  );

/** `draftReturn`, swallowing the reasons a draft cannot be made yet (the sweeper retries). */
export async function draftIfReady(ctx: ScopeContext, refundId: string): Promise<Refund> {
  try {
    return await draftReturn(ctx, refundId);
  } catch (err) {
    log('warn', 'return to sender not drafted yet', { refundId, err: String(err) });
    return prisma.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
  }
}

/**
 * Drafts the `refund` proposal for a pending return with a destination: sanctions screen of the
 * destination, route check, then the draft, the link and `refund.pending` in one transaction.
 * A no-op for a refund already drafted, done, needing an address or under review. Throws
 * LEGAL_ACK_REQUIRED (409) for a held payment's return without `acknowledged_legal_at`, and
 * PROVIDER_UNAVAILABLE (503) when the destination cannot be screened (fail closed).
 *
 * The proposal's action is built from the row as read here, and drafted only if the row under the
 * lock still has exactly that destination, chain, asset and amount (a concurrent writer changed it
 * → no draft: CONFLICT 409 when the caller set `expect`, else a no-op the sweeper retries).
 * `screenedAddress` skips the screen only when it is the row's destination (the caller screened
 * that very address). With `expect`, a row that does not hold the caller's values is 409.
 */
export async function draftReturn(
  ctx: ScopeContext,
  refundId: string,
  opts: {
    screenedAddress?: string;
    expect?: { destination: string; destinationChain: string; amount: string };
  } = {},
): Promise<Refund> {
  const r = await prisma.refund.findFirst({
    where: { id: refundId, ...tenantOf(ctx) },
    include: { payment: { select: { status: true, sessionId: true, heldReason: true } } },
  });
  if (!r) throw notFound('Refund not found');
  const changed = () =>
    conflict('This return was changed by another request; reload and try again');
  const holds = (row: Refund, e: NonNullable<typeof opts.expect>) =>
    row.destination === e.destination &&
    row.destinationChain === e.destinationChain &&
    row.amount.toFixed(0) === e.amount;
  if (opts.expect && !holds(r, opts.expect)) throw changed();
  if (r.proposalId || r.status !== 'pending' || r.needsAddress || r.reviewReason) return r;
  // Any return of a sanctions-held payment — whatever its status now, and whatever the reason —
  // needs the review queue's acknowledgement (C40).
  const sanctionsHeld =
    r.payment.status === 'HELD' || r.payment.heldReason === 'sanctions' || r.reason === 'sanctions';
  if (sanctionsHeld && !r.acknowledgedLegalAt) {
    // A merchant refund requested before the payment was held (another return of it screened as
    // sanctioned in between) would otherwise sit `pending` with no review reason, never drafted
    // (the sweeper skips held payments) and invisible to the store: it goes to the sanctions
    // review instead — legal acknowledgement plus a merchant-given destination, or a cancel.
    if (r.reason === 'merchant') return holdMerchantRefund(ctx, r.id);
    throw legalAckRequired();
  }
  if (!r.destination || !r.destinationChain) return r;
  // Screened first: a sanctioned destination is flagged whatever the route.
  if (opts.screenedAddress !== r.destination) {
    const { decision } = await deps.screen(ctx, {
      sessionId: r.payment.sessionId,
      address: r.destination,
      chain: oneclickChainOf(r.destinationChain),
    });
    if (decision === 'unavailable') {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Address screening is unavailable; try again shortly',
        503,
      );
    }
    if (decision === 'block') return blockReturn(ctx, r.id);
  }
  const route = returnRoute(r.assetId, r.destinationChain, r.destination);
  if (!route) return markReview(ctx, r.id, REVIEW.needsSwapRoute);
  const action = {
    refund: {
      asset: r.assetId,
      amount: r.amount.toFixed(0),
      destination_chain: r.destinationChain,
      destination: r.destination,
      payment_id: r.paymentId,
      route,
    },
  };
  try {
    return await tenantTransaction(ctx, async (tx) => {
      await lockRefund(tx, ctx, r.id);
      const cur = await tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
      // The action (and the screen) are for the row read above: never draft a changed row.
      const same =
        cur.destination === r.destination &&
        cur.destinationChain === r.destinationChain &&
        cur.assetId === r.assetId &&
        cur.amount.equals(r.amount);
      if (!same) {
        if (opts.expect) throw changed();
        return cur;
      }
      if (cur.proposalId || cur.status !== 'pending' || cur.needsAddress || cur.reviewReason) {
        return cur;
      }
      const proposal = await createSystemDraftInTx(tx, ctx, {
        kind: 'refund',
        action,
        reason: `return to sender: ${r.reason} (${r.id})`,
        refundId: r.id,
      });
      await tx.refund.updateMany({
        where: { id: r.id, ...tenantOf(ctx) },
        data: { proposalId: proposal.id },
      });
      const updated = await tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
      const s = await tx.session.findFirstOrThrow({
        where: { id: r.payment.sessionId, ...tenantOf(ctx) },
        select: { externalRef: true },
      });
      await recordEvent(tx, ctx, {
        aggregateType: 'refund',
        aggregateId: r.id,
        type: 'refund.pending',
        payload: refundPayload(updated, r.payment.sessionId, s.externalRef),
      });
      return updated;
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'VALIDATION_ERROR') {
      log('error', 'return to sender: the draft was refused', { refundId: r.id, err: err.message });
      return markReview(ctx, r.id, REVIEW.draftRejected);
    }
    throw err;
  }
}

/**
 * A pending, undrafted merchant refund of a payment that became sanctions-held: sanctions review,
 * with no destination (it can never go back to the sender). Conditional under the refund lock, so
 * a draft or a cancel that got there first wins.
 */
export async function holdMerchantRefund(ctx: ScopeContext, refundId: string): Promise<Refund> {
  return tenantTransaction(ctx, async (tx) => {
    await lockRefund(tx, ctx, refundId);
    await tx.refund.updateMany({
      where: {
        id: refundId,
        ...tenantOf(ctx),
        reason: 'merchant',
        status: 'pending',
        proposalId: null,
        reviewReason: null,
        // Never undoes an acknowledged review action (the legal ack and a merchant destination).
        acknowledgedLegalAt: null,
      },
      data: {
        reviewReason: REVIEW.sanctions,
        destination: null,
        destinationChain: null,
        needsAddress: false,
        addressTokenHash: null,
        addressTokenExpiresAt: null,
      },
    });
    log('warn', 'merchant refund of a sanctions-held payment: to review', { refundId });
    return tx.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
  });
}

/**
 * The merchant account's balance of `asset` (base units) for the advisory check on store refunds
 * (the merchant pays the network cost on top). An asset the account does not list holds nothing
 * (0: refused, never waved through). Null only when the balance cannot be read: the check is then
 * left to the chain (an underfunded proposal fails when it executes, and the store is told with
 * `refund.failed`). Advisory either way: other proposals may spend the balance first.
 */
export async function accountBalance(ctx: ScopeContext, asset: string): Promise<bigint | null> {
  try {
    const { balances } = await getBalances(ctx.merchantId, ctx.livemode);
    const b = balances.find((x) => x.asset === asset);
    return b ? BigInt(b.amount) : 0n;
  } catch (err) {
    log('warn', 'merchant refund: account balance unavailable; not checked', { err: String(err) });
    return null;
  }
}

async function markReview(ctx: ScopeContext, refundId: string, reason: string): Promise<Refund> {
  await prisma.refund.updateMany({
    // A store refund closed meanwhile (cancelled while this one was screened) stays closed.
    where: { id: refundId, ...tenantOf(ctx), proposalId: null, ...NOT_CLOSED_MERCHANT },
    data: { reviewReason: reason },
  });
  log('warn', 'return to sender needs review', { refundId, reason });
  return prisma.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
}

/**
 * The destination screened as sanctioned: no draft, ever. A pending, undrafted refund is failed
 * with `review_reason = sanctions`, and `payment.held` (with the non-custodial notice) is recorded
 * once for the payment. A refund already drafted or done is left alone.
 */
async function blockReturn(ctx: ScopeContext, refundId: string): Promise<Refund> {
  return tenantTransaction(ctx, async (tx) => {
    await lockRefund(tx, ctx, refundId);
    const r = await tx.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
    if (r.status !== 'pending' || r.proposalId !== null) return r;
    // A closed store refund keeps its closed state (the hold is still recorded below: the
    // address did screen as sanctioned).
    await tx.refund.updateMany({
      where: {
        id: r.id,
        ...tenantOf(ctx),
        status: 'pending',
        proposalId: null,
        ...NOT_CLOSED_MERCHANT,
      },
      data: { status: 'failed', reviewReason: REVIEW.sanctions, needsAddress: false },
    });
    await lockPayment(tx, ctx, r.paymentId);
    const p = await tx.payment.findFirstOrThrow({ where: { id: r.paymentId, ...tenantOf(ctx) } });
    await tx.payment.updateMany({
      where: { id: p.id, ...tenantOf(ctx) },
      data: { heldReason: 'sanctions' },
    });
    const held = await tx.event.findFirst({
      where: { aggregateId: p.id, type: 'payment.held', ...tenantOf(ctx) },
      select: { id: true },
    });
    if (!held) {
      const s = await tx.session.findFirstOrThrow({
        where: { id: p.sessionId, ...tenantOf(ctx) },
        select: { externalRef: true },
      });
      await recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: p.id,
        type: 'payment.held',
        payload: {
          payment_id: p.id,
          session_id: p.sessionId,
          external_ref: s.externalRef,
          held_reason: 'sanctions',
          refund_id: r.id,
          blocked_destination: r.destination,
          notify: 'all_signers',
          notice: HOLD_NOTICE,
        },
      });
    }
    log('warn', 'return to sender blocked: sanctioned destination', { refundId: r.id });
    return tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
  });
}

/**
 * The amount of a held payment that verifiably reached the merchant account, or null when it
 * cannot be told: the claimed settlement transfer, else the verified `amount_out` recorded on the
 * payment, else 1Click's reported `amountOut` for a SUCCESS, else the amount 1Click refunded into
 * the account (a store-path refund). Never the quote's estimate.
 */
export async function heldAmount(
  ctx: ScopeContext,
  p: Payment,
  q: Quote,
  destAsset: string,
): Promise<{ assetId: string; amount: bigint } | null> {
  const claim = await prisma.settlementClaim.findFirst({
    where: { paymentId: p.id, ...tenantOf(ctx) },
  });
  if (claim && claim.amount.gt(0)) {
    return { assetId: destAsset, amount: BigInt(claim.amount.toFixed(0)) };
  }
  if (p.oneclickStatus === 'SUCCESS') {
    if (p.amountOut?.gt(0)) return { assetId: destAsset, amount: BigInt(p.amountOut.toFixed(0)) };
    let status: StatusResponse;
    try {
      status = await providerFor(ctx.livemode).status(q.depositAddress);
    } catch (err) {
      log('warn', 'held return: 1Click status unavailable', { paymentId: p.id, err: String(err) });
      throw new AppError('PROVIDER_UNAVAILABLE', 'The swap provider is unavailable; retry', 503);
    }
    const out = status.status === 'SUCCESS' ? status.swapDetails.amountOut : undefined;
    return out && /^\d+$/.test(out) && BigInt(out) > 0n
      ? { assetId: destAsset, amount: BigInt(out) }
      : null;
  }
  if (q.refundType !== 'ORIGIN_CHAIN' && p.refundedAmount?.gt(0)) {
    return { assetId: q.originAssetId, amount: BigInt(p.refundedAmount.toFixed(0)) };
  }
  return null;
}

/**
 * The overpaid excess of a late or held deposit (M-2): 1Click swapped the quoted amount into the
 * merchant account and refunded the excess there too (an INTENTS refund type). That excess goes
 * back as its own `overpaid` return, in the origin asset, through `queueReturn`: once per
 * (payment, reason), screened right before drafting, and — for a held payment — drafted only after
 * the legal acknowledgement, to a destination that is not the sanctioned sender. A settled payment's
 * excess is `settle()`'s (`overpaid_amount`); a direct (ORIGIN_CHAIN) refund is 1Click's.
 */
export async function queueExcessReturn(
  ctx: ScopeContext,
  paymentId: string,
): Promise<Refund | null> {
  const p = await prisma.payment.findFirst({ where: { id: paymentId, ...tenantOf(ctx) } });
  if (!p || p.status === 'SETTLED' || p.oneclickStatus !== 'SUCCESS') return null;
  if (!p.refundedAmount?.gt(0)) return null;
  const q = await prisma.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
  if (q.refundType === 'ORIGIN_CHAIN') return null;
  return queueReturn(ctx, p, {
    reason: 'overpaid',
    assetId: q.originAssetId,
    amount: p.refundedAmount.toFixed(0),
  });
}

/**
 * Queues the return of a HELD (sanctions) payment's funds that reached the merchant account,
 * sized from the verified delivered amount (`heldAmount`) less the estimated return fee. An
 * unknown amount is a review item (`amount_unknown`, amount 0); a net under SMALL_OVERPAY_USD is
 * kept. Drafting needs `acknowledged_legal_at` (the dashboard action, Task 10) and, as every
 * return, a destination that does not screen as sanctioned.
 */
export async function queueHeldReturn(
  ctx: ScopeContext,
  paymentId: string,
): Promise<Refund | null> {
  const p = await prisma.payment.findFirst({ where: { id: paymentId, ...tenantOf(ctx) } });
  if (!p) throw notFound('Payment not found');
  if (p.status !== 'HELD') throw conflict('Only a held payment is returned this way');
  // The excess 1Click refunded into the account is its own (equally gated) return (M-2).
  await queueExcessReturn(ctx, p.id);
  const existing = await prisma.refund.findFirst({
    where: { paymentId: p.id, reason: 'sanctions', ...tenantOf(ctx) },
  });
  if (existing) return existing;
  const s = await prisma.session.findFirstOrThrow({
    where: { id: p.sessionId, ...tenantOf(ctx) },
    select: { destAsset: true },
  });
  const q = await prisma.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
  const held = await heldAmount(ctx, p, q, s.destAsset);
  const chain = p.senderChain ? contractChainOf(p.senderChain) : null;
  const base = {
    paymentId: p.id,
    reason: 'sanctions' as const,
    destination: p.senderAddress,
    destinationChain: chain,
  };
  if (!held) {
    const { refund } = await insertRefund(ctx, {
      ...base,
      assetId: s.destAsset,
      amount: '0',
      reviewReason: REVIEW.amountUnknown,
    });
    return refund;
  }
  const perUnit = await usdPerUnit(ctx.livemode, held.assetId, q);
  if (!perUnit || !p.senderChain) {
    const { refund } = await insertRefund(ctx, {
      ...base,
      assetId: held.assetId,
      amount: held.amount.toString(),
      reviewReason: perUnit ? REVIEW.noSender : REVIEW.priceUnavailable,
    });
    return refund;
  }
  const feeUsd = D(gasEstimateUsd(p.senderChain));
  const { fee, net, netUsd } = netOfReturnFee(held.amount, perUnit, feeUsd);
  if (net <= 0n || netUsd.lt(SMALL_OVERPAY_USD)) {
    await keepSmall(ctx, p.id, 'sanctions');
    return null;
  }
  const { refund } = await insertRefund(ctx, {
    ...base,
    assetId: held.assetId,
    amount: net.toString(),
    returnFee: fee.toString(),
    reviewReason: p.senderAddress ? (chain ? null : REVIEW.unsupportedChain) : REVIEW.noSender,
  });
  return refund;
}

// ─── shopper: return address ─────────────────────────────────────────────────

export const RefundAddressInputSchema = z
  .object({
    /** Which waiting return (optional when the session has exactly one). */
    refund_id: z.string().min(1).max(64).optional(),
    address: z.string().trim().min(1).max(128),
    /** A 1Click `blockchain` id (`eth`, `sol`, `near`, …) or a contract chain name. */
    chain: z.string().trim().min(1).max(32),
  })
  .strict();

/** `POST /v1/checkout/refund-address` (the emailed link): the token instead of a client secret. */
export const RefundAddressTokenInputSchema = z
  .object({
    token: z.string().min(1).max(256),
    address: z.string().trim().min(1).max(128),
    chain: z.string().trim().min(1).max(32),
  })
  .strict();

const walletNotAllowed = () =>
  new AppError('WALLET_NOT_ALLOWED', 'This address cannot receive the refund', 403);
const invalidInput = (msg: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', msg, 400, details);

/**
 * Validates and screens a shopper-provided return address for refund `r`, then stores it
 * (clearing `needs_address` and any emailed token in one conditional update — for the emailed
 * link, conditional on that token, which consumes it) and drafts. A sanctioned address is refused
 * (403 WALLET_NOT_ALLOWED) without touching the refund or the payment: it is the shopper's
 * suggestion, not the sender, and they may give another. Screening unavailable → 503.
 */
async function fillAddress(
  ctx: ScopeContext,
  r: Refund & { sessionId: string },
  input: { address: string; chain: string },
  tokenHash?: string,
) {
  const chain = contractChainOf(input.chain);
  if (!chain) throw invalidInput('Refunds cannot be sent on this network');
  const oneclick = oneclickChainOf(chain);
  if (!isValidAddress(oneclick, input.address)) {
    throw invalidInput(`That is not a valid ${oneclick} address`, { field: 'address' });
  }
  if (!returnRoute(r.assetId, chain, input.address)) {
    throw invalidInput('This refund cannot be sent on that network', {
      chains: returnChainsOf(r.assetId).map(oneclickChainOf),
    });
  }
  const { decision } = await deps.screen(ctx, {
    sessionId: r.sessionId,
    address: input.address,
    chain: oneclick,
  });
  if (decision === 'unavailable') {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Please try again in a few minutes', 503);
  }
  if (decision === 'block') {
    log('warn', 'shopper return address refused: sanctioned', { refundId: r.id });
    throw walletNotAllowed();
  }
  // A store refund (the merchant pays the network cost): the fee is re-estimated for the chain the
  // shopper chose, on top of the same requested amount.
  let regross: { amount: string; returnFee: string } | null = null;
  if (r.reason === 'merchant') {
    const p = await prisma.payment.findFirstOrThrow({
      where: { id: r.paymentId, ...tenantOf(ctx) },
      select: { quoteId: true },
    });
    const q = await prisma.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
    const perUnit = await usdPerUnit(ctx.livemode, r.assetId, q);
    if (!perUnit || !perUnit.gt(0)) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'Please try again in a few minutes', 503);
    }
    const requested = BigInt(r.amount.toFixed(0)) - BigInt(r.returnFee?.toFixed(0) ?? '0');
    const { fee } = grossUpForReturnFee(D(0), perUnit, D(gasEstimateUsd(oneclick)));
    // The same advisory balance check as the request (an unlisted asset holds nothing).
    const balance = await accountBalance(ctx, r.assetId);
    if (balance !== null && requested + fee > balance) {
      throw new AppError(
        'AMOUNT_EXCEEDS_REFUNDABLE',
        'The store cannot send this refund right now; please try again later',
        409,
      );
    }
    regross = { amount: (requested + fee).toString(), returnFee: fee.toString() };
  }
  const { count } = await prisma.refund.updateMany({
    where: {
      id: r.id,
      ...tenantOf(ctx),
      ...NOT_CLOSED_MERCHANT,
      needsAddress: true,
      status: 'pending',
      ...(tokenHash ? { addressTokenHash: tokenHash } : {}),
      ...(regross ? { amount: r.amount, returnFee: r.returnFee } : {}),
    },
    data: {
      ...(regross ?? {}),
      destination: input.address,
      destinationChain: chain,
      needsAddress: false,
      addressTokenHash: null,
      addressTokenExpiresAt: null,
    },
  });
  if (count === 0) {
    if (tokenHash) throw invalidToken();
    throw conflict('This refund already has an address');
  }
  const drafted = await draftIfReadyScreened(ctx, r.id, input.address);
  return { refund_id: drafted.id, status: drafted.proposalId ? 'pending_approval' : 'queued' };
}

/**
 * The shopper says where an exchange-sent return should go (Ruling C3), from the checkout page
 * (client secret): format check, route check, sanctions screen, then the address is stored,
 * `needs_address` clears and the draft is created.
 */
export async function provideRefundAddress(
  ctx: ShopperCtx,
  input: z.infer<typeof RefundAddressInputSchema>,
) {
  const waiting = await ctx.db.refund.findMany({
    where: {
      needsAddress: true,
      status: 'pending',
      payment: { sessionId: ctx.sessionId },
      ...(input.refund_id ? { id: input.refund_id } : {}),
    },
  });
  if (waiting.length === 0) throw notFound('No refund is waiting for an address');
  if (waiting.length > 1) throw invalidInput('Say which refund (refund_id)');
  return fillAddress(ctx, { ...waiting[0]!, sessionId: ctx.sessionId }, input);
}

// ─── emailed return-address link (Ruling C20) ────────────────────────────────

/** How long an emailed return-address link stays valid. */
export const ADDRESS_TOKEN_TTL_MS = 7 * 24 * 3_600_000;
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const invalidToken = () => unauthorized('This link is invalid or has expired');

/**
 * Mints a single-use token bound to refund `refundId` (`<refund id>.<32 random bytes,
 * base64url>`), storing only its sha256 and a 7-day expiry. A new token replaces any earlier one.
 */
async function mintAddressToken(ctx: ScopeContext, refundId: string): Promise<string> {
  const token = `${refundId}.${randomBytes(32).toString('base64url')}`;
  await prisma.refund.updateMany({
    where: { id: refundId, ...tenantOf(ctx) },
    data: {
      addressTokenHash: sha256Hex(token),
      addressTokenExpiresAt: new Date(Date.now() + ADDRESS_TOKEN_TTL_MS),
    },
  });
  return token;
}

/**
 * `POST /v1/checkout/refund-address` (public, per-IP limited): the emailed link. The token names
 * its refund; an unknown, used, expired or mismatched token is 401 UNAUTHORIZED. Otherwise the
 * same validation, screening and draft as `provideRefundAddress`; success consumes the token.
 */
export async function provideRefundAddressByToken(
  input: z.infer<typeof RefundAddressTokenInputSchema>,
) {
  const dot = input.token.indexOf('.');
  const refundId = dot > 0 ? input.token.slice(0, dot) : '';
  if (!refundId) throw invalidToken();
  const r = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { payment: { select: { sessionId: true } } },
  });
  const hash = sha256Hex(input.token);
  const valid =
    !!r?.addressTokenHash &&
    !!r.addressTokenExpiresAt &&
    r.addressTokenExpiresAt.getTime() > Date.now() &&
    timingSafeEqual(Buffer.from(r.addressTokenHash, 'hex'), Buffer.from(hash, 'hex')) &&
    r.needsAddress &&
    r.status === 'pending';
  if (!r || !valid) throw invalidToken();
  const ctx = { merchantId: r.merchantId, livemode: r.livemode };
  return fillAddress(ctx, { ...r, sessionId: r.payment.sessionId }, input, hash);
}

async function draftIfReadyScreened(
  ctx: ScopeContext,
  refundId: string,
  screenedAddress: string,
): Promise<Refund> {
  try {
    return await draftReturn(ctx, refundId, { screenedAddress });
  } catch (err) {
    log('warn', 'return to sender not drafted yet', { refundId, err: String(err) });
    return prisma.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
  }
}

/** The shopper-facing returns of a session (the checkout's "Tell us where to send it"). */
export async function shopperRefunds(ctx: ShopperCtx) {
  // Neutral rows only (C42): a sanctions return is never shown, and no row carries its reason —
  // the shopper copy for a held payment stays "We couldn't complete this payment".
  const rows = await ctx.db.refund.findMany({
    where: { payment: { sessionId: ctx.sessionId }, reason: { not: 'sanctions' } },
    orderBy: { createdAt: 'asc' },
  });
  // A store refund that was cancelled or ended is not coming: not shown.
  return rows
    .filter((r) => !isClosedMerchantRefund(r))
    .map((r) => ({
      id: r.id,
      payment_id: r.paymentId,
      asset: r.assetId,
      amount: r.amount.toFixed(0),
      needs_address: r.needsAddress,
      chains: r.needsAddress ? returnChainsOf(r.assetId).map(oneclickChainOf) : undefined,
      state:
        r.status === 'confirmed'
          ? 'sent'
          : r.reviewReason === REVIEW.keptSmall
            ? 'kept'
            : r.status === 'failed' || r.reviewReason !== null
              ? 'review'
              : 'processing',
    }));
}

// ─── email ───────────────────────────────────────────────────────────────────

/** Emails the session's customer that a return needs their address (template refund_needs_address). */
export async function emailNeedsAddress(ctx: ScopeContext, refundId: string): Promise<boolean> {
  const r = await prisma.refund.findFirst({
    where: { id: refundId, ...tenantOf(ctx) },
    include: { payment: { select: { sessionId: true } } },
  });
  if (!r || !r.needsAddress) return false;
  const s = await prisma.session.findFirstOrThrow({
    where: { id: r.payment.sessionId, ...tenantOf(ctx) },
    select: { id: true, customerEmail: true, merchant: { select: { name: true } } },
  });
  if (!s.customerEmail) return false;
  let amount = `${r.amount.toFixed(0)} base units of ${r.assetId}`;
  try {
    const t = await tokenInfo(ctx.livemode, r.assetId);
    amount = `${r.amount.div(D(10).pow(t.decimals)).toFixed()} ${t.symbol}`;
  } catch {
    // Token list unavailable: base units.
  }
  const token = await mintAddressToken(ctx, r.id);
  const base = env().CHECKOUT_BASE_URL.replace(/\/+$/, '');
  try {
    await getMailer().send({
      to: s.customerEmail,
      template: 'refund_needs_address',
      data: {
        merchant_name: s.merchant.name,
        amount,
        refund_id: r.id,
        refund_address_url: `${base}/pay/${s.id}/refund-address?t=${encodeURIComponent(token)}`,
      },
    });
    return true;
  } catch (err) {
    log('error', 'refund address email failed', { refundId, err: String(err) });
    return false;
  }
}

/** After the shopper gave an email: tells them about every return waiting on an address. */
export async function emailWaitingReturns(ctx: ShopperCtx): Promise<void> {
  const waiting = await ctx.db.refund.findMany({
    where: { needsAddress: true, status: 'pending', payment: { sessionId: ctx.sessionId } },
    select: { id: true },
  });
  for (const r of waiting) await emailNeedsAddress(ctx, r.id);
}

// ─── proposal outcomes ───────────────────────────────────────────────────────

function eventCtx(e: Event): ScopeContext | null {
  return e.merchantId && e.livemode !== null
    ? { merchantId: e.merchantId, livemode: e.livemode }
    : null;
}

function proposalIdOf(e: Event): string | null {
  const p = e.payload as { proposalId?: unknown; kind?: unknown };
  if (p.kind !== undefined && p.kind !== 'refund') return null;
  return typeof p.proposalId === 'string' ? p.proposalId : e.aggregateId;
}

/**
 * `account.proposal.executed` on a refund proposal: the money left the account. Each linked
 * refund → `confirmed` + `refund.sent`; a payment waiting in REFUNDING (or HELD) → REFUNDED, and a
 * late / held session waiting on it → REFUNDED. Idempotent on the refund's status.
 */
export async function onRefundProposalExecuted(e: Event): Promise<void> {
  const ctx = eventCtx(e);
  const proposalId = proposalIdOf(e);
  if (!ctx || !proposalId) return;
  const txHash = (e.payload as { txHash?: unknown }).txHash;
  let refunds = await prisma.refund.findMany({ where: { proposalId, ...tenantOf(ctx) } });
  if (refunds.length === 0) {
    const detached = await detachedRefundFor(ctx, proposalId);
    if (!detached) return;
    refunds = [detached];
  }
  for (const r of refunds) {
    await tenantTransaction(ctx, async (tx) => {
      await lockRefund(tx, ctx, r.id);
      const cur = await tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
      if (cur.status === 'confirmed') return;
      await tx.refund.updateMany({
        where: { id: r.id, ...tenantOf(ctx) },
        data: {
          status: 'confirmed',
          proposalId,
          refundTxHash: typeof txHash === 'string' ? txHash : null,
          reviewReason: null,
        },
      });
      await lockPayment(tx, ctx, r.paymentId);
      const p = await tx.payment.findFirstOrThrow({
        where: { id: r.paymentId, ...tenantOf(ctx) },
      });
      let fullyRefunded = false;
      if (r.reason === 'merchant') {
        fullyRefunded = await merchantRefundSent(tx, ctx, p, r.id);
      } else {
        if (p.status === 'HELD') {
          await transitionPayment(tx, ctx, p.id, 'REFUNDING', {
            reason: r.reason,
            refund_id: r.id,
          });
        }
        if (p.status === 'HELD' || p.status === 'REFUNDING') {
          await transitionPayment(tx, ctx, p.id, 'REFUNDED', { reason: r.reason, refund_id: r.id });
          await closeSession(tx, ctx, p.sessionId, p.id);
        }
      }
      const s = await tx.session.findFirstOrThrow({
        where: { id: p.sessionId, ...tenantOf(ctx) },
        select: { externalRef: true, destAsset: true },
      });
      const done = await tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
      await recordEvent(tx, ctx, {
        aggregateType: 'refund',
        aggregateId: r.id,
        type: 'refund.sent',
        payload: { ...refundPayload(done, p.sessionId, s.externalRef), tx_hash: done.refundTxHash },
      });
      if (fullyRefunded) {
        // Once, when the last of the order amount went back (never for a partial refund).
        const sent = await tx.refund.findMany({
          where: { paymentId: p.id, ...tenantOf(ctx), reason: 'merchant', status: 'confirmed' },
          select: { amount: true, returnFee: true },
        });
        const net = sent.reduce(
          (sum, x) => sum + BigInt(x.amount.toFixed(0)) - BigInt(x.returnFee?.toFixed(0) ?? '0'),
          0n,
        );
        await recordEvent(tx, ctx, {
          aggregateType: 'payment',
          aggregateId: p.id,
          type: 'payment.refunded',
          payload: {
            payment_id: p.id,
            session_id: p.sessionId,
            external_ref: s.externalRef,
            reason: 'merchant',
            refunded_amount: net.toString(),
            asset: s.destAsset,
            refund_via: 'merchant',
            refund_id: r.id,
          },
        });
      }
    });
  }
}

/**
 * A refund proposal executed with no refund linked to it: the chain executed a proposal whose
 * refund we had detached (a draft cancelled only in Postgres whose relay still landed). Its refund
 * is found by the exact back-link `account_proposals.refund_id`, and only if that refund is still
 * waiting unlinked (or already confirmed by this proposal — a replay, ignored). Anything else — no
 * back-link, an unknown refund, a refund linked to another proposal or already sent — is never
 * guessed at: a warning and an internal `refund.needs_review` (keyed on the proposal) for a person.
 */
async function detachedRefundFor(ctx: ScopeContext, proposalId: string): Promise<Refund | null> {
  const prop = await prisma.accountProposal.findFirst({
    where: { id: proposalId, ...tenantOf(ctx) },
    select: { kind: true, refundId: true },
  });
  if (!prop || prop.kind !== 'refund') return null;
  // A refund proposal a person drafted (project 2, money:request) links no refund: it is not a
  // system draft, so it is none of checkout's business — no alert, no review item (M-5).
  if (!prop.refundId) return null;
  const r = prop.refundId
    ? await prisma.refund.findFirst({ where: { id: prop.refundId, ...tenantOf(ctx) } })
    : null;
  if (r && r.proposalId === null && r.status === 'pending') return r;
  if (r && r.proposalId === proposalId && r.status === 'confirmed') return null;
  log('warn', 'OPS ALERT: an executed refund proposal matches no waiting refund', {
    proposalId,
    refundId: prop.refundId,
    refundProposalId: r?.proposalId ?? null,
    refundStatus: r?.status ?? null,
  });
  await tenantTransaction(ctx, async (tx) => {
    const seen = await tx.event.findFirst({
      where: { aggregateId: proposalId, type: REFUND_NEEDS_REVIEW, ...tenantOf(ctx) },
      select: { id: true },
    });
    if (seen) return;
    await recordEvent(tx, ctx, {
      aggregateType: 'account_proposal',
      aggregateId: proposalId,
      type: REFUND_NEEDS_REVIEW,
      payload: {
        proposal_id: proposalId,
        refund_id: prop.refundId,
        review_reason: 'executed_unmatched',
      },
    });
  });
  return null;
}

/** Internal event (not a webhook type): a return went to the merchant's review queue. */
export const REFUND_NEEDS_REVIEW = 'refund.needs_review';

/** Public webhook: the refund's proposal was rejected (cancelled) by the signers, or expired. */
export const REFUND_CANCELLED = 'refund.cancelled';
/** Public webhook: the refund's proposal failed when it executed on chain. */
export const REFUND_FAILED = 'refund.failed';

/** How a refund proposal ended without executing (review reason → public event and `status`). */
const OUTCOME_OF: Readonly<Record<string, { type: string; status: string }>> = {
  [REVIEW.proposalCancelled]: { type: REFUND_CANCELLED, status: 'cancelled' },
  [REVIEW.proposalExpired]: { type: REFUND_CANCELLED, status: 'expired' },
  [REVIEW.transferFailed]: { type: REFUND_FAILED, status: 'failed' },
};

/**
 * Records the public `refund.cancelled` / `refund.failed` for refund `r` whose proposal ended
 * without executing, inside `detachProposal`'s transaction (refund row locked). Every caller of
 * `detachProposal` has established that the proposal is terminal on chain (a contract event, the
 * sweeper's `endedOnChain`, or the review queue's `verifiedEndedOnChain`), so a draft cancelled
 * only in Postgres while still live on chain never reaches here. At most one outcome event per
 * (refund, proposal): a replayed event, or the same proposal revived and ending again, records
 * nothing more. `proposal_id` stays in the stored payload (the dedupe key) and is never delivered.
 */
async function recordRefundOutcome(
  tx: Tx,
  ctx: ScopeContext,
  r: Refund,
  sessionId: string,
  proposalId: string,
  reviewReason: string,
): Promise<void> {
  const outcome = OUTCOME_OF[reviewReason];
  if (!outcome) return;
  const seen = await tx.event.findFirst({
    where: {
      ...tenantOf(ctx),
      aggregateType: 'refund',
      aggregateId: r.id,
      type: { in: [REFUND_CANCELLED, REFUND_FAILED] },
      payload: { path: ['proposal_id'], equals: proposalId },
    },
    select: { id: true },
  });
  if (seen) return;
  const s = await tx.session.findFirstOrThrow({
    where: { id: sessionId, ...tenantOf(ctx) },
    select: { externalRef: true },
  });
  await recordEvent(tx, ctx, {
    aggregateType: 'refund',
    aggregateId: r.id,
    type: outcome.type,
    payload: {
      refund_id: r.id,
      payment_id: r.paymentId,
      session_id: sessionId,
      // The order's reference, as on every other session event (`refund.sent` included).
      external_ref: s.externalRef,
      ...refundRef(r),
      asset: r.assetId,
      amount: r.amount,
      reason: r.reason,
      status: outcome.status,
      proposal_id: proposalId,
    },
  });
}

/**
 * The refund's proposal will never execute (cancelled, expired or its transfer failed): the
 * proposal link is cleared and the return goes to the review queue (`review_reason`), from which
 * the merchant can draft it again (Task 10). Records the internal `refund.needs_review` event (not
 * a webhook). Only refunds still linked to `proposalId` and not yet sent are touched.
 */
export async function detachProposal(
  ctx: ScopeContext,
  proposalId: string,
  reviewReason: string,
): Promise<number> {
  const linked = await prisma.refund.findMany({
    where: { proposalId, ...tenantOf(ctx), status: { in: ['pending', 'submitted'] } },
    select: { id: true },
  });
  let n = 0;
  for (const { id } of linked) {
    const did = await tenantTransaction(ctx, async (tx) => {
      await lockRefund(tx, ctx, id);
      const r = await tx.refund.findFirstOrThrow({ where: { id, ...tenantOf(ctx) } });
      if (r.proposalId !== proposalId || !['pending', 'submitted'].includes(r.status)) {
        return false;
      }
      await tx.refund.updateMany({
        where: { id, ...tenantOf(ctx) },
        data: { proposalId: null, status: 'pending', reviewReason },
      });
      const p = await tx.payment.findFirstOrThrow({
        where: { id: r.paymentId, ...tenantOf(ctx) },
        select: { sessionId: true },
      });
      // A merchant refund is closed by this (`isClosedMerchantRefund`): the store is told and
      // undoes its refund; nothing goes to the review queue, so no review mail either.
      if (r.reason !== 'merchant') {
        await recordEvent(tx, ctx, {
          aggregateType: 'refund',
          aggregateId: id,
          type: REFUND_NEEDS_REVIEW,
          payload: {
            refund_id: id,
            payment_id: r.paymentId,
            session_id: p.sessionId,
            proposal_id: proposalId,
            review_reason: reviewReason,
          },
        });
      }
      await recordRefundOutcome(tx, ctx, r, p.sessionId, proposalId, reviewReason);
      return true;
    });
    if (did) {
      n++;
      log('warn', 'return to sender needs review: proposal ended', { refundId: id, reviewReason });
    }
  }
  return n;
}

/**
 * `account.proposal.failed` on a refund proposal: an expiry (`reason: expired`) or a failed
 * transfer. The return goes back to review (`proposal_expired` / `transfer_failed`).
 */
export async function onRefundProposalFailed(e: Event): Promise<void> {
  const ctx = eventCtx(e);
  const proposalId = proposalIdOf(e);
  if (!ctx || !proposalId) return;
  const expired = (e.payload as { reason?: unknown }).reason === 'expired';
  await detachProposal(ctx, proposalId, expired ? REVIEW.proposalExpired : REVIEW.transferFailed);
}

/** `account.proposal.cancelled` on a refund proposal: the return goes back to review. */
export async function onRefundProposalCancelled(e: Event): Promise<void> {
  const ctx = eventCtx(e);
  const proposalId = proposalIdOf(e);
  if (!ctx || !proposalId) return;
  await detachProposal(ctx, proposalId, REVIEW.proposalCancelled);
}

/**
 * How a proposal the mirror shows as ended really ended (its status), or null while it may still
 * execute. A draft cancelled
 * only in Postgres after a relay was attempted (`relay_claimed_at` still set — the cancel went
 * through a stale claim — or a relayed transaction on record) may be live on chain: the contract's
 * `get_proposal` view decides. Absent, cancelled, expired or failed there → ended. Pending,
 * timelocked, executing or executed → not ended: the mirror is brought up to date from the view
 * (which revives the local-only cancel and re-links the refund, proposals.ts). A view that
 * cannot be read → not ended (the next sweep asks again). Every other ended status is final.
 * When the view decides, its status wins over the mirror's (a local cancel that expired or failed
 * on chain is reported as such).
 */
async function endedOnChain(ctx: ScopeContext, prop: AccountProposal): Promise<string | null> {
  if (prop.status !== 'cancelled' || (prop.relayClaimedAt === null && prop.lastTxHash === null)) {
    return prop.status;
  }
  const chain = await chainSaysEnded(ctx, prop);
  return chain.verdict === 'ended' ? chain.status : null;
}

/** How the contract sees a proposal: ended (and how), live, or unreadable. */
export type ChainEnd =
  { verdict: 'ended'; status: string } | { verdict: 'live' } | { verdict: 'unknown' };

/**
 * Asks the contract's `get_proposal` view whether `prop` can still execute: `ended` when it is
 * absent, cancelled, expired or failed there (with the chain's status; the mirror's when absent,
 * since it never reached the chain); `live` otherwise (the mirror is then brought up to date from
 * the view, which revives a local-only cancel and re-links its refund); `unknown` when the view
 * cannot be read.
 */
async function chainSaysEnded(ctx: ScopeContext, prop: AccountProposal): Promise<ChainEnd> {
  const account = await prisma.merchantAccount.findFirst({
    where: { id: prop.accountId, ...tenantOf(ctx) },
    select: { nearAccountId: true },
  });
  if (!account?.nearAccountId) return { verdict: 'unknown' };
  let v: ContractProposalView | null;
  try {
    v = await nearClient(ctx.livemode).view<ContractProposalView | null>(
      account.nearAccountId,
      'get_proposal',
      { id: prop.onchainId },
    );
  } catch (err) {
    log('warn', 'refund: get_proposal failed; not treating the proposal as ended', {
      proposalId: prop.id,
      err: String(err),
    });
    return { verdict: 'unknown' };
  }
  if (!v) return { verdict: 'ended', status: prop.status };
  if (ENDED_STATUSES.has(v.status)) return { verdict: 'ended', status: v.status };
  await tenantTransaction(ctx, (tx) => applyProposalView(tx, ctx, prop.id, v));
  log('warn', 'refund: a refund proposal the mirror shows as ended is live on chain', {
    proposalId: prop.id,
    chainStatus: v.status,
  });
  return { verdict: 'live' };
}

/** Statuses a refund proposal can end in without executing (mirror and contract alike). */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'expired', 'failed']);

/**
 * The strict check before a return is drafted AGAIN (the review queue's refund action): `prop`
 * may never execute. The mirror must show it ended AND the contract's `get_proposal` view must
 * show it absent, cancelled, expired or failed — a status in Postgres alone is never enough, since
 * a relay or a local-only cancel may disagree with the chain. A relay claim inside its lease (a
 * `propose` possibly in flight) is not ended either. Returns `ended` with how it ended on chain
 * (the caller maps that to the review reason and the public event, never the mirror's possibly
 * stale status), `live`, or `unknown` (the view cannot be read: the caller refuses and the person
 * retries).
 */
export async function verifiedEndedOnChain(
  ctx: ScopeContext,
  prop: AccountProposal,
  now = Date.now(),
): Promise<ChainEnd> {
  if (!ENDED_STATUSES.has(prop.status)) return { verdict: 'live' };
  if (prop.relayClaimedAt && prop.relayClaimedAt.getTime() > now - RELAY_CLAIM_LEASE_MS) {
    return { verdict: 'live' };
  }
  return chainSaysEnded(ctx, prop);
}

/** Review reason for a proposal that ended without executing. */
export const ENDED_REVIEW: Readonly<Record<string, string>> = {
  cancelled: REVIEW.proposalCancelled,
  expired: REVIEW.proposalExpired,
  failed: REVIEW.transferFailed,
};

// ─── sweeper ─────────────────────────────────────────────────────────────────

const SWEEP_BATCH = 100;
const viaStore = { OR: [{ refundType: null }, { refundType: 'INTENTS' as const }] };

/**
 * Every minute (worker): the safety net behind the post-commit `onReturnNeeded` hook. Queues
 * returns the hook missed (a store-path refund, an overpay excess, a swapped late deposit with no
 * refund row), records direct 1Click refunds, and retries pending returns that have a destination
 * but no draft yet, and detaches refunds whose proposal was cancelled, expired or failed into the
 * review queue. Returns how many returns it touched.
 */
export async function sweepReturns(): Promise<number> {
  let n = 0;
  const run = async (what: string, id: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      n++;
    } catch (err) {
      log('error', 'return sweep failed', { what, id, err: String(err) });
    }
  };
  const ctxOf = (p: { merchantId: string; livemode: boolean }) => ({
    merchantId: p.merchantId,
    livemode: p.livemode,
  });
  // Kept small is per reason (C40): each loop skips only payments whose own reason was kept.
  const notKept = (reason: ReturnReason) => ({ NOT: { keptSmallReasons: { has: reason } } });

  // 1Click refunded into the merchant account (underpaid, failed, late, …).
  const refunded = await prisma.payment.findMany({
    where: {
      // One reason per such payment (1Click refunded the whole deposit): nothing queued or kept.
      // (A store's own refunds never count here: they are not 1Click's returns.)
      refunds: { none: { reason: { not: 'merchant' } } },
      keptSmallReasons: { isEmpty: true },
      refundsRecorded: { isEmpty: false },
      refundedAmount: { gt: 0 },
      quote: viaStore,
    },
    include: { quote: true },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const p of refunded) {
    const reason = p.refundsRecorded[0] as ReturnReason;
    await run('refunded', p.id, () =>
      queueReturn(ctxOf(p), p, {
        reason,
        assetId: p.quote.originAssetId,
        amount: p.refundedAmount!.toFixed(0),
      }),
    );
  }

  // An overpay excess refunded into the merchant account.
  const overpaid = await prisma.payment.findMany({
    where: {
      refunds: { none: { reason: 'overpaid' } },
      ...notKept('overpaid'),
      // Settled — and possibly refunded by the store since: the excess is still due.
      status: { in: ['SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
      overpaidAmount: { gt: 0 },
      quote: viaStore,
    },
    include: { quote: true },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const p of overpaid) {
    await run('overpaid', p.id, () =>
      queueReturn(ctxOf(p), p, {
        reason: 'overpaid',
        assetId: p.quote.originAssetId,
        amount: p.overpaidAmount!.toFixed(0),
      }),
    );
  }

  // A late deposit 1Click swapped into the merchant account (its transfer was claimed).
  const late = await prisma.payment.findMany({
    where: {
      refunds: { none: { reason: 'late' } },
      ...notKept('late'),
      status: 'REFUNDING',
      isLate: true,
      amountOut: { gt: 0 },
      settlementClaims: { some: {} },
    },
    include: { session: { select: { destAsset: true } } },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const p of late) {
    await run('late', p.id, () =>
      queueReturn(ctxOf(p), p, {
        reason: 'late',
        assetId: p.session.destAsset,
        amount: p.amountOut!.toFixed(0),
      }),
    );
  }

  // The excess of a late or held deposit swapped into the merchant account (M-2): its own return
  // (a sanctions-held payment's goes to the review queue, never drafted on its own — C40).
  const lateExcess = await prisma.payment.findMany({
    where: {
      OR: [
        { isLate: true, status: { in: ['REFUNDING', 'REFUNDED'] } },
        { heldReason: 'sanctions', status: { in: ['HELD', 'REFUNDING', 'REFUNDED'] } },
      ],
      oneclickStatus: 'SUCCESS',
      refundedAmount: { gt: 0 },
      ...notKept('overpaid'),
      quote: viaStore,
      settlementClaims: { some: {} },
      refunds: { none: { reason: 'overpaid' } },
    },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const p of lateExcess) {
    await run('late-excess', p.id, () => queueExcessReturn(ctxOf(p), p.id));
  }

  // 1Click refunded straight to the shopper's own address: recorded only.
  const direct = await prisma.payment.findMany({
    where: {
      refunds: { none: { reason: { not: 'merchant' } } },
      refundedAmount: { gt: 0 },
      quote: { refundType: 'ORIGIN_CHAIN' },
      status: { in: ['REFUNDED', 'SETTLED', 'PARTIALLY_REFUNDED'] },
    },
    include: { quote: true },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const p of direct) {
    const reason = (p.refundsRecorded[0] ?? 'overpaid') as ReturnReason;
    await run('direct', p.id, () =>
      recordDirectRefund(ctxOf(p), p, p.quote, reason, p.refundedAmount!.toFixed(0)),
    );
  }

  // Linked proposals that ended without executing (a draft cancelled in Postgres records no
  // event; a missed cancelled / failed event): detach them into the review queue — except a
  // draft cancelled in Postgres that may have reached the chain (see `endedOnChain`).
  const ended = await prisma.refund.findMany({
    where: {
      status: { in: ['pending', 'submitted'] },
      proposal: { status: { in: ['cancelled', 'expired', 'failed'] } },
    },
    include: { proposal: true },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const r of ended) {
    await run('ended', r.id, async () => {
      const ctx = ctxOf(r);
      const ended = await endedOnChain(ctx, r.proposal!);
      if (!ended) return;
      await detachProposal(ctx, r.proposalId!, ENDED_REVIEW[ended] ?? REVIEW.proposalCancelled);
    });
  }

  // Merchant refunds left undrafted when their payment became sanctions-held (the loop below
  // skips them): to the sanctions review, where the store sees them (`holdMerchantRefund`).
  const heldMerchant = await prisma.refund.findMany({
    where: {
      reason: 'merchant',
      status: 'pending',
      proposalId: null,
      reviewReason: null,
      acknowledgedLegalAt: null,
      payment: { OR: [{ heldReason: 'sanctions' }, { status: 'HELD' }] },
    },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const r of heldMerchant) {
    await run('held-merchant', r.id, () => holdMerchantRefund(ctxOf(r), r.id));
  }

  // Pending returns with a destination and no draft yet (screening was down, account busy, …).
  const pending = await prisma.refund.findMany({
    where: {
      status: 'pending',
      proposalId: null,
      needsAddress: false,
      reviewReason: null,
      destination: { not: null },
      // A held payment's return is retried only once the review queue's refund action set it up:
      // the owner's typed legal acknowledgement plus a merchant-given destination (never the
      // sanctioned sender), which is what `acknowledged_legal_at` on the refund records.
      AND: [
        { OR: [{ acknowledgedLegalAt: { not: null } }, { reason: { not: 'sanctions' } }] },
        { OR: [{ acknowledgedLegalAt: { not: null } }, { payment: { status: { not: 'HELD' } } }] },
        { OR: [{ acknowledgedLegalAt: { not: null } }, { payment: { heldReason: null } }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const r of pending) {
    await run('draft', r.id, () => draftReturn(ctxOf(r), r.id));
  }
  return n;
}

// ─── wiring ──────────────────────────────────────────────────────────────────

export const REFUND_EXECUTED_HANDLER = 'checkout-refund-executed';
export const REFUND_FAILED_HANDLER = 'checkout-refund-failed';
export const REFUND_CANCELLED_HANDLER = 'checkout-refund-cancelled';

/** Registers `queueReturn` as the watcher hook and the proposal-outcome handlers (once). */
export function registerRefundHooks(): void {
  onReturnNeeded((payment, info) =>
    queueReturn({ merchantId: payment.merchantId, livemode: payment.livemode }, payment, info).then(
      () => undefined,
    ),
  );
  const T = AccountEventTypes;
  if (!handlerNamesFor(T.proposalExecuted).includes(REFUND_EXECUTED_HANDLER)) {
    registerEventHandler(T.proposalExecuted, REFUND_EXECUTED_HANDLER, onRefundProposalExecuted);
  }
  if (!handlerNamesFor(T.proposalFailed).includes(REFUND_FAILED_HANDLER)) {
    registerEventHandler(T.proposalFailed, REFUND_FAILED_HANDLER, onRefundProposalFailed);
  }
  if (!handlerNamesFor(T.proposalCancelled).includes(REFUND_CANCELLED_HANDLER)) {
    registerEventHandler(T.proposalCancelled, REFUND_CANCELLED_HANDLER, onRefundProposalCancelled);
  }
}
