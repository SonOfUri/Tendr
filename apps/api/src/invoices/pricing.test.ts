import { describe, expect, it } from 'vitest';
import { invoiceDeliveryTarget, invoiceUsdTokenAmount } from './pricing.js';

describe('USD invoice payout pricing', () => {
  it('converts cents into token units exactly, including non-dollar stablecoins and volatile tokens', () => {
    expect(invoiceUsdTokenAmount('10025', '1', 6)).toBe('100250000');
    expect(invoiceUsdTokenAmount('10000', '2000', 18)).toBe('50000000000000000');
    expect(invoiceUsdTokenAmount('100', '0.98', 6)).toBe('1020409');
    expect(invoiceUsdTokenAmount('1', '60000', 8)).toBe('17');
    expect(invoiceUsdTokenAmount('100', '1e-7', 8)).toBe('1000000000000000');
    expect(invoiceUsdTokenAmount('900719925474099301', '1', 2)).toBe('900719925474099301');
  });
  it.each([undefined, '', '0', '-1', 'NaN', 'Infinity', '1e99999999', '9'.repeat(129)])(
    'refuses unavailable or invalid token prices: %s',
    (price) => {
      expect(() => invoiceUsdTokenAmount('100', price, 6)).toThrow('current USD price');
    },
  );
  it('bounds token output and never rounds cents through floating point', () => {
    expect(() => invoiceUsdTokenAmount('0', '1', 6)).toThrow();
    expect(() => invoiceUsdTokenAmount('1.1', '1', 6)).toThrow();
    expect(() => invoiceUsdTokenAmount('100', '1e-100', 24)).toThrow('amount limit');
  });
  it('binds settlement to the original USD total and the token output in the approved quote', () => {
    const invoice = {
      amountCurrency: 'USD' as const,
      amount: '10000',
      destinationAsset: 'nep141:eth.omft.near',
    };
    const quote = {
      quote: { amountOut: '50000000000000000' },
      invoicePricing: {
        amountCurrency: 'USD',
        amount: invoice.amount,
        destinationAsset: invoice.destinationAsset,
        destinationAmount: '50000000000000000',
        priceUsd: '2000',
        quotedAt: new Date().toISOString(),
      },
    };
    expect(invoiceDeliveryTarget(invoice, quote)).toBe('50000000000000000');
    expect(invoiceDeliveryTarget(invoice, { quote: quote.quote })).toBeNull();
    expect(invoiceDeliveryTarget({ ...invoice, amount: '20000' }, quote)).toBeNull();
    expect(
      invoiceDeliveryTarget({ ...invoice, destinationAsset: 'nep141:other.near' }, quote),
    ).toBeNull();
    expect(invoiceDeliveryTarget(invoice, { ...quote, quote: { amountOut: '10' } })).toBeNull();
    expect(invoiceDeliveryTarget({ ...invoice, amountCurrency: 'TOKEN' }, {})).toBe('10000');
  });
});
