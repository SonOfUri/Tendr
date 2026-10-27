// The network fee of a checkout quote (project 5a, spec §2.1, §2.4, §2.5, §8.1, §8.2): who pays it,
// how, and what it costs, decided when the shopper asks for a quote.
//
//   No connected wallet / no gasless method → the shopper's wallet (or the copy-address send)
//     pays gas itself: `paid_by: shopper`, `fee_mode: native`, the shopper's own estimate.
//   Wallet + gasless method → `decideSponsor`. The merchant sponsors: the fee (with Tendr's margin)
//     is reserved on the budget and taken from the merchant's proceeds. Otherwise the shopper
//     pays: in the payment token on top of `amount_in` (`fee_mode: token`, the default), or in the
//     chain's coin (`native`, a normal wallet send).
// An integrator session (`delivery = HOOK`) also has the hook call's estimate taken from the
// merchant's proceeds; it never counts against the budget (§4.2).
import { Prisma, type SponsorshipMethod } from '@prisma/client';
import {
  type FeeMode,
  type GasPayer,
  type GaslessMethod,
  type NetworkFeeView,
  gasPayerFromDb,
} from '@tendr/contracts';
import { chainFamily } from '../checkout/address-format.js';
import { gasEstimateUsd } from '../checkout/gas-estimates.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { releaseReservation } from './budget.js';
import {
  estimateHookFeeUsd,
  estimateNetworkFeeUsd,
  feeInToken,
  gaslessMethodSupported,
  isNativeToken,
  withFeeMargin,
} from './fees.js';
import { decideSponsor } from './sponsorship.js';

/** Why the shopper pays: a `decideSponsor` reason, or a quote-time fallback. */
export type NetworkFeeReason =
  | NonNullable<Awaited<ReturnType<typeof decideSponsor>>['reason']>
  /** The live fee could not be estimated: the shopper's wallet pays gas itself. */
  | 'fee_unavailable'
  /** The token list has no price for the payment token: the token option is unavailable. */
  | 'fee_token_unpriced';

export interface NetworkFeePlan {
  paidBy: GasPayer;
  feeMode: FeeMode | null;
  method: GaslessMethod | null;
  /** `network_fee.usd`: the quoted fee (with margin when Tendr collects it), a decimal string. */
  usd: string;
  /** Shopper token fee in origin-asset base units, on top of `amount_in`; null otherwise. */
  tokenAmount: string | null;
  reason: NetworkFeeReason | null;
  /** What the merchant sponsors (reserved on the budget, taken from proceeds); '0' otherwise. */
  sponsoredUsd: string;
  /** The integrator hook estimate taken from proceeds (with margin); '0' unless `HOOK`. */
  hookUsd: string;
}

export interface PlanInput {
  livemode: boolean;
  merchantId: string;
  session: {
    id: string;
    amount: Prisma.Decimal;
    gasSponsor: 'merchant' | 'buyer';
    gasMaxUsd: Prisma.Decimal | null;
    delivery: 'WEBHOOK' | 'HOOK';
    destChain: string;
  };
  origin: { assetId: string; blockchain: string; symbol: string };
  walletAddress?: string;
  method?: GaslessMethod;
  feeMode?: FeeMode;
  /** Skip the sponsorship decision: the shopper pays for this reason (a refused reservation). */
  forceShopper?: NetworkFeeReason;
  now?: Date;
}

/** Who submits (and pays gas for) a gasless method on a chain. */
export function gasProvider(chain: string, method: GaslessMethod): string {
  if (method === 'paymaster' || method === 'kora') return 'pimlico';
  if (method === 'meta_tx') return 'relayer-near';
  if (chainFamily(chain) === 'tron') return 'gas-tron';
  return 'relayer-evm';
}

/** The shopper's own gas for a normal send (display only; the static estimate if live fails). */
async function nativeEstimate(input: PlanInput): Promise<string> {
  const { blockchain } = input.origin;
  try {
    return await estimateNetworkFeeUsd(blockchain, 'native', {
      livemode: input.livemode,
      nativeAsset: isNativeToken(input.origin),
    });
  } catch (err) {
    log('warn', 'network fee: native estimate unavailable, using the static estimate', {
      chain: blockchain,
      err: String(err),
    });
    return gasEstimateUsd(blockchain);
  }
}

async function hookEstimate(input: PlanInput): Promise<string> {
  if (input.session.delivery !== 'HOOK') return '0';
  return withFeeMargin(
    await estimateHookFeeUsd(input.session.destChain, { livemode: input.livemode }),
  );
}

/**
 * Plans the quote's network fee. Throws VALIDATION_ERROR (400) for a gasless method the origin
 * chain cannot use, and NETWORK_FEE_UNAVAILABLE (503) when an integrator session's hook estimate
 * is unavailable. Reads state only: the budget is reserved by the caller (`reserveBudget`) when it
 * stores the quote.
 */
export async function planNetworkFee(input: PlanInput): Promise<NetworkFeePlan> {
  const chain = input.origin.blockchain;
  const hookUsd = await hookEstimate(input);
  const native = async (reason: NetworkFeeReason | null): Promise<NetworkFeePlan> => ({
    paidBy: 'shopper',
    feeMode: 'native',
    method: null,
    usd: await nativeEstimate(input),
    tokenAmount: null,
    reason,
    sponsoredUsd: '0',
    hookUsd,
  });

  if (!input.walletAddress || !input.method) return native(null);
  const method = input.method;
  if (!gaslessMethodSupported(chain, method)) {
    throw new AppError('VALIDATION_ERROR', `${method} is not available on ${chain}`, 400, {
      field: 'gasless_method',
    });
  }

  let raw: string;
  try {
    raw = await estimateNetworkFeeUsd(chain, method, { livemode: input.livemode });
  } catch (err) {
    if (err instanceof AppError && err.code === 'NETWORK_FEE_UNAVAILABLE') {
      return native('fee_unavailable');
    }
    throw err;
  }
  const feeUsd = withFeeMargin(raw);
  // Sponsorship is collected as whole appFees bps whose charging base is still unconfirmed
  // (ONECLICK_APP_FEE_BASE): it is capped at MAX_SPONSORED_ORDER_BPS of the order.
  const overCap = new Prisma.Decimal(feeUsd)
    .plus(hookUsd)
    .mul(10_000)
    .gt(input.session.amount.mul(MAX_SPONSORED_ORDER_BPS));
  const forced = input.forceShopper ?? (overCap ? 'per_payment_cap' : undefined);
  const decision = forced
    ? { paidBy: 'shopper' as const, reason: forced }
    : await decideSponsor({
        merchantId: input.merchantId,
        livemode: input.livemode,
        sessionId: input.session.id,
        chain,
        assetId: input.origin.assetId,
        orderUsd: input.session.amount.toFixed(),
        shopperAddress: input.walletAddress,
        feeUsd,
        sessionOverride: gasPayerFromDb(input.session.gasSponsor),
        linkSetting: null,
        gasMaxUsd: input.session.gasMaxUsd ? input.session.gasMaxUsd.toFixed() : null,
        ...(input.now ? { now: input.now } : {}),
      });
  if (decision.paidBy === 'merchant') {
    return {
      paidBy: 'merchant',
      feeMode: null,
      method,
      usd: feeUsd,
      tokenAmount: null,
      reason: null,
      sponsoredUsd: feeUsd,
      hookUsd,
    };
  }

  const reason = decision.reason;
  if ((input.feeMode ?? 'token') === 'native') return native(reason);
  // The fee moves in the same transaction: an EIP-3009 payment then signs a second authorization.
  let withLeg: string;
  try {
    withLeg = await estimateNetworkFeeUsd(chain, method, {
      livemode: input.livemode,
      feeLeg: true,
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'NETWORK_FEE_UNAVAILABLE') {
      return native('fee_unavailable');
    }
    throw err;
  }
  try {
    const fee = await feeInToken(input.origin.assetId, withLeg, { livemode: input.livemode });
    return {
      paidBy: 'shopper',
      feeMode: 'token',
      method,
      usd: withFeeMargin(withLeg),
      tokenAmount: fee.amount,
      reason,
      sponsoredUsd: '0',
      hookUsd,
    };
  } catch (err) {
    if (err instanceof AppError && err.code === 'FEE_TOKEN_UNPRICED') {
      return native('fee_token_unpriced');
    }
    throw err;
  }
}

/** The quote columns that record a plan (the reservation id is set by the caller). */
export function planColumns(plan: NetworkFeePlan, networkFeeBps: number) {
  return {
    networkFeePaidBy: plan.paidBy === 'merchant' ? ('merchant' as const) : ('buyer' as const),
    networkFeeMode: plan.feeMode,
    networkFeeUsd: plan.usd,
    networkFeeAmount: plan.tokenAmount,
    networkFeeMethod: plan.method as SponsorshipMethod | null,
    networkFeeReason: plan.reason,
    networkFeeBps,
    hookFeeUsd: plan.hookUsd === '0' ? null : plan.hookUsd,
  };
}

type FeeColumns = {
  originAssetId: string;
  networkFeePaidBy: 'merchant' | 'buyer' | null;
  networkFeeMode: FeeMode | null;
  networkFeeUsd: Prisma.Decimal | null;
  networkFeeAmount: Prisma.Decimal | null;
  networkFeeMethod: string | null;
  networkFeeReason: string | null;
};

/**
 * The most a merchant may sponsor (network fee + integrator hook estimate), in basis points of the
 * order. Above it the shopper pays (`per_payment_cap`).
 */
export const MAX_SPONSORED_ORDER_BPS = 100;

/** Reasons the pay page may see as they are; any other becomes `not_sponsored`. */
const SHOPPER_REASONS = new Set(['shopper_choice', 'fee_unavailable', 'fee_token_unpriced']);

/**
 * The reason as the shopper may see it. The merchant's budget, caps, the shopper's payment history
 * and Tendr's loss cap are private: they read `not_sponsored`. The pay page still sees the
 * reasons that decide which fee options it shows.
 */
export function shopperReason(reason: string | null): string | null {
  return reason === null || SHOPPER_REASONS.has(reason) ? reason : 'not_sponsored';
}

/**
 * `network_fee` for a quote; null for a quote made before gasless payments. `shopper`: the
 * pay-page view, with the reason made public-safe (`shopperReason`); merchant views and webhooks
 * keep the full reason.
 */
export function networkFeeView(
  q: FeeColumns,
  audience: 'merchant' | 'shopper' = 'merchant',
): NetworkFeeView | null {
  if (!q.networkFeePaidBy || !q.networkFeeUsd) return null;
  const token = q.networkFeeMode === 'token';
  return {
    paid_by: gasPayerFromDb(q.networkFeePaidBy),
    fee_mode: q.networkFeeMode,
    amount: token && q.networkFeeAmount ? q.networkFeeAmount.toFixed(0) : null,
    asset: token ? q.originAssetId : null,
    usd: q.networkFeeUsd.toFixed(),
    method: q.networkFeeMethod,
    reason: audience === 'shopper' ? shopperReason(q.networkFeeReason) : q.networkFeeReason,
  };
}

/** How long past its deadline an unused quote keeps its reservation (a late relay may land). */
export const RESERVATION_GRACE_MS = 5 * 60_000;

/**
 * Releases budget reservations whose quote can no longer be used: superseded, or past its deadline
 * plus RESERVATION_GRACE_MS, with no deposit reported and no payment. Scheduled every minute.
 * Returns how many were released.
 */
export async function releaseStaleReservations(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RESERVATION_GRACE_MS);
  const stale = await prisma.quote.findMany({
    where: {
      gasSponsorship: { reservationState: 'reserved' },
      depositTxSubmittedAt: null,
      payments: { none: {} },
      OR: [{ supersededAt: { not: null } }, { deadline: { lte: cutoff } }],
    },
    select: { id: true, gasSponsorshipId: true },
    take: 500,
  });
  let released = 0;
  for (const q of stale) {
    try {
      const did = await prisma.$transaction((tx) => releaseReservation(tx, q.gasSponsorshipId!));
      if (did) released++;
    } catch (err) {
      log('error', 'gas reservation release failed', { quoteId: q.id, err: String(err) });
    }
  }
  return released;
}
