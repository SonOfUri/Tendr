import {
  feePayerFromDb,
  type RecommendationInput,
  type RouteRecommendation,
  type RouteRecommendations,
} from '@tendr/contracts';
import { Prisma } from '@prisma/client';
import { feeAccountFor, providerFor } from '../checkout/oneclick/index.js';
import { sessionDepositInFlight } from '../checkout/in-flight.js';
import { tokenList } from '../checkout/tokens.js';
import {
  assertOutputWithinTarget,
  assertWithinMinimum,
  assertWithinTarget,
  buildQuoteRequests,
} from '../checkout/pricing.js';
import { AppError, conflict } from '../lib/errors.js';
import { aiSession, type AiContext } from './context.js';
import { reserveAiUsage } from './budget.js';

export async function recommendRoutes(
  ctx: AiContext,
  input: RecommendationInput,
): Promise<RouteRecommendations> {
  const { session: s } = await aiSession(ctx);
  const now = new Date();
  if (s.status === 'EXPIRED' || s.expiresAt <= now)
    throw new AppError('SESSION_EXPIRED', 'This checkout has expired', 409);
  if (s.status !== 'PENDING_DEPOSIT')
    throw conflict('This checkout is no longer taking new payments');
  if (await sessionDepositInFlight({ ...ctx, id: s.id, expiresAt: s.expiresAt }, now))
    throw conflict('A payment is already in progress');
  await reserveAiUsage(ctx, 'recommendations');
  const tokens = await tokenList(ctx.livemode);
  const destination = tokens.get(s.destAsset);
  if (!destination)
    throw new AppError('UNSUPPORTED_ASSET', 'The settlement asset is unavailable', 400);
  const provider = providerFor(ctx.livemode);
  const feePayer = feePayerFromDb(s.feePayer);
  const refundTo = s.intentsAccount ?? (s.recipientType === 'INTENTS' ? s.recipient : null);
  if (!refundTo) throw conflict('This checkout has no refund account for route previews');

  // At most four candidates, at most two dry requests each. No allocation or state transitions.
  const results = await Promise.all(
    input.assets.map(
      async (
        candidate,
      ): Promise<
        | { route: RouteRecommendation }
        | { unavailable: RouteRecommendations['unavailable'][number] }
      > => {
        const origin = tokens.get(candidate.asset_id);
        if (!origin)
          return { unavailable: { asset_id: candidate.asset_id, reason: 'unsupported' } };
        try {
          const reqs = buildQuoteRequests({
            orderAmount: s.amount,
            amountCurrency: s.amountCurrency,
            settlementAsset: s.destAsset,
            settlementDecimals: destination.decimals,
            originAsset: origin.assetId,
            originDecimals: origin.decimals,
            feeBps: s.feeBps,
            feePayer,
            recipient: s.recipient,
            recipientType: s.recipientType,
            refundTo,
            refundType: 'INTENTS',
            feeAccount: feeAccountFor(ctx.livemode),
            sessionExpiresAt: s.expiresAt,
            now,
          });
          const probe = await provider.quote({ ...reqs.dry, dry: true });
          const result = await provider.quote({ ...reqs.real(probe), dry: true });
          if (feePayer === 'merchant') assertWithinTarget(result, reqs.targetUsd);
          if (reqs.expectedOutUsd) assertOutputWithinTarget(result, reqs.expectedOutUsd);
          assertWithinMinimum(result);
          const q = result.quote;
          if (
            !/^\d{1,78}$/.test(q.amountIn) ||
            !/^\d{1,78}$/.test(q.amountOut) ||
            !/^\d{1,20}(\.\d{1,18})?$/.test(q.amountInUsd) ||
            BigInt(q.amountIn) === 0n ||
            BigInt(q.amountOut) === 0n
          )
            throw new Error('Invalid quote');
          if (candidate.balance !== undefined && BigInt(candidate.balance) < BigInt(q.amountIn)) {
            return { unavailable: { asset_id: origin.assetId, reason: 'insufficient_balance' } };
          }
          return {
            route: {
              asset_id: origin.assetId,
              symbol: origin.symbol,
              chain: origin.blockchain,
              amount_in: q.amountIn,
              amount_in_usd: q.amountInUsd,
              amount_out: q.amountOut,
              estimated_seconds: q.timeEstimate ?? null,
              balance_sufficient: candidate.balance === undefined ? null : true,
            },
          };
        } catch {
          return { unavailable: { asset_id: candidate.asset_id, reason: 'quote_unavailable' } };
        }
      },
    ),
  );
  // A checkout may have changed while providers were responding. Never offer new routes then.
  const { session: fresh } = await aiSession(ctx);
  if (fresh.status !== 'PENDING_DEPOSIT' || fresh.expiresAt <= new Date())
    throw conflict('This checkout is no longer taking new payments');
  if (await sessionDepositInFlight({ ...ctx, id: s.id, expiresAt: s.expiresAt }, new Date()))
    throw conflict('A payment is already in progress');
  if (Date.now() >= now.getTime() + 30_000)
    throw new AppError('PROVIDER_UNAVAILABLE', 'Route previews expired; try again', 503);
  const routes = results
    .flatMap((r) => ('route' in r ? [r.route] : []))
    .sort((a, b) => {
      const cost = new Prisma.Decimal(a.amount_in_usd).comparedTo(b.amount_in_usd);
      return (
        cost ||
        (a.estimated_seconds ?? Infinity) - (b.estimated_seconds ?? Infinity) ||
        a.asset_id.localeCompare(b.asset_id)
      );
    });
  const fastest = [...routes]
    .filter((r) => r.estimated_seconds !== null)
    .sort((a, b) => a.estimated_seconds! - b.estimated_seconds!)[0];
  return {
    routes,
    unavailable: results.flatMap((r) => ('unavailable' in r ? [r.unavailable] : [])),
    recommended: routes[0]?.asset_id ?? null,
    cheapest: routes[0]?.asset_id ?? null,
    fastest: fastest?.asset_id ?? null,
    generated_at: now.toISOString(),
    expires_at: new Date(Math.min(now.getTime() + 30_000, s.expiresAt.getTime())).toISOString(),
    source: ctx.livemode ? 'live_quotes' : 'simulated_quotes',
    ranking_basis: 'quoted_input_usd_excluding_wallet_gas',
    wallet_gas_included: false,
    requires_fresh_quote: true,
  };
}
