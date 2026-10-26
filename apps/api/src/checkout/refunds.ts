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
import { Prisma, type Event, type Payment, type Quote, type Refund } from '@prisma/client';
import { SMALL_OVERPAY_USD } from '@tendr/contracts';
import { z } from 'zod';
import { createSystemDraftInTx, SUPPORTED_CHAINS } from '../accounts/proposals.js';
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
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { registerEventHandler, handlerNamesFor } from '../jobs/handlers.js';
import { isValidAddress } from './address-format.js';
import { isExchangeAddress } from './exchanges.js';
import { gasEstimateUsd } from './gas-estimates.js';
import { HOLD_NOTICE } from './hold.js';
import { screenAddress, type ScreeningOutcome } from './screening.js';
import type { ShopperCtx } from './quotes.js';
import { hostedUrl } from './sessions.js';
import { tokenInfo } from './tokens.js';
import { onReturnNeeded, type ReturnReason } from './watcher.js';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
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

/** USD per base unit of `assetId`: the token list's price, else the quote's own in/out ratio. */
async function usdPerUnit(
  livemode: boolean,
  assetId: string,
  quote: Pick<Quote, 'originAssetId' | 'amountIn' | 'amountInUsd'>,
): Promise<Dec | null> {
  try {
    const t = await tokenInfo(livemode, assetId);
    if (t.priceUsd && D(t.priceUsd).gt(0)) return D(t.priceUsd).div(D(10).pow(t.decimals));
  } catch {
    // Unlisted or the provider is down: fall back to the quote.
  }
  if (assetId === quote.originAssetId && quote.amountInUsd && quote.amountIn.gt(0)) {
    return quote.amountInUsd.div(quote.amountIn);
  }
  return null;
}

/**
 * `amount` less the estimated return fee (`feeUsd` converted at `perUnit`, rounded up): the net
 * sent back and its USD value.
 */
export function netOfReturnFee(
  amount: bigint,
  perUnit: Dec,
  feeUsd: Dec,
): { fee: bigint; net: bigint; netUsd: Dec } {
  const fee = perUnit.gt(0) ? BigInt(feeUsd.div(perUnit).ceil().toFixed(0)) : 0n;
  const net = amount > fee ? amount - fee : 0n;
  return { fee: fee > amount ? amount : fee, net, netUsd: perUnit.mul(net.toString()) };
}

// ─── queueing ────────────────────────────────────────────────────────────────

const tenantOf = (ctx: ScopeContext) => ({ merchantId: ctx.merchantId, livemode: ctx.livemode });

async function lockPayment(tx: Tx, ctx: ScopeContext, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${id} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
}
async function lockRefund(tx: Tx, ctx: ScopeContext, id: string): Promise<void> {
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
  if (p.keptSmallOverpayment) return null;

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
 * The return is worth less than SMALL_OVERPAY_USD after the return fee: the merchant keeps it
 * (`kept_small_overpayment`), no signer. A payment waiting in REFUNDING for this return is done
 * (REFUNDED), and a late-deposit session waiting on it closes.
 */
async function keepSmall(ctx: ScopeContext, paymentId: string, reason: ReturnReason) {
  await tenantTransaction(ctx, async (tx) => {
    await lockPayment(tx, ctx, paymentId);
    const p = await tx.payment.findFirstOrThrow({ where: { id: paymentId, ...tenantOf(ctx) } });
    if (p.keptSmallOverpayment) return;
    await tx.payment.updateMany({
      where: { id: p.id, ...tenantOf(ctx) },
      data: { keptSmallOverpayment: true },
    });
    if (p.status === 'REFUNDING') {
      await transitionPayment(tx, ctx, p.id, 'REFUNDED', {
        reason,
        kept_small_overpayment: true,
      });
      await closeSession(tx, ctx, p.sessionId, p.id);
    }
  });
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

function refundPayload(r: Refund, sessionId: string, externalRef: string | null) {
  return {
    refund_id: r.id,
    payment_id: r.paymentId,
    session_id: sessionId,
    external_ref: externalRef,
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
async function draftIfReady(ctx: ScopeContext, refundId: string): Promise<Refund> {
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
 */
export async function draftReturn(
  ctx: ScopeContext,
  refundId: string,
  opts: { screened?: boolean } = {},
): Promise<Refund> {
  const r = await prisma.refund.findFirst({
    where: { id: refundId, ...tenantOf(ctx) },
    include: { payment: { select: { status: true, sessionId: true } } },
  });
  if (!r) throw notFound('Refund not found');
  if (r.proposalId || r.status !== 'pending' || r.needsAddress || r.reviewReason) return r;
  if ((r.payment.status === 'HELD' || r.reason === 'sanctions') && !r.acknowledgedLegalAt) {
    throw legalAckRequired();
  }
  if (!r.destination || !r.destinationChain) return r;
  // Screened first: a sanctioned destination is flagged whatever the route.
  if (!opts.screened) {
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
      if (cur.proposalId || cur.status !== 'pending' || cur.needsAddress || cur.reviewReason) {
        return cur;
      }
      const proposal = await createSystemDraftInTx(tx, ctx, {
        kind: 'refund',
        action,
        reason: `return to sender: ${r.reason} (${r.id})`,
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

async function markReview(ctx: ScopeContext, refundId: string, reason: string): Promise<Refund> {
  await prisma.refund.updateMany({
    where: { id: refundId, ...tenantOf(ctx), proposalId: null },
    data: { reviewReason: reason },
  });
  log('warn', 'return to sender needs review', { refundId, reason });
  return prisma.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
}

/**
 * The destination screened as sanctioned: no draft, ever. The refund is failed with
 * `review_reason = sanctions`, and `payment.held` (with the non-custodial notice) is recorded
 * once for the payment.
 */
async function blockReturn(ctx: ScopeContext, refundId: string): Promise<Refund> {
  return tenantTransaction(ctx, async (tx) => {
    await lockRefund(tx, ctx, refundId);
    const r = await tx.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
    await tx.refund.updateMany({
      where: { id: r.id, ...tenantOf(ctx) },
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
 * Queues the return of a HELD (sanctions) payment's funds, which 1Click swapped into the merchant
 * account (`amount_out` of the settlement asset). The row is a review item: drafting it needs
 * `acknowledged_legal_at` (set by the dashboard action, Task 10) and, as every return, a
 * destination that does not screen as sanctioned.
 */
export async function queueHeldReturn(ctx: ScopeContext, paymentId: string): Promise<Refund> {
  const p = await prisma.payment.findFirst({ where: { id: paymentId, ...tenantOf(ctx) } });
  if (!p) throw notFound('Payment not found');
  if (p.status !== 'HELD') throw conflict('Only a held payment is returned this way');
  const s = await prisma.session.findFirstOrThrow({
    where: { id: p.sessionId, ...tenantOf(ctx) },
    select: { destAsset: true },
  });
  const q = await prisma.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
  // Swapped (1Click SUCCESS): the settlement asset's amount_out. Refunded into the account (a
  // store-path refund of a short or failed deposit): the origin asset 1Click refunded.
  let held: { assetId: string; amount: Prisma.Decimal } | null = null;
  if (p.oneclickStatus === 'SUCCESS') {
    held = { assetId: s.destAsset, amount: p.amountOut ?? q.amountOut };
  } else if (q.refundType !== 'ORIGIN_CHAIN' && p.refundedAmount?.gt(0)) {
    held = { assetId: q.originAssetId, amount: p.refundedAmount };
  }
  if (!held || held.amount.lte(0)) throw conflict('Nothing reached the merchant account');
  const chain = p.senderChain ? contractChainOf(p.senderChain) : null;
  const { refund } = await insertRefund(ctx, {
    paymentId: p.id,
    reason: 'sanctions',
    assetId: held.assetId,
    amount: held.amount.toFixed(0),
    destination: p.senderAddress,
    destinationChain: chain,
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

const walletNotAllowed = () =>
  new AppError('WALLET_NOT_ALLOWED', 'This address cannot receive the refund', 403);

/**
 * The shopper says where an exchange-sent return should go (Ruling C3): format check, route
 * check, sanctions screen (block → 403 WALLET_NOT_ALLOWED, and the return goes to review), then
 * the address is stored, `needs_address` clears and the draft is created.
 */
export async function provideRefundAddress(
  ctx: ShopperCtx,
  input: z.infer<typeof RefundAddressInputSchema>,
) {
  const chain = contractChainOf(input.chain);
  const invalid = (msg: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', msg, 400, details);
  if (!chain) throw invalid('Refunds cannot be sent on this network');
  const oneclick = oneclickChainOf(chain);
  if (!isValidAddress(oneclick, input.address)) {
    throw invalid(`That is not a valid ${oneclick} address`, { field: 'address' });
  }
  const waiting = await ctx.db.refund.findMany({
    where: {
      needsAddress: true,
      status: 'pending',
      payment: { sessionId: ctx.sessionId },
      ...(input.refund_id ? { id: input.refund_id } : {}),
    },
  });
  if (waiting.length === 0) throw notFound('No refund is waiting for an address');
  if (waiting.length > 1) throw invalid('Say which refund (refund_id)');
  const r = waiting[0]!;
  if (!returnRoute(r.assetId, chain, input.address)) {
    throw invalid('This refund cannot be sent on that network', {
      chains: returnChainsOf(r.assetId).map(oneclickChainOf),
    });
  }
  const { decision } = await deps.screen(ctx, {
    sessionId: ctx.sessionId,
    address: input.address,
    chain: oneclick,
  });
  if (decision === 'unavailable') {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Please try again in a few minutes', 503);
  }
  if (decision === 'block') {
    await blockReturn(ctx, r.id);
    throw walletNotAllowed();
  }
  const { count } = await prisma.refund.updateMany({
    where: { id: r.id, ...tenantOf(ctx), needsAddress: true, status: 'pending' },
    data: { destination: input.address, destinationChain: chain, needsAddress: false },
  });
  if (count === 0) throw conflict('This refund already has an address');
  const drafted = await draftIfReadyScreened(ctx, r.id);
  return { refund_id: drafted.id, status: drafted.proposalId ? 'pending_approval' : 'queued' };
}

async function draftIfReadyScreened(ctx: ScopeContext, refundId: string): Promise<Refund> {
  try {
    return await draftReturn(ctx, refundId, { screened: true });
  } catch (err) {
    log('warn', 'return to sender not drafted yet', { refundId, err: String(err) });
    return prisma.refund.findFirstOrThrow({ where: { id: refundId, ...tenantOf(ctx) } });
  }
}

/** The shopper-facing returns of a session (the checkout's "Tell us where to send it"). */
export async function shopperRefunds(ctx: ShopperCtx) {
  const rows = await ctx.db.refund.findMany({
    where: { payment: { sessionId: ctx.sessionId } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    payment_id: r.paymentId,
    asset: r.assetId,
    amount: r.amount.toFixed(0),
    needs_address: r.needsAddress,
    chains: r.needsAddress ? returnChainsOf(r.assetId).map(oneclickChainOf) : undefined,
    state: r.status === 'confirmed' ? 'sent' : r.status === 'failed' ? 'review' : 'processing',
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
  try {
    await getMailer().send({
      to: s.customerEmail,
      template: 'refund_needs_address',
      data: {
        merchant_name: s.merchant.name,
        amount,
        refund_id: r.id,
        checkout_url: hostedUrl(s.id),
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
  const refunds = await prisma.refund.findMany({ where: { proposalId, ...tenantOf(ctx) } });
  for (const r of refunds) {
    await tenantTransaction(ctx, async (tx) => {
      await lockRefund(tx, ctx, r.id);
      const cur = await tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
      if (cur.status === 'confirmed') return;
      await tx.refund.updateMany({
        where: { id: r.id, ...tenantOf(ctx) },
        data: {
          status: 'confirmed',
          refundTxHash: typeof txHash === 'string' ? txHash : null,
          reviewReason: null,
        },
      });
      await lockPayment(tx, ctx, r.paymentId);
      const p = await tx.payment.findFirstOrThrow({
        where: { id: r.paymentId, ...tenantOf(ctx) },
      });
      if (p.status === 'HELD') {
        await transitionPayment(tx, ctx, p.id, 'REFUNDING', { reason: r.reason, refund_id: r.id });
      }
      if (p.status === 'HELD' || p.status === 'REFUNDING') {
        await transitionPayment(tx, ctx, p.id, 'REFUNDED', { reason: r.reason, refund_id: r.id });
        await closeSession(tx, ctx, p.sessionId, p.id);
      }
      const s = await tx.session.findFirstOrThrow({
        where: { id: p.sessionId, ...tenantOf(ctx) },
        select: { externalRef: true },
      });
      const done = await tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
      await recordEvent(tx, ctx, {
        aggregateType: 'refund',
        aggregateId: r.id,
        type: 'refund.sent',
        payload: { ...refundPayload(done, p.sessionId, s.externalRef), tx_hash: done.refundTxHash },
      });
    });
  }
}

/** `account.proposal.failed` on a refund proposal (the transfer failed): the return goes to review. */
export async function onRefundProposalFailed(e: Event): Promise<void> {
  const ctx = eventCtx(e);
  const proposalId = proposalIdOf(e);
  if (!ctx || !proposalId) return;
  await prisma.refund.updateMany({
    where: { proposalId, ...tenantOf(ctx), status: { in: ['pending', 'submitted'] } },
    data: { status: 'failed', reviewReason: REVIEW.transferFailed },
  });
}

// ─── sweeper ─────────────────────────────────────────────────────────────────

const SWEEP_BATCH = 100;
const viaStore = { OR: [{ refundType: null }, { refundType: 'INTENTS' as const }] };

/**
 * Every minute (worker): the safety net behind the post-commit `onReturnNeeded` hook. Queues
 * returns the hook missed (a store-path refund, an overpay excess, a swapped late deposit with no
 * refund row), records direct 1Click refunds, and retries pending returns that have a destination
 * but no draft yet. Returns how many returns it touched.
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
  const noRefund = { refunds: { none: {} }, keptSmallOverpayment: false };

  // 1Click refunded into the merchant account (underpaid, failed, late, …).
  const refunded = await prisma.payment.findMany({
    where: {
      ...noRefund,
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
    where: { ...noRefund, status: 'SETTLED', overpaidAmount: { gt: 0 }, quote: viaStore },
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
      ...noRefund,
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

  // 1Click refunded straight to the shopper's own address: recorded only.
  const direct = await prisma.payment.findMany({
    where: {
      refunds: { none: {} },
      refundedAmount: { gt: 0 },
      quote: { refundType: 'ORIGIN_CHAIN' },
      status: { in: ['REFUNDED', 'SETTLED'] },
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

  // Pending returns with a destination and no draft yet (screening was down, account busy, …).
  const pending = await prisma.refund.findMany({
    where: {
      status: 'pending',
      proposalId: null,
      needsAddress: false,
      reviewReason: null,
      destination: { not: null },
      OR: [{ acknowledgedLegalAt: { not: null } }, { reason: { not: 'sanctions' } }],
      payment: { status: { not: 'HELD' } },
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
}
