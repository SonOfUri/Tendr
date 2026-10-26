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
import {
  Prisma,
  type AccountProposal,
  type Event,
  type Payment,
  type Quote,
  type Refund,
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
import { HOLD_NOTICE } from './hold.js';
import { screenAddress, type ScreeningOutcome } from './screening.js';
import type { ShopperCtx } from './quotes.js';
import { providerFor, type StatusResponse } from './oneclick/index.js';
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
  proposalCancelled: 'proposal_cancelled',
  proposalExpired: 'proposal_expired',
  amountUnknown: 'amount_unknown',
  /** Re-netted for a new destination in the review queue, the return fell under SMALL_OVERPAY_USD. */
  keptSmall: 'kept_small',
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

/** USD per base unit of `assetId`: the token list's price, else the quote's own in/out ratio. */
export async function usdPerUnit(
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
export async function keepSmall(ctx: ScopeContext, paymentId: string, reason: ReturnReason) {
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

export function refundPayload(r: Refund, sessionId: string, externalRef: string | null) {
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

async function markReview(ctx: ScopeContext, refundId: string, reason: string): Promise<Refund> {
  await prisma.refund.updateMany({
    where: { id: refundId, ...tenantOf(ctx), proposalId: null },
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
    await tx.refund.updateMany({
      where: { id: r.id, ...tenantOf(ctx), status: 'pending', proposalId: null },
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
  const { count } = await prisma.refund.updateMany({
    where: {
      id: r.id,
      ...tenantOf(ctx),
      needsAddress: true,
      status: 'pending',
      ...(tokenHash ? { addressTokenHash: tokenHash } : {}),
    },
    data: {
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
  const drafted = await draftIfReadyScreened(ctx, r.id);
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
 * Whether a proposal the mirror shows as ended really cannot execute any more. A draft cancelled
 * only in Postgres after a relay was attempted (`relay_claimed_at` still set — the cancel went
 * through a stale claim — or a relayed transaction on record) may be live on chain: the contract's
 * `get_proposal` view decides. Absent, cancelled, expired or failed there → ended. Pending,
 * timelocked, executing or executed → not ended: the mirror is brought up to date from the view
 * (which revives the local-only cancel and re-links the refund, proposals.ts). A view that
 * cannot be read → not ended (the next sweep asks again). Every other ended status is final.
 */
async function endedOnChain(ctx: ScopeContext, prop: AccountProposal): Promise<boolean> {
  if (prop.status !== 'cancelled' || (prop.relayClaimedAt === null && prop.lastTxHash === null)) {
    return true;
  }
  return (await chainSaysEnded(ctx, prop)) === 'ended';
}

/**
 * Asks the contract's `get_proposal` view whether `prop` can still execute: `ended` when it is
 * absent, cancelled, expired or failed there; `live` otherwise (the mirror is then brought up to
 * date from the view, which revives a local-only cancel and re-links its refund); `unknown` when
 * the view cannot be read.
 */
async function chainSaysEnded(
  ctx: ScopeContext,
  prop: AccountProposal,
): Promise<'ended' | 'live' | 'unknown'> {
  const account = await prisma.merchantAccount.findFirst({
    where: { id: prop.accountId, ...tenantOf(ctx) },
    select: { nearAccountId: true },
  });
  if (!account?.nearAccountId) return 'unknown';
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
    return 'unknown';
  }
  if (!v || ['cancelled', 'expired', 'failed'].includes(v.status)) return 'ended';
  await tenantTransaction(ctx, (tx) => applyProposalView(tx, ctx, prop.id, v));
  log('warn', 'refund: a refund proposal the mirror shows as ended is live on chain', {
    proposalId: prop.id,
    chainStatus: v.status,
  });
  return 'live';
}

/** Statuses a refund proposal can end in without executing (mirror and contract alike). */
const ENDED_STATUSES = new Set(['cancelled', 'expired', 'failed']);

/**
 * The strict check before a return is drafted AGAIN (the review queue's refund action): `prop`
 * may never execute. The mirror must show it ended AND the contract's `get_proposal` view must
 * show it absent, cancelled, expired or failed — a status in Postgres alone is never enough, since
 * a relay or a local-only cancel may disagree with the chain. A relay claim inside its lease (a
 * `propose` possibly in flight) is not ended either. Returns `ended`, `live` or `unknown` (the
 * view cannot be read: the caller refuses and the person retries).
 */
export async function verifiedEndedOnChain(
  ctx: ScopeContext,
  prop: AccountProposal,
  now = Date.now(),
): Promise<'ended' | 'live' | 'unknown'> {
  if (!ENDED_STATUSES.has(prop.status)) return 'live';
  if (prop.relayClaimedAt && prop.relayClaimedAt.getTime() > now - RELAY_CLAIM_LEASE_MS) {
    return 'live';
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
      if (!(await endedOnChain(ctx, r.proposal!))) return;
      await detachProposal(ctx, r.proposalId!, ENDED_REVIEW[r.proposal!.status]!);
    });
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
