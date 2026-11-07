import type { AssistantAnswer, AssistantInput, SessionStatus } from '@tendr/contracts';
import { aiSession, type AiContext } from './context.js';
import { configuredSelector, type AssistantFact, type FactSelector } from './provider.js';
import { reserveAiUsage } from './budget.js';

const STATUS: Record<SessionStatus, string> = {
  PENDING_DEPOSIT: 'This checkout is waiting for payment. The order is not confirmed as paid.',
  PROCESSING: 'A payment is being processed. The order is not confirmed as paid yet.',
  SETTLED: 'The payment for this checkout has settled. Refunds, if any, are tracked separately.',
  REFUNDED: 'This checkout is recorded as refunded.',
  EXPIRED: 'This checkout has expired. Do not send a new payment to its old deposit address.',
  LATE_DEPOSIT:
    'A payment arrived after this checkout expired. It does not confirm the order as paid; check the refund status.',
  HELD: 'This payment needs merchant review. Contact the store for help.',
  SCREENING_PENDING:
    'Payment verification is still in progress. The order is not confirmed as paid yet.',
};

export async function checkoutFacts(ctx: AiContext, now = new Date()): Promise<AssistantFact[]> {
  const { db, session: s } = await aiSession(ctx);
  const [refunds, needsAddress, underpaid] = await Promise.all([
    db.refund.groupBy({ by: ['status'], where: { payment: { sessionId: s.id } }, _count: true }),
    db.refund.count({
      where: {
        payment: { sessionId: s.id },
        needsAddress: true,
        status: { in: ['pending', 'submitted'] },
      },
    }),
    db.payment.count({
      where: { sessionId: s.id, status: 'PROCESSING', oneclickStatus: 'INCOMPLETE_DEPOSIT' },
    }),
  ]);
  const count = (status: string) => refunds.find((r) => r.status === status)?._count ?? 0;
  const totalRefunds = refunds.reduce((n, r) => n + r._count, 0);
  const expired = s.status === 'PENDING_DEPOSIT' && s.expiresAt <= now;
  return [
    {
      id: 'status',
      text: `${ctx.livemode ? '' : 'This is a test payment. '}${expired ? 'The checkout deadline has passed, and payment is not confirmed. If you already sent funds, wait for the checkout to update; do not send another payment.' : STATUS[s.status]}`,
    },
    {
      id: 'refunds',
      text:
        totalRefunds === 0
          ? 'There are no refund records for this checkout. Contact the store if you want to request a refund.'
          : `Refund records: ${count('confirmed')} confirmed, ${count('submitted')} submitted, ${count('pending')} pending, ${count('failed')} failed.${needsAddress ? ' A refund needs a return address; use the checkout’s return-address form or the emailed link.' : ''} Pending or submitted refunds are not confirmed as received. Contact the store for unresolved refunds.`,
    },
    {
      id: 'underpayment',
      text: underpaid
        ? 'An incomplete deposit is recorded. Use the checkout’s current instructions to check whether a top-up is still available; do not calculate a new send amount from this answer.'
        : 'No currently processing incomplete deposit is recorded for this checkout.',
    },
    {
      id: 'fees',
      text: `The checkout’s Tendr fee is assigned to the ${s.feePayer === 'merchant' ? 'merchant' : 'shopper'}. Network-fee policy is ${s.gasSponsor === 'merchant' ? 'merchant-sponsored where available' : 'shopper-paid'}. The current checkout quote shows the actual fee breakdown; this assistant does not provide a new quote.`,
    },
    {
      id: 'network',
      text: 'Use the exact token, network, amount and deposit details shown in the current checkout quote. The same token on a different network is a different payment route. This assistant does not generate payment addresses.',
    },
    {
      id: 'privacy',
      text: 'This checkout uses public blockchain payment routes. Tendr restricts access to order records, but blockchain transfers are not confidential or anonymous.',
    },
    {
      id: 'capabilities',
      text: 'I can explain this checkout’s recorded payment and refund state. I cannot send funds, approve a refund, change a recipient, or mark an order as paid.',
    },
    {
      id: 'unsupported',
      text: 'I can help with this checkout’s payment status, refunds, fees and network instructions. I do not have information to answer that question; contact the store for order or delivery questions.',
    },
  ];
}

export async function answerCheckout(
  ctx: AiContext,
  input: AssistantInput,
  deps: { selector?: FactSelector; reserve?: typeof reserveAiUsage; now?: () => Date } = {},
): Promise<AssistantAnswer> {
  // Authenticate/read scope before any external call. Fetch provider credentials outside model context.
  const facts = await checkoutFacts(ctx);
  const selector = deps.selector ?? (await configuredSelector());
  await (deps.reserve ?? reserveAiUsage)(ctx, 'assistant');
  const ids = await selector(input.question, facts);
  // Re-read after model latency; a settlement/refund may have completed during generation.
  const now = (deps.now ?? (() => new Date()))();
  const fresh = await checkoutFacts(ctx, now);
  const selected = fresh.filter((f) => f.id === 'status' || ids.includes(f.id));
  return {
    answer: selected.map((f) => f.text).join('\n\n'),
    facts: selected,
    generated_at: now.toISOString(),
    source: 'model_selected_facts',
    read_only: true,
  };
}
