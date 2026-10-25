// Checkout quote pricing: who pays, how the 1Click quote requests are sized, gas reimbursement and
// the minimum check. Pure functions, no I/O.
//
// Money math never uses floats. Token amounts are bigint base units. USD values are parsed from
// decimal strings exactly; where a fixed scale is needed they are micro-USD bigints (6 decimals,
// matching the `Decimal(18,6)` USD columns). Every rounding is documented where it happens:
// amounts the shopper must send round UP, amounts credited to anyone round DOWN.

import { QUOTE_TTL_MS, type FeePayer, type GasPayer } from '@tendr/contracts';
import { AppError } from '../lib/errors.js';
import {
  OneClickError,
  type AppFee,
  type QuoteRequest,
  type QuoteResponse,
} from './oneclick/types.js';

/** A non-negative decimal: a plain string ("25.10") or a Prisma.Decimal (anything with `toFixed()`). */
export type DecimalLike = string | { toFixed(): string };

/** Slippage tolerance sent with every quote, in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** Quotes worth less than this (USD) are refused with `QUOTE_TOO_SMALL`. */
export const MIN_QUOTE_USD = 0.5;

const USD_SCALE = 6;

// ---------------------------------------------------------------------------------------------
// Exact decimal helpers
// ---------------------------------------------------------------------------------------------

interface Exact {
  /** value = digits / 10^scale */
  digits: bigint;
  scale: number;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

function toPlainString(d: DecimalLike): string {
  if (typeof d === 'string') return d.trim();
  // Guard against a JS number sneaking in: Number#toFixed() rounds to an integer.
  if (typeof d !== 'object' || d === null)
    throw new TypeError('Expected a decimal string or Decimal');
  return d.toFixed();
}

function parseExact(d: DecimalLike): Exact {
  const s = toPlainString(d);
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new TypeError(`Not a non-negative decimal: "${s}"`);
  const frac = m[2] ?? '';
  return { digits: BigInt(m[1] + frac), scale: frac.length };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Scales an exact decimal to `scale` fixed digits, rounding as told. */
function toScaled(d: DecimalLike, scale: number, rounding: 'up' | 'down'): bigint {
  const { digits, scale: s } = parseExact(d);
  if (s <= scale) return digits * 10n ** BigInt(scale - s);
  const div = 10n ** BigInt(s - scale);
  return rounding === 'up' ? ceilDiv(digits, div) : digits / div;
}

/**
 * Converts a whole-unit decimal (e.g. "25.10" USDC) to base units. Rounds UP: this sizes what the
 * shopper must deliver, so a sub-unit remainder never shortchanges the merchant.
 */
export function toBaseUnits(amount: DecimalLike, decimals: number): bigint {
  return toScaled(amount, decimals, 'up');
}

function microToDecimal(micro: bigint): string {
  const unit = 10n ** BigInt(USD_SCALE);
  return `${micro / unit}.${(micro % unit).toString().padStart(USD_SCALE, '0')}`;
}

function microToNumber(micro: bigint): number {
  // Display-only conversion. Micro-USD values here are far below 2^53.
  return Number(micro) / 10 ** USD_SCALE;
}

// ---------------------------------------------------------------------------------------------
// Who pays
// ---------------------------------------------------------------------------------------------

export interface PayerChoice {
  feePayer?: FeePayer | null;
  gasPayer?: GasPayer | null;
}

export interface ResolvedPayers {
  feePayer: FeePayer;
  gasPayer: GasPayer;
}

/**
 * Who-pays resolution, field by field: session override → payment-link setting → merchant default.
 * All in API vocabulary; callers map the DB enums (`payer`, `buyer`, link `gas_sponsor = default`
 * → null) before calling.
 */
export function resolvePayers(args: {
  sessionOverride: PayerChoice;
  link: PayerChoice | null;
  merchant: { defaultFeePayer: FeePayer; defaultGasPayer: GasPayer };
}): ResolvedPayers {
  const { sessionOverride, link, merchant } = args;
  return {
    feePayer: sessionOverride.feePayer ?? link?.feePayer ?? merchant.defaultFeePayer,
    gasPayer: sessionOverride.gasPayer ?? link?.gasPayer ?? merchant.defaultGasPayer,
  };
}

// ---------------------------------------------------------------------------------------------
// Gas reimbursement
// ---------------------------------------------------------------------------------------------

/**
 * Micro-USD the merchant reimburses for the shopper's origin-chain send: 0 when the shopper pays
 * gas, else min(estimate, cap). A null cap means uncapped. Rounds DOWN (it is credited to the
 * shopper).
 */
export function gasReimbursementMicroUsd(
  gasPayer: GasPayer,
  gasEstimateUsd: DecimalLike,
  gasMaxUsd: DecimalLike | null,
): bigint {
  if (gasPayer === 'shopper') return 0n;
  const estimate = toScaled(gasEstimateUsd, USD_SCALE, 'down');
  if (gasMaxUsd === null) return estimate;
  const cap = toScaled(gasMaxUsd, USD_SCALE, 'down');
  return estimate < cap ? estimate : cap;
}

/** `gasReimbursementMicroUsd` as a USD number, for display and records. Exact to 6 decimals. */
export function gasReimbursementUsd(
  gasPayer: GasPayer,
  gasEstimateUsd: DecimalLike,
  gasMaxUsd: DecimalLike | null,
): number {
  return microToNumber(gasReimbursementMicroUsd(gasPayer, gasEstimateUsd, gasMaxUsd));
}

// ---------------------------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------------------------

/** min(now + QUOTE_TTL_MS, session expiry) as ISO-8601. Refuses an already-expired session. */
export function quoteDeadline(now: Date, sessionExpiresAt: Date): string {
  if (sessionExpiresAt.getTime() <= now.getTime()) {
    throw new AppError('EXPIRED', 'Checkout session has expired', 410);
  }
  const ttl = now.getTime() + QUOTE_TTL_MS;
  return new Date(Math.min(ttl, sessionExpiresAt.getTime())).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Quote requests
// ---------------------------------------------------------------------------------------------

export interface PricingInput {
  /** Order total in whole units (`sessions.amount`): USD, or the settlement asset itself. */
  orderAmount: DecimalLike;
  /** `USD` or exactly `settlementAsset` (validated upstream; anything else is rejected here too). */
  amountCurrency: string;
  settlementAsset: string;
  settlementDecimals: number;
  originAsset: string;
  originDecimals: number;
  /** Tendr fee in basis points; 0 sends no `appFees`. */
  feeBps: number;
  feePayer: FeePayer;
  gasPayer: GasPayer;
  /** Estimated origin-chain send fee, USD. */
  gasEstimateUsd: DecimalLike;
  /** Per-session reimbursement cap, USD; null = uncapped. */
  gasMaxUsd: DecimalLike | null;
  recipient: string;
  recipientType: QuoteRequest['recipientType'];
  refundTo: string;
  refundType: QuoteRequest['refundType'];
  feeAccount: string;
  /** The quote deadline is min(now + QUOTE_TTL_MS, this). */
  sessionExpiresAt: Date;
  /** Injected for tests; defaults to the current time. */
  now?: Date;
  slippageBps?: number;
}

export interface QuoteRequests {
  /** Dry EXACT_INPUT probe of one whole origin token; its amountInUsd / amountIn is the price. */
  dry: QuoteRequest;
  /** The real (deposit-allocating) request, sized from the dry result where needed. */
  real: (dryResult: QuoteResponse) => QuoteRequest;
}

function tooSmall(message: string, details?: unknown): AppError {
  return new AppError('QUOTE_TOO_SMALL', message, 400, details);
}

/**
 * Builds the two-step quote.
 *
 * - Shopper pays fees: EXACT_OUTPUT for the order total in settlement base units. Tendr's appFee
 *   and 1Click's costs make the shopper's amountIn grow. If the merchant pays gas, the output is
 *   reduced by the reimbursement (so amount_in shrinks by it).
 * - Merchant pays fees: EXACT_INPUT sized from the dry price so the shopper's amountInUsd equals
 *   orderUsd − gas reimbursement; all fees and spread come out of the merchant's amount_out.
 *
 * Settlement assets are USD stablecoins in the pilot, so a USD order and an order in the
 * settlement asset are both 1:1 with the settlement asset.
 */
export function buildQuoteRequests(input: PricingInput): QuoteRequests {
  if (input.amountCurrency !== 'USD' && input.amountCurrency !== input.settlementAsset) {
    throw new AppError(
      'VALIDATION_ERROR',
      `amount_currency must be USD or the settlement asset (${input.settlementAsset})`,
      400,
    );
  }
  const deadline = quoteDeadline(input.now ?? new Date(), input.sessionExpiresAt);
  const appFees: AppFee[] | undefined =
    input.feeBps > 0 ? [{ recipient: input.feeAccount, fee: input.feeBps }] : undefined;

  const base = {
    slippageTolerance: input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    originAsset: input.originAsset,
    depositType: 'ORIGIN_CHAIN' as const,
    destinationAsset: input.settlementAsset,
    refundTo: input.refundTo,
    refundType: input.refundType,
    recipient: input.recipient,
    recipientType: input.recipientType,
    deadline,
    ...(appFees ? { appFees } : {}),
  };

  const dry: QuoteRequest = {
    dry: true,
    swapType: 'EXACT_INPUT',
    ...base,
    amount: (10n ** BigInt(input.originDecimals)).toString(),
  };

  // Order total in micro-USD. Rounds UP: the shopper owes the full order.
  const orderMicro = toScaled(input.orderAmount, USD_SCALE, 'up');
  const gasMicro = gasReimbursementMicroUsd(input.gasPayer, input.gasEstimateUsd, input.gasMaxUsd);
  const targetMicro = orderMicro - gasMicro;
  if (targetMicro <= 0n) {
    throw tooSmall('The gas reimbursement covers the whole order', {
      order_usd: microToNumber(orderMicro),
      gas_reimbursement_usd: microToNumber(gasMicro),
    });
  }

  if (input.feePayer === 'shopper') {
    // Order in settlement base units (rounds UP, via toBaseUnits) minus the gas reimbursement in
    // settlement base units (rounds DOWN: it is credited to the shopper).
    const gasBase = toScaled(microToDecimal(gasMicro), input.settlementDecimals, 'down');
    const amount = toBaseUnits(input.orderAmount, input.settlementDecimals) - gasBase;
    if (amount <= 0n) throw tooSmall('The gas reimbursement covers the whole order');
    const real: QuoteRequest = {
      dry: false,
      swapType: 'EXACT_OUTPUT',
      ...base,
      amount: amount.toString(),
    };
    return { dry, real: () => real };
  }

  return {
    dry,
    real: (dryResult) => {
      const dryIn = BigInt(dryResult.quote.amountIn);
      const dryUsd = parseExact(dryResult.quote.amountInUsd);
      if (dryIn <= 0n || dryUsd.digits <= 0n) {
        throw new OneClickError('Dry quote has no usable price', null, 'BAD_RESPONSE', {
          amountIn: dryResult.quote.amountIn,
          amountInUsd: dryResult.quote.amountInUsd,
        });
      }
      // amountIn = ceil(dryIn × target / dryUsd), with target = targetMicro / 10^6 and
      // dryUsd = digits / 10^scale, computed exactly. Rounds UP: the shopper's send must be worth
      // at least the target.
      const num = dryIn * targetMicro * 10n ** BigInt(dryUsd.scale);
      const den = dryUsd.digits * 10n ** BigInt(USD_SCALE);
      const amountIn = ceilDiv(num, den);
      return { dry: false, swapType: 'EXACT_INPUT', ...base, amount: amountIn.toString() };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Minimum
// ---------------------------------------------------------------------------------------------

/**
 * Refuses a quote worth less than `minUsd`, on either side: what the shopper sends
 * (`amountInUsd`) and what the merchant receives (`amountOutUsd`). Compared exactly.
 */
export function assertWithinMinimum(quote: QuoteResponse, minUsd: number = MIN_QUOTE_USD): void {
  // minUsd is a small configured constant; render it to micro-USD exactly via its decimal string.
  const minMicro = toScaled(minUsd.toFixed(USD_SCALE), USD_SCALE, 'up');
  const inMicro = toScaled(quote.quote.amountInUsd, USD_SCALE, 'down');
  const outMicro = toScaled(quote.quote.amountOutUsd, USD_SCALE, 'down');
  if (inMicro < minMicro || outMicro < minMicro) {
    throw tooSmall(`Payments under $${minUsd.toFixed(2)} are not supported`, {
      min_usd: minUsd,
      amount_in_usd: quote.quote.amountInUsd,
      amount_out_usd: quote.quote.amountOutUsd,
    });
  }
}
