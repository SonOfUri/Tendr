// Merchant-initiated refunds (WooCommerce plugin spec §7, Task 5): `POST /v1/refunds`.
//
// A store refund returns money to the wallet that paid. It is a `refunds` row with reason
// `merchant`, drafted through the checkout-core return path (refunds.ts) as a system `refund`
// proposal that the store's signers approve. Nothing here moves funds.
//
// - Reuses the return path, never forks it: the sender's destination is sanctions-screened right
//   before the draft (`draftReturn`; a block → no draft, the review queue, `payment.held`); a
//   payment already held for sanctions goes to the review queue (legal acknowledgement plus a
//   merchant-given destination); an exchange sender waits for an address (`refund.needs_address`);
//   an asset that cannot reach the sender's chain directly goes to review (`needs_swap_route`);
//   the proposal outcomes (`refund.sent` / `refund.cancelled` / `refund.failed`) and every
//   on-chain safety net are the existing ones.
// - The merchant pays the network cost: the return is grossed up by the same return-fee estimate
//   the automatic path deducts (`grossUpForReturnFee`), so the shopper nets the requested amount
//   within the estimate's accuracy. Kept-small never applies.
// - Several per payment (partial refunds), one per `external_ref` (the WooCommerce refund id).
//   The same `external_ref` again with the same amount returns the existing refund; with another
//   amount it is CONFLICT.
// - Serialised per payment by the payment row lock, so concurrent requests can never together
//   exceed what is left (`refundableRemaining`).
import { Prisma, type Payment, type Refund, type Session } from '@prisma/client';
import { z } from 'zod';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { isExchangeAddress } from './exchanges.js';
import { convertToUsd, minorUnits, unsupportedCurrency } from './fx.js';
import { gasEstimateUsd } from './gas-estimates.js';
import {
  accountBalance,
  contractChainOf,
  draftIfReady,
  emailNeedsAddress,
  isClosedMerchantRefund,
  lockPayment,
  lockRefund,
  merchantRefundStatus,
  publicReviewReason,
  REFUND_CANCELLED,
  refundPayload,
  refundRef,
  REVIEW,
  settledUsdOf,
} from './refunds.js';
import { grossUpForReturnFee, usdPerUnit } from './return-fee.js';
import { assetLabel } from './tokens.js';

export { merchantRefundStatus };
import { connectionMayAct } from './webhooks.js';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const tenantOf = (ctx: ScopeContext) => ({ merchantId: ctx.merchantId, livemode: ctx.livemode });

/** The caller: a store secret key, and the connection that issued it (null: a hand-made key). */
export type MerchantRefundCtx = ScopeContext & { connectionId: string | null };

const DECIMAL = /^\d{1,30}(\.\d{1,18})?$/;

export const MerchantRefundInputSchema = z
  .object({
    payment: z.string().min(1).max(64).optional(),
    session: z.string().min(1).max(64).optional(),
    /** USD (2 decimals), or `currency` when given. */
    amount: z.string().regex(DECIMAL, 'amount must be a decimal string like "10.00"'),
    /** Default USD; otherwise the session's original currency (converted at its stored rate). */
    currency: z.string().trim().min(1).max(16).optional(),
    reason: z.string().trim().max(500).optional(),
    /** The store's id for this refund (the WooCommerce refund id). */
    external_ref: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine((v) => (v.payment === undefined) !== (v.session === undefined), {
    message: 'give exactly one of payment or session',
    path: ['payment'],
  });
export type MerchantRefundInput = z.infer<typeof MerchantRefundInputSchema>;

const notRefundable = (status: string) =>
  new AppError(
    'PAYMENT_NOT_REFUNDABLE',
    'Only a settled (or partially refunded) payment can be refunded',
    409,
    { payment_status: status },
  );
const exceeds = (message: string, details?: unknown) =>
  new AppError('AMOUNT_EXCEEDS_REFUNDABLE', message, 409, details);
const invalidAmount = (message: string) =>
  new AppError('VALIDATION_ERROR', message, 400, { field: 'amount' });
const paymentNotFound = () => notFound('Payment not found');

/** Statuses a merchant refund may be requested in. */
const REFUNDABLE: ReadonlySet<string> = new Set(['SETTLED', 'PARTIALLY_REFUNDED']);

// ─── amounts ─────────────────────────────────────────────────────────────────

/** "10.5" → 10.50 USD, exactly; at most 2 decimals, more than 0. */
function usdOf(amount: string): Dec {
  const [, frac = ''] = amount.split('.');
  if (frac.length > 2) throw invalidAmount('amount in USD allows at most 2 decimal places');
  const v = D(amount);
  if (!v.gt(0)) throw invalidAmount('amount must be greater than 0');
  return v;
}

/**
 * The requested USD amount, and whether it came from the session's original currency (then a
 * rounding overshoot is clamped to what is left, see `requestMerchantRefund`). USD by default;
 * the session's original currency is converted with the rate stored on the session at creation
 * (Task 4's `convertToUsd`: rounded up to the cent). Anything else is 400 UNSUPPORTED_CURRENCY.
 */
function requestedUsd(
  input: Pick<MerchantRefundInput, 'amount' | 'currency'>,
  s: Pick<Session, 'originalCurrency' | 'fxRate' | 'fxSource' | 'fxAsOf'>,
): { usd: Dec; converted: boolean } {
  const currency = (input.currency ?? 'USD').toUpperCase();
  if (currency === 'USD') return { usd: usdOf(input.amount), converted: false };
  if (
    currency !== s.originalCurrency ||
    !s.fxRate ||
    !s.fxSource ||
    !s.fxAsOf ||
    minorUnits(currency) === undefined
  ) {
    throw unsupportedCurrency(currency);
  }
  const c = convertToUsd(input.amount, currency, {
    currency,
    rate: s.fxRate.toFixed(),
    source: s.fxSource,
    asOf: s.fxAsOf,
  });
  return { usd: D(c.usd), converted: true };
}

/**
 * What is left to refund of payment `p` by the store, in USD:
 *
 *     settled order amount − Σ requested USD of its merchant refunds that are not closed
 *
 * - "Settled order amount" is `settledUsdOf`: the USD order total the payment settled.
 * - A merchant refund counts from the moment it is requested until it ends without executing
 *   (`isClosedMerchantRefund`: rejected, expired or failed — the store undid it). Pending,
 *   awaiting signers, in review (sanctions, needs a swap route, waiting for an address) and sent
 *   refunds all count: each may still send, or has sent, money.
 * - No automatic return reduces it. Only `overpaid` (and its direct 1Click record) can exist on a
 *   SETTLED payment, and it returns the excess the shopper sent on top of the order amount —
 *   money that is not part of the settled order amount. `late`, `underpaid`, `failed` and
 *   `expired` returns belong to payments that never settle, and a held payment's `sanctions`
 *   return to a HELD one (never SETTLED).
 *
 * Read under the payment row lock (the caller holds it), so concurrent requests serialise on it.
 */
async function refundableRemaining(
  tx: Tx,
  ctx: ScopeContext,
  paymentId: string,
  settled: Dec,
): Promise<Dec> {
  const rows = await tx.refund.findMany({
    where: { paymentId, ...tenantOf(ctx), reason: 'merchant' },
    select: { reason: true, status: true, reviewReason: true, requestedAmountUsd: true },
  });
  const counted = rows.filter((r) => !isClosedMerchantRefund(r));
  const committed = counted.reduce((sum, r) => sum.add(r.requestedAmountUsd ?? 0), D(0));
  return settled.sub(committed);
}

// ─── who may refund what ─────────────────────────────────────────────────────

/**
 * Ruling W8: a connection key refunds only payments whose session was created by its own
 * connection, or by a connection it replaced on a site re-connect (the `replaced_by_id` chain,
 * followed by `liveConnectionId`). A hand-made key (no connection) refunds any payment of its
 * store. Anything else is NOT_FOUND, exactly like an unknown payment.
 */
function mayRefund(ctx: MerchantRefundCtx, sessionConnectionId: string | null) {
  return connectionMayAct(ctx.connectionId, ctx.merchantId, sessionConnectionId);
}

async function paymentFor(ctx: ScopeContext, input: MerchantRefundInput): Promise<Payment> {
  if (input.payment) {
    const p = await prisma.payment.findFirst({ where: { id: input.payment, ...tenantOf(ctx) } });
    if (!p) throw paymentNotFound();
    return p;
  }
  const s = await prisma.session.findFirst({
    where: { id: input.session!, ...tenantOf(ctx) },
    select: { id: true },
  });
  if (!s) throw notFound('Session not found');
  // The session's own payment: the one that settled (late deposits never settle), else any.
  const payments = await prisma.payment.findMany({
    where: { sessionId: s.id, ...tenantOf(ctx), isLate: false },
    orderBy: { createdAt: 'asc' },
  });
  const p =
    payments.find((x) => REFUNDABLE.has(x.status) || x.settledAt !== null) ?? payments[0] ?? null;
  if (!p) throw notRefundable('NONE');
  return p;
}

// ─── the request ─────────────────────────────────────────────────────────────

/** What the route returns for a merchant refund. */
export async function merchantRefundView(r: Refund) {
  // C6: what the refund returns — the asset in base units with its symbol and decimals (best
  // effort) — and why it waits for a person, from the public allowlist only.
  const label = await assetLabel(r.livemode, r.assetId);
  return {
    id: r.id,
    status: merchantRefundStatus(r),
    amount_usd: (r.requestedAmountUsd ?? D(0)).toFixed(2),
    refund_external_ref: r.externalRef,
    payment_id: r.paymentId,
    asset_id: r.assetId,
    asset_symbol: label?.symbol ?? null,
    asset_decimals: label?.decimals ?? null,
    amount: r.amount.toFixed(),
    review_reason: publicReviewReason(r.reviewReason),
    created: Math.floor(r.createdAt.getTime() / 1000),
  };
}

/**
 * Requests a merchant refund of a settled payment (see the module comment). Returns the refund and
 * whether this call created it (false: the same `external_ref` and amount were already asked).
 *
 * Errors: 404 (unknown payment or session, or a connection key's foreign payment), 400
 * (UNSUPPORTED_CURRENCY, VALIDATION_ERROR), 409 PAYMENT_NOT_REFUNDABLE, 409
 * AMOUNT_EXCEEDS_REFUNDABLE (more than is left, or the return with its network cost is more than
 * the merchant account holds), 409 CONFLICT (`external_ref` reused with another amount), 503
 * PROVIDER_UNAVAILABLE (no price for the settlement asset).
 */
export async function requestMerchantRefund(
  ctx: MerchantRefundCtx,
  input: MerchantRefundInput,
): Promise<{ refund: Refund; created: boolean }> {
  const p0 = await paymentFor(ctx, input);
  const s = await prisma.session.findFirstOrThrow({
    where: { id: p0.sessionId, ...tenantOf(ctx) },
  });
  if (!(await mayRefund(ctx, s.connectionId))) throw paymentNotFound();
  const asked = requestedUsd(input, s);

  // A repeat of a refund already asked for: answered before anything else (the payment may be
  // fully refunded by now). Re-checked under the lock below for a concurrent first request.
  const known = await prisma.refund.findFirst({
    where: {
      paymentId: p0.id,
      ...tenantOf(ctx),
      reason: 'merchant',
      externalRef: input.external_ref,
    },
  });
  if (known) {
    const tolerance = await roundingTolerance(prisma, ctx, p0.id, known.createdAt);
    return { refund: sameOrConflict(known, asked, tolerance), created: false };
  }
  if (!REFUNDABLE.has(p0.status)) throw notRefundable(p0.status);

  const q = await prisma.quote.findFirstOrThrow({ where: { id: p0.quoteId, ...tenantOf(ctx) } });
  const settled = settledUsdOf(s, q);
  if (!settled) throw notRefundable(p0.status);

  // Prices and the account balance are read before the lock (provider and chain calls).
  const perUnit = await usdPerUnit(ctx.livemode, s.destAsset, q);
  if (!perUnit || !perUnit.gt(0)) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'No price for the settlement asset; retry', 503);
  }
  const feeUsd = D(p0.senderChain ? gasEstimateUsd(p0.senderChain) : '0');
  const balance = await accountBalance(ctx, s.destAsset);

  const result = await tenantTransaction(ctx, async (tx) => {
    await lockPayment(tx, ctx, p0.id);
    const p = await tx.payment.findFirstOrThrow({ where: { id: p0.id, ...tenantOf(ctx) } });
    const remaining = await refundableRemaining(tx, ctx, p.id, settled);
    const existing = await tx.refund.findFirst({
      where: {
        paymentId: p.id,
        ...tenantOf(ctx),
        reason: 'merchant',
        externalRef: input.external_ref,
      },
    });
    if (existing) {
      const tolerance = await roundingTolerance(tx, ctx, p.id, existing.createdAt);
      return { refund: sameOrConflict(existing, asked, tolerance), created: false };
    }
    if (!REFUNDABLE.has(p.status)) throw notRefundable(p.status);
    // A refund in the original currency is converted rounding up to the cent, and so was each
    // earlier one, so "refund the rest" can overshoot what is left by a cent for itself plus one
    // per earlier refund (C11). That overshoot — and only for a converted request — is clamped,
    // so a full refund in the original currency equals exactly what is left. Anything more is
    // refused like any other excess.
    let usd = asked.usd;
    if (asked.converted && usd.gt(remaining) && remaining.gt(0)) {
      if (usd.sub(remaining).lte(await roundingTolerance(tx, ctx, p.id, null))) usd = remaining;
    }
    if (usd.gt(remaining)) {
      throw exceeds('The amount is more than what is left to refund on this payment', {
        remaining_usd: (remaining.gt(0) ? remaining : D(0)).toFixed(2),
      });
    }
    const amounts = grossUpForReturnFee(usd, perUnit, feeUsd);
    if (balance !== null && amounts.gross > balance) {
      throw exceeds(
        'The merchant account does not hold enough to return this amount plus the network cost',
        { asset: s.destAsset, needed: amounts.gross.toString(), available: balance.toString() },
      );
    }
    return {
      refund: await insertMerchantRefund(tx, ctx, p, s, input, usd, amounts),
      created: true,
    };
  });

  const r = result.refund;
  if (!result.created) return result;
  log('info', 'merchant refund requested', { refundId: r.id, paymentId: r.paymentId });
  if (r.needsAddress) {
    if (s.customerEmail) await emailNeedsAddress(ctx, r.id);
    return { refund: r, created: true };
  }
  if (r.destination && r.reviewReason === null) {
    // Screened right before the draft; screening down or the account busy → drafted later by the
    // sweeper (still `pending`).
    return { refund: await draftIfReady(ctx, r.id), created: true };
  }
  return { refund: r, created: true };
}

/** The rounding up of one conversion from the original currency to USD. */
const ONE_CENT = D('0.01');

/**
 * The most an amount converted from the original currency may overshoot what is left and still
 * be clamped to it (C11): one cent for this conversion's rounding up, plus one per merchant
 * refund of the payment requested before it (`before`; null = all of them, for a new request) —
 * each rounded up when it was converted, so the cents left over add up. Counted over every
 * merchant row, closed ones too, so the answer for a stored row never changes over time (the
 * replay check and the clamp agree). Never applied to USD requests; the clamp never goes past
 * what is left, so a larger tolerance only decides "clamp" vs "refuse".
 */
async function roundingTolerance(
  db: Tx | typeof prisma,
  ctx: ScopeContext,
  paymentId: string,
  before: Date | null,
): Promise<Dec> {
  const earlier = await db.refund.count({
    where: {
      paymentId,
      ...tenantOf(ctx),
      reason: 'merchant',
      ...(before ? { createdAt: { lt: before } } : {}),
    },
  });
  return ONE_CENT.mul(earlier + 1);
}

/**
 * The same `external_ref` again: the existing refund when the amount is the same (for an amount
 * in the original currency, the same up to the rounding clamp it may have had: `tolerance`, from
 * `roundingTolerance` for the rows before it), else 409 CONFLICT. The answer depends only on the
 * stored rows and the request, so the pre-lock and the locked checks always agree.
 */
function sameOrConflict(
  existing: Refund,
  asked: { usd: Dec; converted: boolean },
  tolerance: Dec,
): Refund {
  const had = existing.requestedAmountUsd;
  const same =
    !!had &&
    (had.equals(asked.usd) ||
      (asked.converted && asked.usd.gt(had) && asked.usd.sub(had).lte(tolerance)));
  if (same) return existing;
  throw conflict('This external_ref was already used for a refund of another amount', {
    refund_id: existing.id,
    amount_usd: existing.requestedAmountUsd?.toFixed(2) ?? null,
  });
}

/**
 * Inserts the merchant refund row (payment row locked), routed as `queueReturn` routes an
 * automatic return to the same sender — minus kept-small, plus the merchant-paid network cost.
 */
async function insertMerchantRefund(
  tx: Tx,
  ctx: ScopeContext,
  p: Payment,
  s: Session,
  input: MerchantRefundInput,
  usd: Dec,
  amounts: { requested: bigint; fee: bigint; gross: bigint },
): Promise<Refund> {
  const sender = p.senderAddress;
  const senderChain = p.senderChain;
  const chain = senderChain ? contractChainOf(senderChain) : null;
  const exchange = !!sender && !!senderChain && isExchangeAddress(senderChain, sender);
  const base = {
    id: newId('ref'),
    ...tenantOf(ctx),
    paymentId: p.id,
    reason: 'merchant' as const,
    externalRef: input.external_ref,
    requestedAmountUsd: usd.toFixed(2),
    note: input.reason || null,
    assetId: s.destAsset,
  };
  let data: Prisma.RefundUncheckedCreateInput;
  if (!sender || !senderChain) {
    // No known sender: a person gives the destination in the review queue (the fee is added for
    // that chain then).
    data = { ...base, amount: amounts.requested.toString(), reviewReason: REVIEW.noSender };
  } else if (p.heldReason === 'sanctions') {
    // A payment held for sanctions (a return of it screened as sanctioned): its funds never go
    // back by themselves, nor to the sanctioned sender (C40) — the review queue, with the legal
    // acknowledgement and a merchant-given, screened destination.
    data = {
      ...base,
      amount: amounts.gross.toString(),
      returnFee: amounts.fee.toString(),
      reviewReason: REVIEW.sanctions,
    };
  } else {
    data = {
      ...base,
      amount: amounts.gross.toString(),
      returnFee: amounts.fee.toString(),
      destination: exchange ? null : sender,
      destinationChain: exchange ? null : chain,
      needsAddress: exchange,
      reviewReason: exchange || chain ? null : REVIEW.unsupportedChain,
    };
  }
  const row = await tx.refund.create({ data });
  if (exchange && !row.reviewReason) {
    await recordEvent(tx, ctx, {
      aggregateType: 'refund',
      aggregateId: row.id,
      type: 'refund.needs_address',
      payload: {
        ...refundPayload(row, p.sessionId, s.externalRef),
        sender_address: sender,
        sender_chain: senderChain,
        customer_email_on_file: s.customerEmail !== null,
      },
    });
  }
  return row;
}

// ─── cancel (W14) ────────────────────────────────────────────────────────────

const hasProposal = () =>
  new AppError(
    'REFUND_HAS_PROPOSAL',
    'This refund already has a proposal: your signers reject it (or let it expire) on the dashboard',
    409,
  );

/**
 * Cancels a merchant refund that has no proposal: pending and not drafted yet, or in review (any
 * review reason — sanctions, needs a swap route, no sender, waiting for an address). Terminal:
 * status `failed` + `store_cancelled` (`isClosedMerchantRefund`), which frees its amount, and the
 * public `refund.cancelled` (with `refund_external_ref`) once. Cancelling a closed refund again
 * returns it unchanged. With a linked proposal (or one ever drafted for it, while the refund is
 * not closed) it is 409 REFUND_HAS_PROPOSAL: the signers end it, and the proposal events tell
 * the store.
 *
 * Decided under the refund lock, then the payment lock (the order `blockReturn` and
 * `onRefundProposalExecuted` use), so it cannot race a draft: a draft that took the refund lock
 * first leaves a proposal (→ 409); a draft that comes after finds the row no longer pending and
 * drafts nothing. `ctx.connectionId` (an API key) applies the same ownership rule as requesting a
 * refund; null (a dashboard user, or a hand-made key) any refund of the store.
 */
export async function cancelMerchantRefund(
  ctx: MerchantRefundCtx,
  refundId: string,
): Promise<Refund> {
  const r0 = await prisma.refund.findFirst({
    where: { id: refundId, ...tenantOf(ctx), reason: 'merchant' },
    include: { payment: { select: { sessionId: true } } },
  });
  if (!r0) throw notFound('Refund not found');
  const s = await prisma.session.findFirstOrThrow({
    where: { id: r0.payment.sessionId, ...tenantOf(ctx) },
    select: { id: true, connectionId: true, externalRef: true },
  });
  if (!(await mayRefund(ctx, s.connectionId))) throw notFound('Refund not found');

  return tenantTransaction(ctx, async (tx) => {
    await lockRefund(tx, ctx, r0.id);
    await lockPayment(tx, ctx, r0.paymentId);
    const r = await tx.refund.findFirstOrThrow({ where: { id: r0.id, ...tenantOf(ctx) } });
    if (isClosedMerchantRefund(r)) return r;
    if (r.status === 'confirmed') throw conflict('This refund was already sent');
    if (r.proposalId !== null) throw hasProposal();
    const drafted = await tx.accountProposal.count({
      where: { refundId: r.id, ...tenantOf(ctx) },
    });
    if (drafted > 0) throw hasProposal();
    await tx.refund.updateMany({
      where: { id: r.id, ...tenantOf(ctx), proposalId: null },
      data: {
        status: 'failed',
        reviewReason: REVIEW.storeCancelled,
        needsAddress: false,
        addressTokenHash: null,
        addressTokenExpiresAt: null,
      },
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'refund',
      aggregateId: r.id,
      type: REFUND_CANCELLED,
      payload: {
        refund_id: r.id,
        payment_id: r.paymentId,
        session_id: s.id,
        external_ref: s.externalRef,
        ...refundRef(r),
        asset: r.assetId,
        amount: r.amount,
        reason: r.reason,
        status: 'cancelled',
      },
    });
    log('info', 'merchant refund cancelled by the store', { refundId: r.id });
    return tx.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
  });
}
