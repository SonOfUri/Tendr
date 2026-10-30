// `GET /v1/gas-sponsorships` (project 5a, spec §2.6, §5): every sponsored or relayed transaction
// of the caller's mode, newest first, cursor `starting_after`. Reads go through the request's
// scoped client, so another store's or the other mode's records never appear.
//
// Filters: `session`, `payment` (the sponsorships of that payment's session), `status`, `month`
// (calendar month in UTC of `created_at`). Amounts are strings: USD as decimals, `fee_amount` and
// `gas_used` in base units.
import type { GasSponsorship, Prisma } from '@prisma/client';
import { ExternalTxStatusSchema, GasMonthSchema } from '@tendr/contracts';
import { z } from 'zod';
import type { ScopedDb } from '../db/scoped.js';

export const GasSponsorshipListQuerySchema = z
  .object({
    session: z.string().min(1).max(64).optional(),
    payment: z.string().min(1).max(64).optional(),
    status: ExternalTxStatusSchema.optional(),
    month: GasMonthSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    starting_after: z.string().min(1).max(64).optional(),
  })
  .strict();
export type GasSponsorshipListQuery = z.infer<typeof GasSponsorshipListQuerySchema>;

const dec = (d: Prisma.Decimal | null) => (d ? d.toFixed() : null);

export function gasSponsorshipView(g: GasSponsorship) {
  return {
    id: g.id,
    livemode: g.livemode,
    session_id: g.sessionId,
    recovered_from_payment_id: g.recoveredFromPaymentId,
    /** `method = hook` rows: the payment whose integrator hook gas this is; else null. */
    hook_payment_id: g.hookPaymentId,
    chain: g.chain,
    method: g.method,
    provider: g.provider,
    sponsor: g.sponsor,
    status: g.status,
    tx_hash: g.txHash,
    user_op_hash: g.userOpHash,
    fee_mode: g.feeMode,
    fee_asset: g.feeAsset,
    fee_amount: g.feeAmount ? g.feeAmount.toFixed(0) : null,
    estimate_usd: dec(g.estimateUsd),
    cost_usd: dec(g.costUsd),
    gas_used: g.gasUsed ? g.gasUsed.toFixed(0) : null,
    reservation_state: g.reservationState,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
  };
}
export type GasSponsorshipView = ReturnType<typeof gasSponsorshipView>;

/** `YYYY-MM` → [first instant of the month, first instant of the next) in UTC. */
function monthRange(month: string): { gte: Date; lt: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
}

export async function listGasSponsorships(db: ScopedDb, query: GasSponsorshipListQuery) {
  const empty = { gas_sponsorships: [], has_more: false, next_cursor: null };
  const where: Prisma.GasSponsorshipWhereInput = {};
  if (query.payment) {
    const payment = await db.payment.findFirst({
      where: { id: query.payment },
      select: { sessionId: true },
    });
    if (!payment) return empty;
    if (query.session && query.session !== payment.sessionId) return empty;
    where.sessionId = payment.sessionId;
  } else if (query.session) {
    where.sessionId = query.session;
  }
  if (query.status) where.status = query.status;
  if (query.month) where.createdAt = monthRange(query.month);
  const rows = await db.gasSponsorship.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.starting_after ? { cursor: { id: query.starting_after }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  const more = rows.length > query.limit;
  return {
    gas_sponsorships: page.map(gasSponsorshipView),
    has_more: more,
    next_cursor: more ? (page[page.length - 1]?.id ?? null) : null,
  };
}
