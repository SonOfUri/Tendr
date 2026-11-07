import { Prisma } from '@prisma/client';
import type { CheckoutMetrics, InsightInput, MerchantInsights } from '@tendr/contracts';
import { readOnlyDb, type ScopeContext } from '../db/scoped.js';
import { reserveAiUsage } from './budget.js';
import { configuredSelector, type AssistantFact, type FactSelector } from './provider.js';

export type MerchantAiContext = ScopeContext & { actorId: string };

/** Sessions created in the interval form the cohort; payment/refund state is their current state. */
async function metrics(ctx: ScopeContext, from: Date, to: Date): Promise<CheckoutMetrics> {
  const db = readOnlyDb(ctx);
  const cohort = { createdAt: { gte: from, lt: to } };
  const settled: Prisma.SessionWhereInput = {
    ...cohort,
    OR: [{ status: 'SETTLED' }, { payments: { some: { settledAt: { not: null } } } }],
  };
  const [created, quoted, deposited, paid, expired, refunds, totals] = await Promise.all([
    db.session.count({ where: cohort }),
    db.session.count({ where: { ...cohort, quotes: { some: {} } } }),
    db.session.count({ where: { ...cohort, payments: { some: {} } } }),
    db.session.count({ where: settled }),
    db.session.count({ where: { ...cohort, status: 'EXPIRED', payments: { none: {} } } }),
    db.session.count({ where: { ...cohort, payments: { some: { refunds: { some: {} } } } } }),
    db.session.groupBy({
      by: ['amountCurrency'],
      where: settled,
      _sum: { amount: true },
      orderBy: { amountCurrency: 'asc' },
    }),
  ]);
  return {
    sessions_created: created,
    sessions_quoted: quoted,
    sessions_with_deposit: deposited,
    sessions_settled: paid,
    expired_without_deposit: expired,
    sessions_with_refunds: refunds,
    conversion_percent:
      created === 0 ? null : new Prisma.Decimal(paid).mul(100).div(created).toFixed(2),
    settled_order_totals: totals.map((g) => ({
      currency: g.amountCurrency,
      amount: g._sum.amount!.toFixed(),
    })),
  };
}

export async function merchantInsights(
  ctx: ScopeContext,
  days: number,
  now = new Date(),
): Promise<MerchantInsights> {
  const start = new Date(now.getTime() - days * 86_400_000);
  const before = new Date(start.getTime() - days * 86_400_000);
  const [current, previous] = await Promise.all([
    metrics(ctx, start, now),
    metrics(ctx, before, start),
  ]);
  const change =
    current.conversion_percent !== null && previous.conversion_percent !== null
      ? new Prisma.Decimal(current.conversion_percent).minus(previous.conversion_percent).toFixed(2)
      : null;
  const facts: AssistantFact[] = [
    {
      id: 'scope',
      text: `${ctx.livemode ? 'Live' : 'Test'} mode: sessions created in the last ${days} days. Counts represent sessions, not unique shoppers or page views; payment and refund states are current at report generation.`,
    },
    {
      id: 'conversion',
      text: `${current.sessions_settled} of ${current.sessions_created} checkout sessions have settled. ${current.conversion_percent === null ? 'There are no sessions, so conversion cannot be calculated.' : `Session conversion is ${current.conversion_percent}%.`} Open sessions can still convert.`,
    },
    {
      id: 'funnel',
      text: `${current.sessions_created} sessions created, ${current.sessions_quoted} with at least one quote, ${current.sessions_with_deposit} with at least one recorded deposit, and ${current.sessions_settled} settled. Multiple quotes or payments in one session count once.`,
    },
    {
      id: 'dropoff',
      text: `${current.expired_without_deposit} sessions expired without a recorded deposit. This identifies a checkout stage, not why the shopper left; there is no visitor tracking or reason evidence in these totals.`,
    },
    {
      id: 'comparison',
      text: `The preceding ${days}-day cohort has ${previous.sessions_settled} settled sessions out of ${previous.sessions_created}. ${change === null ? 'A conversion comparison is unavailable because one period has no sessions.' : `The conversion difference is ${change} percentage points.`} The earlier cohort has had longer to settle; this is not a causal or like-for-like maturity comparison.`,
    },
    {
      id: 'refunds',
      text: `${current.sessions_with_refunds} sessions have at least one refund record. These include pending and failed refunds; they are not a count of completed refunds.`,
    },
    {
      id: 'volume',
      text:
        current.settled_order_totals.length === 0
          ? 'No settled order totals are available for this cohort.'
          : `Settled order totals by currency: ${current.settled_order_totals
              .slice(0, 10)
              .map((t) => `${t.amount} ${t.currency}`)
              .join(
                '; ',
              )}.${current.settled_order_totals.length > 10 ? ' Only the first ten currencies are summarized; the report contains all currencies.' : ''} These are order totals, not net receipts or current balances; fees and refunds are not deducted, and currencies are not combined.`,
    },
    {
      id: 'unsupported',
      text: 'This report can explain recorded checkout conversion, deposits and refunds. It cannot identify individual shoppers, prove causes, predict future revenue, or change payments or store settings.',
    },
  ];
  return {
    livemode: ctx.livemode,
    window: { from: start.toISOString(), to: now.toISOString(), days },
    current,
    previous,
    conversion_change_percentage_points: change,
    facts,
    generated_at: now.toISOString(),
    source: 'database_aggregates',
  };
}

export async function explainInsights(
  ctx: MerchantAiContext,
  input: InsightInput,
  deps: { selector?: FactSelector; reserve?: typeof reserveAiUsage } = {},
) {
  const report = await merchantInsights(ctx, input.days);
  const selector = deps.selector ?? (await configuredSelector('insights'));
  await (deps.reserve ?? reserveAiUsage)(ctx, 'insights');
  const ids = await selector(input.question, report.facts);
  const facts = report.facts.filter((f) => f.id === 'scope' || ids.includes(f.id));
  return {
    report,
    answer: facts.map((f) => f.text).join('\n\n'),
    facts,
    source: 'model_selected_facts' as const,
    read_only: true as const,
  };
}
