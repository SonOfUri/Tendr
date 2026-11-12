import { z } from 'zod';

export const MAX_INVOICE_ITEMS = 50;
export const INVOICE_USD_DECIMALS = 2;
export const InvoiceUsdAmountSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,38})(?:\.\d{1,2})?$/,
    'Enter a USD amount with at most two decimal places',
  );
export const InvoiceDecimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d{0,38})(?:\.\d{1,30})?$/);
export const InvoiceItemsInputSchema = z
  .array(
    z
      .object({
        description: z.string().trim().min(1).max(200),
        amount: InvoiceDecimalAmountSchema,
      })
      .strict(),
  )
  .min(1)
  .max(MAX_INVOICE_ITEMS);
export type InvoiceItem = { description: string; amount: string };
export const InvoiceUsdItemsInputSchema = z
  .array(
    z
      .object({
        description: z.string().trim().min(1).max(200),
        amount: InvoiceUsdAmountSchema,
      })
      .strict(),
  )
  .min(1)
  .max(MAX_INVOICE_ITEMS);

/** Decimal receiving-token units to integer units. Never round a contractor's amount. */
export function invoiceAmountUnits(value: string, decimals: number): string {
  if (!InvoiceDecimalAmountSchema.safeParse(value).success)
    throw new Error('Enter a positive decimal amount for each line item');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new Error('Invalid token precision');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  const units = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  if (units <= 0n || units >= 1n << 128n) throw new Error('Invoice amount is out of range');
  return units.toString();
}

/** Returns line amounts and their sum in integer units, all for the same receiving token. */
export function invoiceBreakdown(items: readonly InvoiceItem[], decimals: number) {
  if (items.length < 1 || items.length > MAX_INVOICE_ITEMS)
    throw new Error(`Add between 1 and ${MAX_INVOICE_ITEMS} line items`);
  const normalized = items.map((item) => ({
    description: item.description,
    amount: invoiceAmountUnits(item.amount, decimals),
  }));
  const total = normalized.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  if (total >= 1n << 128n) throw new Error('Invoice total is out of range');
  return { items: normalized, amount: total.toString() };
}
