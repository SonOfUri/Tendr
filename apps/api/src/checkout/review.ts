// The merchant review queue (dashboard, checkout Task 10): held payments, screening that could not
// complete, return-to-sender items and returns waiting on an address — plus the two actions on it.
//
// - `acknowledgeLegal`: an OWNER (step-up at the route) types exactly LEGAL_ACK_PHRASE for a held
//   (sanctions) payment. Recorded on the payment (who, when) with an internal event. Nothing is
//   released: there is no "release" action anywhere — a hold is a non-custodial notice and the
//   funds only ever leave through a signer-approved refund proposal.
// - `refundFromReview`: drafts a return through Task 8 (`draftReturn`). Held sanctions funds never
//   go back to the (sanctioned) sender: after the acknowledgement the merchant gives another
//   destination, which is format-, route- and sanctions-checked before anything is drafted. A
//   return whose earlier proposal was cancelled, expired or failed is drafted again only once every
//   earlier proposal for it is verified ended ON CHAIN (`verifiedEndedOnChain`) — never on a
//   Postgres status alone, which could double-send. Held amounts are re-netted from the gross for
//   the destination's return fee (under SMALL_OVERPAY_USD → kept), and an `amount_unknown` row is
//   re-sized from the verified delivered amount (`heldAmount`).
import { Prisma, type Payment, type Refund } from '@prisma/client';
import { HOLD_NOTICE, LEGAL_ACK_PHRASE, SMALL_OVERPAY_USD } from '@tendr/contracts';
import { z } from 'zod';
import { scopedDb, type ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import type { DashboardUserPrincipal } from '../gateway/principal.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { isValidAddress } from './address-format.js';
import { gasEstimateUsd } from './gas-estimates.js';
import {
  contractChainOf,
  detachProposal,
  draftReturn,
  ENDED_REVIEW,
  heldAmount,
  keepSmall,
  legalAckRequired,
  lockRefund,
  netOfReturnFee,
  oneclickChainOf,
  queueHeldReturn,
  returnChainsOf,
  returnRoute,
  REVIEW,
  screenDestination,
  usdPerUnit,
  verifiedEndedOnChain,
} from './refunds.js';
import type { ReturnReason } from './watcher.js';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const tenantOf = (ctx: ScopeContext) => ({ merchantId: ctx.merchantId, livemode: ctx.livemode });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Internal events (never webhooks — Ruling C23): the audit trail of the review actions. */
export const LEGAL_ACKNOWLEDGED = 'payment.legal_acknowledged';
export const REFUND_REDRAFTED = 'refund.review_redrafted';

const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, 400, details);

/** A held (sanctions) payment: HELD, or a return of it was blocked as sanctioned. */
const isSanctionsHeld = (p: Pick<Payment, 'status' | 'heldReason'>) =>
  p.status === 'HELD' || p.heldReason === 'sanctions';

// ─── views ───────────────────────────────────────────────────────────────────

export function refundView(r: Refund) {
  return {
    id: r.id,
    payment_id: r.paymentId,
    reason: r.reason,
    status: r.status,
    asset: r.assetId,
    amount: r.amount.toFixed(0),
    return_fee: r.returnFee ? r.returnFee.toFixed(0) : null,
    destination: r.destination,
    destination_chain: r.destinationChain,
    needs_address: r.needsAddress,
    review_reason: r.reviewReason,
    proposal_id: r.proposalId,
    refund_tx_hash: r.refundTxHash,
    acknowledged_legal_at: iso(r.acknowledgedLegalAt),
    created_at: r.createdAt.toISOString(),
  };
}
export type RefundView = ReturnType<typeof refundView>;

type PaymentWith = Payment & {
  refunds: Refund[];
  session: { externalRef: string | null };
  quote: { originAssetId: string };
};

function itemView(p: PaymentWith) {
  return {
    payment_id: p.id,
    session_id: p.sessionId,
    external_ref: p.session.externalRef,
    status: p.status,
    held_reason: p.heldReason,
    sender_address: p.senderAddress,
    sender_addresses: p.senderAddresses,
    sender_chain: p.senderChain,
    source_asset: p.quote.originAssetId,
    amount_received: p.amountReceived.toFixed(0),
    created_at: p.createdAt.toISOString(),
    legal_ack_at: iso(p.legalAckAt),
    legal_ack_by_user_id: p.legalAckByUserId,
    screening_unresolved_at: iso(p.screeningUnresolvedAt),
    refunds: p.refunds.map(refundView),
  };
}

const OPEN_REFUND = ['pending', 'submitted', 'failed'] as const;
const openRefund = (r: Refund) =>
  (OPEN_REFUND as readonly string[]).includes(r.status) && r.reviewReason !== REVIEW.keptSmall;

/**
 * The review queue of one store and mode:
 * - `held`: held (sanctions) payments still open, each with the verbatim non-custodial notice;
 * - `screening_unresolved`: screening could not complete after 6 h ("Screening couldn't
 *   complete") — not a hold;
 * - `returns`: return-to-sender items needing a person or a signer (linking to the proposal);
 * - `needs_address`: returns waiting for the shopper to say where to send them.
 */
export async function reviewQueue(ctx: ScopeContext) {
  const db = scopedDb(ctx);
  const include = {
    refunds: { orderBy: { createdAt: 'asc' as const } },
    session: { select: { externalRef: true } },
    quote: { select: { originAssetId: true } },
  };
  const heldRows = await db.payment.findMany({
    where: { OR: [{ status: 'HELD' }, { heldReason: 'sanctions' }] },
    include,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const held = heldRows.filter(
    (p) => !p.keptSmallOverpayment && (p.status === 'HELD' || p.refunds.some((r) => openRefund(r))),
  );
  const heldIds = new Set(held.map((p) => p.id));
  const unresolved = await db.payment.findMany({
    where: { status: 'SCREENING_PENDING', screeningUnresolvedAt: { not: null } },
    include,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const open = await db.refund.findMany({
    where: { status: { in: [...OPEN_REFUND] } },
    include: { payment: { include: { session: { select: { externalRef: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const returns = open
    .filter((r) => !heldIds.has(r.paymentId) && openRefund(r))
    .map((r) => ({
      ...refundView(r),
      session_id: r.payment.sessionId,
      external_ref: r.payment.session.externalRef,
      payment_status: r.payment.status,
    }));
  return {
    notice: HOLD_NOTICE,
    held: held.map((p) => ({ ...itemView(p), notice: HOLD_NOTICE })),
    screening_unresolved: unresolved.map(itemView),
    returns: returns.filter((r) => !r.needs_address),
    needs_address: returns.filter((r) => r.needs_address),
  };
}

// ─── legal acknowledgement ───────────────────────────────────────────────────

export const AcknowledgeLegalSchema = z.object({ phrase: z.string().max(200) }).strict();

/**
 * Records the typed legal-clearance acknowledgement for a held payment (owner only; the route
 * also requires step-up). The phrase must be exactly LEGAL_ACK_PHRASE. Idempotent: an already
 * acknowledged payment keeps its first record. Releases nothing.
 */
export async function acknowledgeLegal(
  actor: DashboardUserPrincipal,
  paymentId: string,
  input: z.infer<typeof AcknowledgeLegalSchema>,
) {
  if (actor.role !== 'owner') {
    throw forbidden('Only an owner can acknowledge legal clearance');
  }
  if (input.phrase !== LEGAL_ACK_PHRASE) {
    throw invalid(`Type exactly: ${LEGAL_ACK_PHRASE}`, { field: 'phrase' });
  }
  const ctx = { merchantId: actor.merchantId, livemode: actor.livemode };
  const p = await tenantTransaction(ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
    const cur = await tx.payment.findFirst({ where: { id: paymentId, ...tenantOf(ctx) } });
    if (!cur) throw notFound('Payment not found');
    if (!isSanctionsHeld(cur)) throw conflict('Only a held payment needs a legal acknowledgement');
    if (cur.legalAckAt) return cur;
    const now = new Date();
    await tx.payment.updateMany({
      where: { id: cur.id, ...tenantOf(ctx), legalAckAt: null },
      data: { legalAckAt: now, legalAckByUserId: actor.userId },
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'payment',
      aggregateId: cur.id,
      type: LEGAL_ACKNOWLEDGED,
      payload: {
        payment_id: cur.id,
        session_id: cur.sessionId,
        user_id: actor.userId,
        acknowledged_at: now.toISOString(),
        phrase: LEGAL_ACK_PHRASE,
      },
    });
    return tx.payment.findFirstOrThrow({ where: { id: cur.id, ...tenantOf(ctx) } });
  });
  return {
    payment_id: p.id,
    legal_ack_at: iso(p.legalAckAt),
    legal_ack_by_user_id: p.legalAckByUserId,
  };
}

// ─── refund from review ──────────────────────────────────────────────────────

export const RefundFromReviewSchema = z
  .object({
    /** Which return (optional when the payment has exactly one actionable return). */
    refund_id: z.string().min(1).max(64).optional(),
    /** A destination the merchant gives (required for held sanctions funds). */
    destination: z.string().trim().min(1).max(128).optional(),
    /** Its chain: a 1Click `blockchain` id (`eth`, `near`, …) or a contract chain name. */
    chain: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((v) => (v.destination === undefined) === (v.chain === undefined), {
    message: 'destination and chain go together',
    path: ['chain'],
  });

const proposalStillLive = () =>
  new AppError(
    'PROPOSAL_STILL_LIVE',
    'An earlier refund proposal for this return may still execute on chain; it must be cancelled, expired or failed there before the return is drafted again',
    409,
  );
const chainUnreadable = () =>
  new AppError(
    'PROVIDER_UNAVAILABLE',
    'The account contract cannot be read right now to confirm the earlier proposal ended; try again shortly',
    503,
  );

/**
 * Every earlier proposal of refund `r` (its current link and every proposal drafted for it, by the
 * exact back-link) must be verified ended on chain; a still-linked one is then detached. Throws
 * PROPOSAL_STILL_LIVE (409) or PROVIDER_UNAVAILABLE (503) otherwise.
 */
async function assertEarlierProposalsEnded(ctx: ScopeContext, r: Refund): Promise<void> {
  const proposals = await prisma.accountProposal.findMany({
    where: {
      ...tenantOf(ctx),
      OR: [{ refundId: r.id }, ...(r.proposalId ? [{ id: r.proposalId }] : [])],
    },
  });
  for (const prop of proposals) {
    const verdict = await verifiedEndedOnChain(ctx, prop);
    if (verdict === 'unknown') throw chainUnreadable();
    if (verdict === 'live') throw proposalStillLive();
  }
  if (r.proposalId) {
    const linked = proposals.find((p) => p.id === r.proposalId)!;
    await detachProposal(
      ctx,
      r.proposalId,
      ENDED_REVIEW[linked.status] ?? REVIEW.proposalCancelled,
    );
  }
}

/** Picks the return to act on: the named one, else the payment's only actionable return. */
function pickRefund(refunds: Refund[], refundId?: string): Refund {
  if (refundId) {
    const r = refunds.find((x) => x.id === refundId);
    if (!r) throw notFound('Refund not found');
    return r;
  }
  const open = refunds.filter(
    (r) => r.status !== 'confirmed' && r.reviewReason !== REVIEW.keptSmall,
  );
  if (open.length === 0) throw notFound('This payment has no return to draft');
  if (open.length > 1) throw invalid('Say which refund (refund_id)');
  return open[0]!;
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Drafts (or drafts again) the return of a payment from the review queue, through Task 8's
 * `draftReturn`. See the module comment for the rules. Returns the refund, or
 * `{ kept_small_overpayment: true }` when the return is worth less than SMALL_OVERPAY_USD.
 */
export async function refundFromReview(
  actor: DashboardUserPrincipal,
  paymentId: string,
  input: z.infer<typeof RefundFromReviewSchema>,
): Promise<{ refund: RefundView | null; kept_small_overpayment: boolean }> {
  const ctx = { merchantId: actor.merchantId, livemode: actor.livemode };
  const p = await prisma.payment.findFirst({ where: { id: paymentId, ...tenantOf(ctx) } });
  if (!p) throw notFound('Payment not found');
  const held = isSanctionsHeld(p);
  if (held && !p.legalAckAt) throw legalAckRequired();

  let refunds = await prisma.refund.findMany({
    where: { paymentId: p.id, ...tenantOf(ctx) },
    orderBy: { createdAt: 'asc' },
  });
  if (p.status === 'HELD' && !refunds.some((r) => r.reason === 'sanctions')) {
    const queued = await queueHeldReturn(ctx, p.id);
    if (!queued) return { refund: null, kept_small_overpayment: true };
    refunds = [...refunds, queued];
  }
  let r = pickRefund(refunds, input.refund_id);
  if (r.status === 'confirmed') throw conflict('This return was already sent');
  const sanctioned = held || r.reason === 'sanctions' || r.reviewReason === REVIEW.sanctions;
  if (sanctioned && !p.legalAckAt) throw legalAckRequired();
  if (sanctioned && !input.destination) {
    throw invalid(
      'Funds from a sanctioned sender can never be returned to that sender: give another destination',
      { field: 'destination' },
    );
  }

  // Never a second live proposal for the same return.
  await assertEarlierProposalsEnded(ctx, r);
  r = await prisma.refund.findFirstOrThrow({ where: { id: r.id, ...tenantOf(ctx) } });
  if (r.proposalId || r.status === 'confirmed')
    throw conflict('This return already has a proposal');

  // The destination: the merchant's (checked here) or the one on file.
  let dest: { address: string; chain: string } | null =
    r.destination && r.destinationChain
      ? { address: r.destination, chain: r.destinationChain }
      : null;
  let screened = false;
  if (input.destination && input.chain) {
    const chain = contractChainOf(input.chain);
    if (!chain) throw invalid('Refunds cannot be sent on this network', { field: 'chain' });
    const oneclick = oneclickChainOf(chain);
    if (!isValidAddress(oneclick, input.destination)) {
      throw invalid(`That is not a valid ${oneclick} address`, { field: 'destination' });
    }
    const blocked = [p.senderAddress, ...p.senderAddresses, ...(sanctioned ? [r.destination] : [])];
    if (sanctioned && blocked.some((a) => a && sameAddress(a, input.destination!))) {
      throw invalid('That is the sanctioned sender: give another destination', {
        field: 'destination',
      });
    }
    if (!returnRoute(r.assetId, chain, input.destination)) {
      throw invalid('This return cannot be sent on that network', {
        chains: returnChainsOf(r.assetId).map(oneclickChainOf),
      });
    }
    const { decision } = await screenDestination(ctx, {
      sessionId: p.sessionId,
      address: input.destination,
      chain: oneclick,
    });
    if (decision === 'unavailable') {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Address screening is unavailable; try again shortly',
        503,
      );
    }
    if (decision === 'block') {
      log('warn', 'review refund destination refused: sanctioned', { refundId: r.id });
      throw new AppError('WALLET_NOT_ALLOWED', 'This address cannot receive the refund', 403);
    }
    dest = { address: input.destination, chain };
    screened = true;
  }
  if (!dest) {
    throw invalid('This return has no destination yet: give one', { field: 'destination' });
  }

  // The amount: re-sized from the verified delivered amount when unknown; re-netted from the gross
  // for the destination's return fee when held or when the destination chain changed.
  let assetId = r.assetId;
  let gross = BigInt(r.amount.toFixed(0)) + BigInt(r.returnFee ? r.returnFee.toFixed(0) : '0');
  const unknown = r.reviewReason === REVIEW.amountUnknown;
  if (unknown) {
    const s = await prisma.session.findFirstOrThrow({
      where: { id: p.sessionId, ...tenantOf(ctx) },
      select: { destAsset: true },
    });
    const q = await prisma.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
    const verified = await heldAmount(ctx, p, q, s.destAsset);
    if (!verified) {
      throw new AppError(
        'AMOUNT_UNKNOWN',
        'The amount that reached your account cannot be verified yet; try again later',
        409,
      );
    }
    assetId = verified.assetId;
    gross = verified.amount;
  }
  let amount = BigInt(r.amount.toFixed(0));
  let returnFee: bigint | null = r.returnFee ? BigInt(r.returnFee.toFixed(0)) : null;
  if (sanctioned || unknown || dest.chain !== r.destinationChain) {
    const q = await prisma.quote.findFirstOrThrow({ where: { id: p.quoteId, ...tenantOf(ctx) } });
    const perUnit = await usdPerUnit(ctx.livemode, assetId, q);
    if (!perUnit) {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'No price for this asset right now; try again',
        503,
      );
    }
    const net = netOfReturnFee(gross, perUnit, D(gasEstimateUsd(oneclickChainOf(dest.chain))));
    if (net.net <= 0n || net.netUsd.lt(SMALL_OVERPAY_USD)) {
      await keepSmall(ctx, p.id, r.reason as ReturnReason);
      await prisma.refund.updateMany({
        where: { id: r.id, ...tenantOf(ctx), proposalId: null },
        data: { status: 'failed', reviewReason: REVIEW.keptSmall },
      });
      return { refund: null, kept_small_overpayment: true };
    }
    amount = net.net;
    returnFee = net.fee;
  }

  // Conditional on the refund still having no proposal (a concurrent draft or an on-chain revival
  // re-linking it makes this a 409), so two requests can never leave two live proposals.
  await tenantTransaction(ctx, async (tx) => {
    await lockRefund(tx, ctx, r.id);
    const { count } = await tx.refund.updateMany({
      where: { id: r.id, ...tenantOf(ctx), proposalId: null, status: { not: 'confirmed' } },
      data: {
        destination: dest.address,
        destinationChain: dest.chain,
        assetId,
        amount: amount.toString(),
        returnFee: returnFee === null ? null : returnFee.toString(),
        status: 'pending',
        reviewReason: null,
        needsAddress: false,
        addressTokenHash: null,
        addressTokenExpiresAt: null,
        ...(sanctioned ? { acknowledgedLegalAt: p.legalAckAt } : {}),
      },
    });
    if (count === 0) throw conflict('This return already has a proposal');
    await recordEvent(tx, ctx, {
      aggregateType: 'refund',
      aggregateId: r.id,
      type: REFUND_REDRAFTED,
      payload: {
        refund_id: r.id,
        payment_id: p.id,
        user_id: actor.userId,
        previous_review_reason: r.reviewReason,
        destination: dest.address,
        destination_chain: dest.chain,
        asset: assetId,
        amount: amount.toString(),
        return_fee: returnFee === null ? null : returnFee.toString(),
      },
    });
  });
  const drafted = await draftReturn(ctx, r.id, { screened });
  return { refund: refundView(drafted), kept_small_overpayment: false };
}
