import type { Prisma } from '@prisma/client';

/**
 * Decimals cross the API boundary as strings so on-chain amounts (up to 78 digits)
 * never lose precision. `toFixed()` with no argument prints every digit and never
 * switches to exponent notation.
 */
export function toJsonDecimal(d: Prisma.Decimal | null): string | null {
  return d === null ? null : d.toFixed();
}
