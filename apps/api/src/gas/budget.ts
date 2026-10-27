// Holds on a merchant's monthly gas budget (project 5a, spec §2.2, §8.1).
//
// A merchant-sponsored payment reserves its quoted network cost when the shopper commits to sign
// (`reserveBudget`), which records a `gas_sponsorships` row with `reservation_state = reserved`.
// The hold is released if nothing is submitted (`releaseReservation`) or moved to spent when the
// cost is charged (`settleReservation`). The month (calendar month, UTC) is the month the
// reservation was made in, kept as the sponsorship's `created_at`.
//
// Concurrency: every change to a month's figures happens under `SELECT … FOR UPDATE` on its
// `gas_budget_months` row, so concurrent reservations can never take reserved + spent above the
// budget. Lock order is session → month row → sponsorship row on every path (release and settle
// take no session lock), so the paths cannot deadlock one another.
import { Prisma, type SponsorshipMethod } from '@prisma/client';
import { DEFAULT_GAS_POLICY, UsdAmountSchema } from '@tendr/contracts';
import type { ScopeContext } from '../db/scoped.js';
import { recordEvent } from '../events/record.js';
import { newId } from '../lib/ids.js';
import { currentMonth } from './policy.js';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const Dec = Prisma.Decimal;

/** Merchant event: reserved + spent crossed 80 % of the month's budget (once per month). */
export const GAS_BUDGET_LOW = 'gas.budget_low';
/** Merchant event: a reservation was refused because the budget is used up (once per month). */
export const GAS_BUDGET_EXHAUSTED = 'gas.budget_exhausted';
const LOW_RATIO = new Dec('0.8');

export interface ReserveBudgetInput {
  merchantId: string;
  livemode: boolean;
  sessionId: string;
  /** The quoted network cost the merchant is charged (spec §8.1), a USD decimal string. */
  usd: string;
  /** When the shopper commits to sign; picks the budget month. */
  at: Date;
  /** The sponsorship's chain, method and provider, as the relayer will submit it. */
  chain: string;
  method: SponsorshipMethod;
  provider: string;
}

interface MonthRow {
  id: string;
  reserved_usd: Decimal;
  spent_usd: Decimal;
  count: number;
}

/** Creates the month's row if absent, then locks it for the rest of the transaction. */
async function lockMonth(tx: Tx, scope: ScopeContext, month: string): Promise<MonthRow> {
  await tx.gasBudgetMonth.createMany({
    data: [{ id: newId('gbm'), merchantId: scope.merchantId, livemode: scope.livemode, month }],
    skipDuplicates: true,
  });
  const rows = await tx.$queryRaw<MonthRow[]>`
    SELECT id, reserved_usd, spent_usd, count FROM gas_budget_months
    WHERE merchant_id = ${scope.merchantId} AND livemode = ${scope.livemode} AND month = ${month}
    FOR UPDATE`;
  return rows[0]!;
}

async function monthlyBudget(tx: Tx, scope: ScopeContext): Promise<Decimal> {
  const policy = await tx.gasPolicy.findFirst({
    where: { merchantId: scope.merchantId, livemode: scope.livemode },
    select: { monthlyBudgetUsd: true },
  });
  return policy?.monthlyBudgetUsd ?? new Dec(DEFAULT_GAS_POLICY.monthly_budget_usd);
}

/** Records `type` for the month row unless it was already recorded (the row is locked). */
async function monthEventOnce(
  tx: Tx,
  scope: ScopeContext,
  row: MonthRow,
  type: string,
  payload: object,
): Promise<void> {
  const seen = await tx.event.findFirst({
    where: { aggregateType: 'gas_budget_month', aggregateId: row.id, type },
    select: { id: true },
  });
  if (seen) return;
  await recordEvent(tx, scope, {
    aggregateType: 'gas_budget_month',
    aggregateId: row.id,
    type,
    payload,
  });
}

/**
 * The budget event payload (delivered as webhook `data`): the mode, month, budget and the month's
 * reserved, spent and remaining amounts as decimal strings.
 */
function budgetFigures(
  scope: ScopeContext,
  month: string,
  budget: Decimal,
  reserved: Decimal,
  spent: Decimal,
) {
  return {
    mode: scope.livemode ? 'live' : 'test',
    month,
    budget_usd: budget.toFixed(),
    reserved_usd: reserved.toFixed(),
    spent_usd: spent.toFixed(),
    remaining_usd: Dec.max(0, budget.minus(reserved).minus(spent)).toFixed(),
  };
}

/**
 * `gas.budget_low` when this change takes reserved + spent from below 80 % of the budget to at
 * least 80 %. `reserved` and `spent` are the month's figures after the change.
 */
async function maybeBudgetLow(
  tx: Tx,
  scope: ScopeContext,
  month: string,
  row: MonthRow,
  reserved: Decimal,
  spent: Decimal,
): Promise<void> {
  const budget = await monthlyBudget(tx, scope);
  const threshold = budget.mul(LOW_RATIO);
  const before = row.reserved_usd.plus(row.spent_usd);
  if (before.gte(threshold) || reserved.plus(spent).lt(threshold)) return;
  await monthEventOnce(
    tx,
    scope,
    row,
    GAS_BUDGET_LOW,
    budgetFigures(scope, month, budget, reserved, spent),
  );
}

/**
 * Reserves `usd` of the month's budget for the session, recording a merchant-sponsored
 * `gas_sponsorships` row (`reservation_state = reserved`, `estimate_usd = usd`). A session holds at
 * most one reservation: an earlier one still reserved is released in the same transaction.
 * Returns null, and records `gas.budget_exhausted` (once per month), when reserved + spent + usd
 * would exceed the month's budget. That event is written in the caller's transaction: a caller
 * that gets null should still commit (and fall back to "shopper pays"), or the event is lost. Throws when the session is not the merchant's in that mode.
 * Must run inside the caller's transaction.
 */
export async function reserveBudget(
  tx: Tx,
  input: ReserveBudgetInput,
): Promise<{ sponsorshipId: string } | null> {
  const usd = new Dec(UsdAmountSchema.parse(input.usd));
  const scope: ScopeContext = { merchantId: input.merchantId, livemode: input.livemode };
  const session = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sessions
    WHERE id = ${input.sessionId} AND merchant_id = ${scope.merchantId}
      AND livemode = ${scope.livemode}
    FOR UPDATE`;
  if (session.length === 0) throw new Error(`reserveBudget: session ${input.sessionId} not found`);

  const previous = await tx.gasSponsorship.findMany({
    where: { ...scope, sessionId: input.sessionId, reservationState: 'reserved' },
    select: { id: true },
  });
  for (const p of previous) await releaseReservation(tx, p.id);

  const month = currentMonth(input.at);
  const row = await lockMonth(tx, scope, month);
  const budget = await monthlyBudget(tx, scope);
  const before = row.reserved_usd.plus(row.spent_usd);
  const after = before.plus(usd);
  if (after.gt(budget)) {
    await monthEventOnce(tx, scope, row, GAS_BUDGET_EXHAUSTED, {
      ...budgetFigures(scope, month, budget, row.reserved_usd, row.spent_usd),
      requested_usd: usd.toFixed(),
    });
    return null;
  }

  const id = newId('gas');
  await tx.gasSponsorship.create({
    data: {
      id,
      ...scope,
      sessionId: input.sessionId,
      chain: input.chain,
      method: input.method,
      provider: input.provider,
      sponsor: 'merchant',
      estimateUsd: usd,
      reservationState: 'reserved',
      createdAt: input.at,
    },
  });
  await tx.gasBudgetMonth.update({
    where: { id: row.id },
    data: { reservedUsd: { increment: usd }, count: { increment: 1 } },
  });
  await maybeBudgetLow(tx, scope, month, row, row.reserved_usd.plus(usd), row.spent_usd);
  return { sponsorshipId: id };
}

/**
 * Locks the sponsorship's month row, then the sponsorship, and runs `fn` if it is still reserved.
 * Returns false (a no-op) when it is not a reservation or no longer reserved.
 */
async function withReservation(
  tx: Tx,
  sponsorshipId: string,
  fn: (scope: ScopeContext, month: string, row: MonthRow, estimate: Decimal) => Promise<void>,
): Promise<boolean> {
  const found = await tx.gasSponsorship.findUnique({
    where: { id: sponsorshipId },
    select: { merchantId: true, livemode: true, createdAt: true, reservationState: true },
  });
  if (!found || found.reservationState !== 'reserved') return false;
  const scope: ScopeContext = { merchantId: found.merchantId, livemode: found.livemode };
  const month = currentMonth(found.createdAt);
  const row = await lockMonth(tx, scope, month);
  const locked = await tx.$queryRaw<
    { reservation_state: string | null; estimate_usd: Decimal | null }[]
  >`
    SELECT reservation_state::text, estimate_usd FROM gas_sponsorships
    WHERE id = ${sponsorshipId} AND merchant_id = ${scope.merchantId}
      AND livemode = ${scope.livemode}
    FOR UPDATE`;
  const s = locked[0];
  if (!s || s.reservation_state !== 'reserved') return false;
  await fn(scope, month, row, s.estimate_usd ?? new Dec(0));
  return true;
}

/**
 * Charges a reservation to the month: its estimate leaves `reserved_usd` and `usd` (what the
 * merchant is charged) joins `spent_usd`. Idempotent: a no-op (false) unless still reserved.
 */
export async function settleReservation(
  tx: Tx,
  sponsorshipId: string,
  usd: string,
): Promise<boolean> {
  const amount = new Dec(UsdAmountSchema.parse(usd));
  return withReservation(tx, sponsorshipId, async (scope, month, row, estimate) => {
    await tx.gasBudgetMonth.update({
      where: { id: row.id },
      data: { reservedUsd: { decrement: estimate }, spentUsd: { increment: amount } },
    });
    await tx.gasSponsorship.update({
      where: { id: sponsorshipId },
      data: { reservationState: 'settled' },
    });
    await maybeBudgetLow(
      tx,
      scope,
      month,
      row,
      row.reserved_usd.minus(estimate),
      row.spent_usd.plus(amount),
    );
  });
}

/**
 * Returns a reservation's estimate to the month's budget (nothing was submitted, or it failed).
 * Idempotent: a no-op (false) unless still reserved.
 */
export async function releaseReservation(tx: Tx, sponsorshipId: string): Promise<boolean> {
  return withReservation(tx, sponsorshipId, async (_scope, _month, row, estimate) => {
    await tx.gasBudgetMonth.update({
      where: { id: row.id },
      data: { reservedUsd: { decrement: estimate }, count: { decrement: 1 } },
    });
    await tx.gasSponsorship.update({
      where: { id: sponsorshipId },
      data: { reservationState: 'released' },
    });
  });
}
