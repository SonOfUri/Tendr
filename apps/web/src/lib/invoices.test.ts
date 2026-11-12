import { describe, expect, it } from 'vitest';
import { formatInvoiceAmount, formatInvoiceUsd } from './invoices';

describe('invoice amounts', () => {
  it('shows USD cents independently of the receiving token precision', () => {
    expect(
      formatInvoiceAmount({ amountCurrency: 'USD', amount: '10025', symbol: 'ETH', decimals: 18 }),
    ).toBe('$100.25');
    expect(formatInvoiceUsd('1')).toBe('$0.01');
    expect(formatInvoiceUsd('0')).toBe('$0.00');
    expect(formatInvoiceUsd('900719925474099301')).toBe('$9,007,199,254,740,993.01');
  });
  it('keeps historical token invoice amounts explicit', () => {
    expect(
      formatInvoiceAmount({
        amountCurrency: 'TOKEN',
        amount: '1230000',
        symbol: 'USDC',
        decimals: 6,
      }),
    ).toBe('1.23 USDC');
    expect(formatInvoiceAmount({ amount: '1230000', symbol: 'USDC', decimals: 6 })).toBe(
      '1.23 USDC',
    );
  });
});
