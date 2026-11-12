import type { Invoice } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';

const units = z
  .string()
  .regex(/^[1-9]\d{0,38}$/)
  .refine((s) => BigInt(s) < 2n ** 128n);
const InvoicePricingSchema = z.object({
  amountCurrency: z.literal('USD'),
  amount: units,
  destinationAsset: z.string(),
  destinationAmount: units,
  priceUsd: z.string().max(128),
  quotedAt: z.string().datetime(),
});
export type InvoicePricing = z.infer<typeof InvoicePricingSchema>;

/** Convert immutable USD cents using a freshly fetched USD/token price. Round the token
 * output UP by at most one base unit; never assume a stablecoin is exactly one dollar.
 */
export function invoiceUsdTokenAmount(
  cents: string,
  priceUsd: string | undefined,
  decimals: number,
): string {
  const match =
    typeof priceUsd === 'string' && priceUsd.length <= 128
      ? /^\+?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(priceUsd)
      : null;
  const exponent = Number(match?.[3] ?? 0);
  const digits = match ? BigInt(match[1]! + (match[2] ?? '')) : 0n;
  if (
    !match ||
    digits <= 0n ||
    !Number.isInteger(exponent) ||
    Math.abs(exponent) > 100 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'A current USD price for the receiving token is unavailable. Please request a new quote shortly.',
      503,
    );
  }
  if (!units.safeParse(cents).success)
    throw new AppError('VALIDATION_ERROR', 'Invalid USD invoice total', 400);
  const scale = decimals + (match[2]?.length ?? 0) - exponent - 2;
  const numerator = BigInt(cents) * (scale >= 0 ? 10n ** BigInt(scale) : 1n);
  const denominator = digits * (scale < 0 ? 10n ** BigInt(-scale) : 1n);
  const result = ((numerator + denominator - 1n) / denominator).toString();
  if (!units.safeParse(result).success)
    throw new AppError(
      'VALIDATION_ERROR',
      'This invoice exceeds the receiving token amount limit',
      400,
    );
  return result;
}

/** Settlement compares the receipt with the token amount fixed in the approved quote,
 * never with cents, a new market price or a replacement quote.
 */
export function invoiceDeliveryTarget(
  invoice: Pick<Invoice, 'amountCurrency' | 'amount' | 'destinationAsset'>,
  quote: unknown,
): string | null {
  if (invoice.amountCurrency === 'TOKEN') return invoice.amount;
  const result = z
    .object({
      quote: z.object({ amountOut: units }),
      invoicePricing: InvoicePricingSchema,
    })
    .safeParse(quote);
  if (!result.success) return null;
  const { invoicePricing: pricing } = result.data;
  return pricing.amount === invoice.amount &&
    pricing.destinationAsset === invoice.destinationAsset &&
    pricing.destinationAmount === result.data.quote.amountOut
    ? pricing.destinationAmount
    : null;
}
