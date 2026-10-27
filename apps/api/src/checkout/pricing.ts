// Checkout quote pricing: who pays, how the 1Click quote requests are sized (including a
// merchant-sponsored network fee taken from the merchant's proceeds) and the minimum check. Pure
// functions, no I/O.
//
// Money math never uses floats. Token amounts are bigint base units. USD values are parsed from
// decimal strings exactly; where a fixed scale is needed they are micro-USD bigints (6 decimals,
// matching the `Decimal(18,6)` USD columns). Every rounding is documented where it happens:
// amounts the shopper must send round UP, amounts credited to anyone round DOWN.

import { QUOTE_TTL_MS, type FeePayer, type GasPayer } from '@tendr/contracts';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import {
  OneClickError,
  truncateUntrusted,
  type AppFee,
  type QuoteRequest,
  type QuoteResponse,
} from './oneclick/types.js';

/** A non-negative decimal: a plain string ("25.10") or a Prisma.Decimal (anything with `toFixed()`). */
export type DecimalLike = string | { toFixed(): string };

export { DEFAULT_GAS_MAX_USD, DEFAULT_SLIPPAGE_BPS } from '@tendr/contracts';
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

// 1Click response values are parsed more leniently than our own inputs: an optional `+` and
// exponent notation ("1.5e-7") are expanded exactly. Anything unparseable is the provider's fault
// and surfaces as OneClickError BAD_RESPONSE (not a bare TypeError → 500).
const RESPONSE_DECIMAL_RE = /^\+?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const RESPONSE_INT_RE = /^\+?(\d+)$/;
/** Bounds the exponent so a hostile "1e999999999" cannot allocate a huge bigint. */
const MAX_RESPONSE_EXPONENT = 100;

function badResponse(field: string, value: unknown): OneClickError {
  // The value is untrusted provider text: truncated before it reaches API errors and logs (T3).
  return new OneClickError(`1Click returned an unparseable ${field}`, null, 'BAD_RESPONSE', {
    field,
    value: truncateUntrusted(value),
  });
}

/** Parses a non-negative decimal from a 1Click response, exactly. */
function parseResponseDecimal(field: string, value: unknown): Exact {
  const m = typeof value === 'string' ? RESPONSE_DECIMAL_RE.exec(value.trim()) : null;
  if (!m) throw badResponse(field, value);
  const frac = m[2] ?? '';
  const exp = m[3] === undefined ? 0 : Number(m[3]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > MAX_RESPONSE_EXPONENT) {
    throw badResponse(field, value);
  }
  const digits = BigInt(m[1] + frac);
  const scale = frac.length - exp;
  return scale >= 0 ? { digits, scale } : { digits: digits * 10n ** BigInt(-scale), scale: 0 };
}

/** Parses a non-negative integer (base units) from a 1Click response. */
function parseResponseInt(field: string, value: unknown): bigint {
  const m = typeof value === 'string' ? RESPONSE_INT_RE.exec(value.trim()) : null;
  if (!m) throw badResponse(field, value);
  return BigInt(m[1]!);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Scales an exact decimal to `scale` fixed digits, rounding as told. */
function toScaled(d: DecimalLike, scale: number, rounding: 'up' | 'down'): bigint {
  return scaleExact(parseExact(d), scale, rounding);
}

function scaleExact({ digits, scale: s }: Exact, scale: number, rounding: 'up' | 'down'): bigint {
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
  /**
   * USD taken from the merchant's proceeds for the network: a merchant-sponsored fee plus the
   * integrator hook estimate (spec §8.1). Default 0. It never changes what the shopper sends.
   */
  merchantDeductionUsd?: DecimalLike;
  recipient: string;
  recipientType: QuoteRequest['recipientType'];
  refundTo: string;
  refundType: QuoteRequest['refundType'];
  feeAccount: string;
  /** The quote deadline is min(now + QUOTE_TTL_MS, this). */
  sessionExpiresAt: Date;
  /** Injected for tests; defaults to the current time. */
  now?: Date;
  /** Defaults to `CHECKOUT_SLIPPAGE_BPS` (default DEFAULT_SLIPPAGE_BPS = 100). */
  slippageBps?: number;
}

export interface QuoteRequests {
  /** Dry EXACT_INPUT probe of one whole origin token; its amountInUsd / amountIn is the price. */
  dry: QuoteRequest;
  /** The real (deposit-allocating) request, sized from the dry result where needed. */
  real: (dryResult: QuoteResponse) => QuoteRequest;
  /**
   * USD the shopper's send should be worth (the order total), a 6-decimal string. For
   * merchant-pays quotes, pass it to `assertWithinTarget` after the real quote.
   */
  targetUsd: string;
  /**
   * Basis points added to Tendr's `appFees` to collect `merchantDeductionUsd` from the merchant's
   * proceeds (0 without a deduction). Recorded as `gas_reimbursement` revenue.
   */
  networkFeeBps: number;
}

function tooSmall(message: string, details?: unknown): AppError {
  return new AppError('QUOTE_TOO_SMALL', message, 400, details);
}

/**
 * Builds the two-step quote.
 *
 * - Shopper pays fees: EXACT_OUTPUT for the order total in settlement base units. Tendr's appFee
 *   and 1Click's costs make the shopper's amountIn grow.
 * - Merchant pays fees: EXACT_INPUT sized from the dry price so the shopper's amountInUsd equals
 *   the order total; all fees and spread come out of the merchant's amount_out.
 *
 * A merchant deduction (sponsored network fee + hook estimate, spec §8.1) lowers the merchant's
 * amount_out and never the shopper's send: it is collected as extra `appFees` basis points
 * (`networkFeeBps`). EXACT_INPUT keeps the shopper's amount and adds the bps; EXACT_OUTPUT asks for
 * the order minus the deduction and adds bps sized so the shopper's amountIn matches the
 * unsponsored quote (1Click charges `appFees` on the output: in = out × (1 + bps / 10 000)).
 * Basis points round UP (Tendr collects at least the deduction); the shopper's amountIn matches
 * the unsponsored quote within `assertWithinTarget`'s tolerance.
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

  // Order total in micro-USD. Rounds UP: the shopper owes the full order.
  const orderMicro = toScaled(input.orderAmount, USD_SCALE, 'up');
  // The deduction in micro-USD. Rounds UP: it is charged to the merchant.
  const deductMicro = toScaled(input.merchantDeductionUsd ?? '0', USD_SCALE, 'up');
  if (deductMicro >= orderMicro) {
    throw tooSmall('The network fee covers the whole order', {
      order_usd: microToNumber(orderMicro),
      network_fee_usd: microToNumber(deductMicro),
    });
  }
  const tendr = BigInt(input.feeBps) + 10_000n;
  let networkBps = 0n;
  if (deductMicro > 0n) {
    if (input.feePayer === 'shopper') {
      // Output O − D at (f + g) bps costs the same as O at f bps: g = D × (1e4 + f) / (O − D).
      networkBps = ceilDiv(deductMicro * tendr, orderMicro - deductMicro);
    } else {
      // Input I at (f + g) bps yields D less than at f bps:
      // g = D × (1e4 + f)² / (I × 1e4 − D × (1e4 + f)).
      const den = orderMicro * 10_000n - deductMicro * tendr;
      if (den <= 0n) throw tooSmall('The network fee covers the whole order');
      networkBps = ceilDiv(deductMicro * tendr * tendr, den);
    }
  }
  const totalBps = BigInt(input.feeBps) + networkBps;
  if (totalBps >= 10_000n) {
    throw tooSmall('The network fee is too large for this order', {
      order_usd: microToNumber(orderMicro),
      network_fee_usd: microToNumber(deductMicro),
    });
  }
  const networkFeeBps = Number(networkBps);
  const appFees: AppFee[] | undefined =
    totalBps > 0n ? [{ recipient: input.feeAccount, fee: Number(totalBps) }] : undefined;

  const base = {
    slippageTolerance: input.slippageBps ?? env().CHECKOUT_SLIPPAGE_BPS,
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
  const targetUsd = microToDecimal(orderMicro);

  if (input.feePayer === 'shopper') {
    // Order in settlement base units (rounds UP, via toBaseUnits) minus the deduction in
    // settlement base units (rounds UP: the merchant receives at least D less).
    const deductBase = toScaled(microToDecimal(deductMicro), input.settlementDecimals, 'up');
    const amount = toBaseUnits(input.orderAmount, input.settlementDecimals) - deductBase;
    if (amount <= 0n) throw tooSmall('The network fee covers the whole order');
    const real: QuoteRequest = {
      dry: false,
      swapType: 'EXACT_OUTPUT',
      ...base,
      amount: amount.toString(),
    };
    return { dry, real: () => real, targetUsd, networkFeeBps };
  }

  return {
    dry,
    targetUsd,
    networkFeeBps,
    real: (dryResult) => {
      const dryIn = parseResponseInt('amountIn', dryResult.quote.amountIn);
      const dryUsd = parseResponseDecimal('amountInUsd', dryResult.quote.amountInUsd);
      if (dryIn <= 0n || dryUsd.digits <= 0n) {
        throw new OneClickError('Dry quote has no usable price', null, 'BAD_RESPONSE', {
          amountIn: dryResult.quote.amountIn,
          amountInUsd: dryResult.quote.amountInUsd,
        });
      }
      // amountIn = ceil(dryIn × target / dryUsd), with target = orderMicro / 10^6 and
      // dryUsd = digits / 10^scale, computed exactly. Rounds UP: the shopper's send must be worth
      // at least the target.
      const num = dryIn * orderMicro * 10n ** BigInt(dryUsd.scale);
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
  const inMicro = scaleExact(
    parseResponseDecimal('amountInUsd', quote.quote.amountInUsd),
    USD_SCALE,
    'down',
  );
  const outMicro = scaleExact(
    parseResponseDecimal('amountOutUsd', quote.quote.amountOutUsd),
    USD_SCALE,
    'down',
  );
  if (inMicro < minMicro || outMicro < minMicro) {
    throw tooSmall(`Payments under $${minUsd.toFixed(2)} are not supported`, {
      min_usd: minUsd,
      amount_in_usd: quote.quote.amountInUsd,
      amount_out_usd: quote.quote.amountOutUsd,
    });
  }
}

/** Default tolerance for `assertWithinTarget`, in basis points of the target. */
export const DEFAULT_TARGET_TOLERANCE_BPS = 50;

/**
 * Post-check for the merchant-pays (EXACT_INPUT) real quote: its `amountInUsd` must be within
 * `toleranceBps` of `targetUsd` (the `targetUsd` returned by `buildQuoteRequests`), in either
 * direction. The price can move between the dry and the real quote; past the tolerance the
 * shopper would be over- or under-charged, so the caller requotes. Compared exactly.
 * Throws QUOTE_PRICE_MOVED (409).
 */
export function assertWithinTarget(
  realResult: QuoteResponse,
  targetUsd: DecimalLike,
  toleranceBps: number = DEFAULT_TARGET_TOLERANCE_BPS,
): void {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0) {
    throw new RangeError(`toleranceBps must be a non-negative integer, got ${toleranceBps}`);
  }
  const target = parseExact(targetUsd);
  const actual = parseResponseDecimal('amountInUsd', realResult.quote.amountInUsd);
  // Bring both to a common scale: value × 10^(sa + st).
  const t = target.digits * 10n ** BigInt(actual.scale);
  const a = actual.digits * 10n ** BigInt(target.scale);
  const diff = a > t ? a - t : t - a;
  if (diff * 10_000n > t * BigInt(toleranceBps)) {
    throw new AppError('QUOTE_PRICE_MOVED', 'The price moved; request a new quote', 409, {
      target_usd: toPlainString(targetUsd),
      amount_in_usd: realResult.quote.amountInUsd,
      tolerance_bps: toleranceBps,
    });
  }
}
