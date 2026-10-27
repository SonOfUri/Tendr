// A merchant's gas policy (per mode) and its monthly usage (project 5a, spec §2.2, §5).
//
// A mode without a `gas_policies` row has DEFAULT_GAS_POLICY, disabled: nothing is sponsored until
// the merchant turns it on (stores whose default gas payer was the merchant got an enabled policy
// from the gasless migration). `putGasPolicy` merges the given fields over the current policy and
// validates the result, so the per-payment cap can never end up above the monthly budget.
// The month is the calendar month in UTC.
import { Prisma, type GasPolicy as GasPolicyRow } from '@prisma/client';
import {
  DEFAULT_GAS_POLICY,
  type GasPolicy,
  GasPolicyInputSchema,
  GasPolicySchema,
  type GasPolicyView,
  type GasUsageView,
} from '@tendr/contracts';
import { type ScopeContext, scopedDb } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

/** Internal audit event (never a webhook): who changed the policy, before and after. */
export const GAS_POLICY_UPDATED = 'gas_policy.updated';

/** Who changes a policy: a dashboard user, or a secret key the store made (never a connection). */
export type GasPolicyActor = { by: 'user'; userId: string } | { by: 'api_key'; apiKeyId: string };
export type GasPolicyCtx = ScopeContext & { actor: GasPolicyActor };

/** The calendar month (UTC) of `at`, `YYYY-MM`. */
export function currentMonth(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

function policyOf(row: GasPolicyRow | null): GasPolicy {
  if (!row) return { ...DEFAULT_GAS_POLICY, chains: [...DEFAULT_GAS_POLICY.chains], tokens: [] };
  return {
    enabled: row.enabled,
    per_payment_cap_usd: row.perPaymentCapUsd.toFixed(),
    monthly_budget_usd: row.monthlyBudgetUsd.toFixed(),
    min_order_usd: row.minOrderUsd.toFixed(),
    chains: row.chains as GasPolicy['chains'],
    tokens: row.tokens,
    first_time_only: row.firstTimeOnly,
  };
}

function view(row: GasPolicyRow | null, livemode: boolean): GasPolicyView {
  return { livemode, ...policyOf(row), updated_at: row ? row.updatedAt.toISOString() : null };
}

/** The mode's policy row, or null while the defaults apply. */
export async function gasPolicyRow(
  merchantId: string,
  livemode: boolean,
): Promise<GasPolicyRow | null> {
  return scopedDb({ merchantId, livemode }).gasPolicy.findFirst({});
}

/** The mode's policy; the defaults (disabled) when the merchant has not set one. */
export async function getGasPolicy(merchantId: string, livemode: boolean): Promise<GasPolicyView> {
  return view(await gasPolicyRow(merchantId, livemode), livemode);
}

/**
 * Sets the given policy fields in the caller's mode (omitted fields keep their value) and records
 * an internal audit event with the actor and the before and after policy. 400 VALIDATION_ERROR
 * when the input or the merged policy is invalid.
 */
export async function putGasPolicy(ctx: GasPolicyCtx, input: unknown): Promise<GasPolicyView> {
  const parsed = GasPolicyInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const scope = { merchantId: ctx.merchantId, livemode: ctx.livemode };
  return tenantTransaction(scope, async (tx) => {
    // One writer per merchant at a time, so concurrent first PUTs cannot both insert.
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${ctx.merchantId} FOR UPDATE`;
    const where = { merchantId: ctx.merchantId, livemode: ctx.livemode };
    const before = await tx.gasPolicy.findFirst({ where });
    const merged = GasPolicySchema.safeParse({ ...policyOf(before), ...parsed.data });
    if (!merged.success) throw invalid(merged.error);
    const p = merged.data;
    const data = {
      enabled: p.enabled,
      perPaymentCapUsd: p.per_payment_cap_usd,
      monthlyBudgetUsd: p.monthly_budget_usd,
      minOrderUsd: p.min_order_usd,
      chains: p.chains,
      tokens: p.tokens,
      firstTimeOnly: p.first_time_only,
    };
    const after = before
      ? await tx.gasPolicy.update({ where: { id: before.id }, data })
      : await tx.gasPolicy.create({ data: { id: newId('gpol'), ...where, ...data } });
    await recordEvent(tx, scope, {
      aggregateType: 'merchant',
      aggregateId: ctx.merchantId,
      type: GAS_POLICY_UPDATED,
      payload: { actor: ctx.actor, before: policyOf(before), after: policyOf(after) },
    });
    return view(after, ctx.livemode);
  });
}

/** The month's budget use in one mode; zeros when nothing was sponsored that month. */
export async function gasUsage(
  merchantId: string,
  livemode: boolean,
  month: string,
): Promise<GasUsageView> {
  const db = scopedDb({ merchantId, livemode });
  const [policy, row] = await Promise.all([
    db.gasPolicy.findFirst({}),
    db.gasBudgetMonth.findFirst({ where: { month } }),
  ]);
  const budget = new Prisma.Decimal(policyOf(policy).monthly_budget_usd);
  const reserved = row?.reservedUsd ?? new Prisma.Decimal(0);
  const spent = row?.spentUsd ?? new Prisma.Decimal(0);
  const remaining = Prisma.Decimal.max(0, budget.minus(reserved).minus(spent));
  return {
    month,
    reserved_usd: reserved.toFixed(),
    spent_usd: spent.toFixed(),
    remaining_usd: remaining.toFixed(),
    count: row?.count ?? 0,
  };
}

function invalid(error: { flatten: () => unknown; issues: { message: string }[] }): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    `Invalid gas policy: ${error.issues[0]?.message ?? 'invalid'}`,
    400,
    error.flatten(),
  );
}
