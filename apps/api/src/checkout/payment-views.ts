// Dashboard reads of checkout payments (checkout Task 10): the list (filters: status, created-at
// range; newest first, cursor `starting_after`) and the detail with the fee lines broken out.
//
// Every amount crosses the API as an integer string in the asset's base units (or a decimal USD
// string); nothing is ever a float. Fee lines are the payment's `revenue_entries` once settled,
// otherwise the same lines computed from its quote and session (`revenueLines`). The network fee
// the shopper paid themselves is an estimate, so it is flagged `estimated`; the gas reimbursement
// is what Tendr's `appFees` collected for a sponsored fee. `network_fee` says who paid it.
import type { Prisma } from '@prisma/client';
import { feePayerFromDb, gasPayerFromDb, PaymentStatusSchema } from '@tendr/contracts';
import { z } from 'zod';
import type { ScopedDb } from '../db/scoped.js';
import { notFound } from '../lib/errors.js';
import { networkFeeView } from '../gas/quote-fee.js';
import { refundView } from './review.js';
import { revenueLines } from './revenue.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dec = (d: Prisma.Decimal | null) => (d ? d.toFixed() : null);
const units = (d: Prisma.Decimal | null) => (d ? d.toFixed(0) : null);

export const PaymentListQuerySchema = z
  .object({
    status: PaymentStatusSchema.optional(),
    /** Created at or after (ISO 8601). */
    created_from: z.string().datetime({ offset: true }).optional(),
    /** Created before (ISO 8601). */
    created_to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    starting_after: z.string().min(1).max(64).optional(),
  })
  .strict();

const include = {
  quote: {
    select: {
      originAssetId: true,
      amountIn: true,
      amountOut: true,
      amountInUsd: true,
      amountOutUsd: true,
      refundTo: true,
      refundType: true,
      networkFeePaidBy: true,
      networkFeeMode: true,
      networkFeeUsd: true,
      networkFeeAmount: true,
      networkFeeMethod: true,
      networkFeeReason: true,
      networkFeeBps: true,
    },
  },
  session: {
    select: {
      externalRef: true,
      amount: true,
      amountCurrency: true,
      destAsset: true,
      destChain: true,
      recipientType: true,
      feeBps: true,
      feePayer: true,
      gasSponsor: true,
      gasMaxUsd: true,
    },
  },
} satisfies Prisma.PaymentInclude;

type Row = Prisma.PaymentGetPayload<{ include: typeof include }>;

function summary(p: Row) {
  return {
    id: p.id,
    livemode: p.livemode,
    status: p.status,
    session_id: p.sessionId,
    external_ref: p.session.externalRef,
    order: { amount: p.session.amount.toFixed(), currency: p.session.amountCurrency },
    source: { asset: p.quote.originAssetId, chain: p.senderChain },
    received: { asset: p.quote.originAssetId, amount: p.amountReceived.toFixed(0) },
    settlement: {
      asset: p.session.destAsset,
      chain: p.session.destChain,
      amount_out: units(p.amountOut),
    },
    is_late: p.isLate,
    held_reason: p.heldReason,
    created_at: p.createdAt.toISOString(),
    settled_at: iso(p.settledAt),
  };
}

export async function listPayments(db: ScopedDb, query: z.infer<typeof PaymentListQuerySchema>) {
  const createdAt: Prisma.DateTimeFilter = {};
  if (query.created_from) createdAt.gte = new Date(query.created_from);
  if (query.created_to) createdAt.lt = new Date(query.created_to);
  const rows = await db.payment.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.created_from || query.created_to ? { createdAt } : {}),
    },
    include,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.starting_after ? { cursor: { id: query.starting_after }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  return {
    payments: page.map(summary),
    has_more: rows.length > query.limit,
    next_cursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** API names of the revenue sources (the dashboard's fee lines). */
const FEE_KIND: Readonly<Record<string, Exclude<FeeKind, 'other'>>> = {
  app_fee: 'tendr_fee',
  oneclick_fee: 'oneclick_fee',
  spread: 'oneclick_fee',
  network_fee: 'network_fee',
  gas_reimbursement: 'gas_reimbursement',
};

export type FeeKind = 'tendr_fee' | 'oneclick_fee' | 'network_fee' | 'gas_reimbursement' | 'other';

/** The fee-line kind of a revenue source; a source this release does not know is `other`. */
export function feeKindOf(source: string): FeeKind {
  return Object.hasOwn(FEE_KIND, source) ? FEE_KIND[source]! : 'other';
}
/** Lines built on a send-fee estimate (the shopper's own network fee). */
const ESTIMATED = new Set(['network_fee']);

export interface FeeLine {
  kind: FeeKind;
  asset: string;
  /** Base units of `asset` (integer string). */
  amount: string;
  /** USD at quote prices (decimal string), when known. */
  amount_usd: string | null;
  estimated: boolean;
}

export async function getPayment(db: ScopedDb, id: string) {
  const p = await db.payment.findFirst({ where: { id }, include });
  if (!p) throw notFound('Payment not found');
  const [entries, refunds, claim] = await Promise.all([
    db.revenueEntry.findMany({ where: { paymentId: p.id }, orderBy: { createdAt: 'asc' } }),
    db.refund.findMany({ where: { paymentId: p.id }, orderBy: { createdAt: 'asc' } }),
    db.settlementClaim.findFirst({ where: { paymentId: p.id } }),
  ]);
  // Settlement lines only (`reference = ''`): a shopper-paid fee leg (`gas_reimbursement` with
  // the submission as reference) is Tendr's revenue from the shopper, not a fee on the store.
  const settled = entries.filter((e) => e.reference === '');
  const recorded = settled.length > 0;
  const lines = recorded
    ? settled.map((e) => ({
        source: e.source,
        assetId: e.assetId,
        amount: e.amount,
        amountUsd: e.amountUsd,
      }))
    : revenueLines({
        originAsset: p.quote.originAssetId,
        chain: p.senderChain ?? '',
        amountIn: p.quote.amountIn,
        amountInUsd: p.quote.amountInUsd,
        amountOutUsd: p.quote.amountOutUsd,
        feeBps: p.session.feeBps,
        networkFeeBps: p.quote.networkFeeBps,
        networkFeeUsd: p.quote.networkFeeUsd,
        networkFeePaidBy: p.quote.networkFeePaidBy,
        networkFeeMode: p.quote.networkFeeMode,
      });
  const fees: FeeLine[] = lines.map((l) => {
    const kind = feeKindOf(l.source);
    return {
      kind,
      asset: l.assetId,
      amount: l.amount.toFixed(0),
      amount_usd: dec(l.amountUsd),
      estimated: ESTIMATED.has(kind),
    };
  });
  return {
    ...summary(p),
    fee_payer: feePayerFromDb(p.session.feePayer),
    gas_payer: gasPayerFromDb(p.session.gasSponsor),
    fee_bps: p.session.feeBps,
    /** Who paid the network fee and how; null for payments quoted before gasless payments. */
    network_fee: networkFeeView(p.quote),
    fees,
    fees_recorded: recorded,
    quote: {
      amount_in: p.quote.amountIn.toFixed(0),
      amount_out: p.quote.amountOut.toFixed(0),
      amount_in_usd: dec(p.quote.amountInUsd),
      amount_out_usd: dec(p.quote.amountOutUsd),
      refund_type: p.quote.refundType,
    },
    sender_address: p.senderAddress,
    sender_addresses: p.senderAddresses,
    overpaid_amount: units(p.overpaidAmount),
    refunded_amount: units(p.refundedAmount),
    kept_small_overpayment: p.keptSmallOverpayment,
    oneclick_status: p.oneclickStatus,
    verified_by: p.verifiedBy,
    legal_ack_at: iso(p.legalAckAt),
    screening_unresolved_at: iso(p.screeningUnresolvedAt),
    transactions: {
      origin: p.originTxHash ? { chain: p.senderChain, hash: p.originTxHash } : null,
      // The verified settlement transfer: on NEAR into the merchant account (intents payout), or
      // on the destination chain to the saved address (wallet payout).
      settlement: (() => {
        const hash = claim?.txHash ?? p.settleTx;
        if (!hash) return null;
        const chain =
          p.session.recipientType === 'DESTINATION_CHAIN' ? p.session.destChain : 'near';
        return { chain, hash };
      })(),
      payout: p.payoutTx ? { chain: p.session.destChain, hash: p.payoutTx } : null,
    },
    refunds: refunds.map(refundView),
  };
}
