import { describe, expect, it } from 'vitest';
import {
  InvoiceItemsInputSchema,
  InvoiceUsdItemsInputSchema,
  INVOICE_USD_DECIMALS,
  invoiceBreakdown,
} from './invoices.js';

describe('invoice breakdown amounts', () => {
  const item = (amount: string) => ({ description: 'Services', amount });
  it('sums USD line items in cents and rejects fractions of a cent', () => {
    expect(
      invoiceBreakdown(
        InvoiceUsdItemsInputSchema.parse([item('125.00'), item('25.50')]),
        INVOICE_USD_DECIMALS,
      ),
    ).toEqual({ items: [item('12500'), item('2550')], amount: '15050' });
    expect(InvoiceUsdItemsInputSchema.safeParse([item('1.001')]).success).toBe(false);
  });
  it('adds decimal token amounts exactly, including values beyond Number precision', () => {
    expect(invoiceBreakdown([item('0.1'), item('0.2')], 6)).toEqual({
      items: [item('100000'), item('200000')],
      amount: '300000',
    });
    expect(invoiceBreakdown([item('9007199254740993.000001'), item('0.000001')], 6).amount).toBe(
      '9007199254740993000002',
    );
  });
  it('rejects invalid amounts, excess precision and overflowing totals without rounding', () => {
    for (const amount of ['0', '-1', '1e3', 'NaN', '1.0000001', '', '01', '1,000'])
      expect(() => invoiceBreakdown([item(amount)], 6)).toThrow();
    expect(() => invoiceBreakdown([item('1.1')], 0)).toThrow();
    expect(() =>
      invoiceBreakdown([item('340282366920938463463374607431768211455'), item('1')], 0),
    ).toThrow('total');
  });
  it('requires 1–50 described items and rejects client-supplied totals in each item', () => {
    for (const input of [
      [],
      Array.from({ length: 51 }, () => item('1')),
      [{ ...item('1'), description: ' ' }],
      [{ ...item('1'), total: '1' }],
    ])
      expect(InvoiceItemsInputSchema.safeParse(input).success).toBe(false);
    expect(() => invoiceBreakdown([], 6)).toThrow();
    expect(
      InvoiceItemsInputSchema.parse([{ description: ' Design ', amount: '1' }])[0]?.description,
    ).toBe('Design');
  });
});
