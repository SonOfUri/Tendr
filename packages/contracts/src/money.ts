import { z } from 'zod';

/**
 * Decimal-safe money as a string (e.g. "49.99").
 * Do not use JavaScript number for financial amounts.
 */
export const MoneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/, 'Amount must be a decimal string with up to 8 fractional digits')
  .refine((v) => {
    const [whole] = v.split('.');
    return (whole?.length ?? 0) <= 18;
  }, 'Amount integer part too large');

export const CurrencyCodeSchema = z
  .string()
  .min(3)
  .max(10)
  .regex(/^[A-Z0-9_]+$/, 'Currency must be uppercase alphanumeric');

export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;
