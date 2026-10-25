import { QUOTE_TTL_MS } from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { OneClickError, type QuoteResponse } from './oneclick/types.js';
import {
  assertWithinMinimum,
  assertWithinTarget,
  buildQuoteRequests,
  DEFAULT_GAS_MAX_USD,
  DEFAULT_SLIPPAGE_BPS,
  gasReimbursementUsd,
  quoteDeadline,
  resolvePayers,
  toBaseUnits,
  type PricingInput,
} from './pricing.js';

const USDC = 'nep141:usdc.test';
const ETH = 'nep141:eth.test';
const NOW = new Date('2026-10-25T12:00:00.000Z');
const EXPIRES = new Date(NOW.getTime() + 30 * 60_000);

function input(over: Partial<PricingInput> = {}): PricingInput {
  return {
    orderAmount: '25.00',
    amountCurrency: 'USD',
    settlementAsset: USDC,
    settlementDecimals: 6,
    originAsset: ETH,
    originDecimals: 18,
    feeBps: 50,
    feePayer: 'shopper',
    gasPayer: 'shopper',
    gasEstimateUsd: '0.80',
    gasMaxUsd: '2.00',
    recipient: 'shop.tendr.testnet',
    recipientType: 'INTENTS',
    refundTo: '0x1111111111111111111111111111111111111111',
    refundType: 'ORIGIN_CHAIN',
    feeAccount: 'fees.tendr.testnet',
    sessionExpiresAt: EXPIRES,
    now: NOW,
    ...over,
  };
}

function quote(amountIn: string, amountInUsd: string, amountOutUsd = amountInUsd): QuoteResponse {
  return {
    correlationId: 'c1',
    quote: { amountIn, amountInUsd, amountOut: '1', amountOutUsd },
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('resolvePayers', () => {
  const merchant = { defaultFeePayer: 'merchant', defaultGasPayer: 'shopper' } as const;

  it('uses the merchant default when nothing overrides it', () => {
    expect(resolvePayers({ sessionOverride: {}, link: null, merchant })).toEqual({
      feePayer: 'merchant',
      gasPayer: 'shopper',
    });
  });

  it('lets the payment link beat the merchant default', () => {
    expect(
      resolvePayers({ sessionOverride: {}, link: { gasPayer: 'merchant' }, merchant }),
    ).toEqual({ feePayer: 'merchant', gasPayer: 'merchant' });
  });

  it('lets the session override beat the link, per field', () => {
    expect(
      resolvePayers({
        sessionOverride: { feePayer: 'shopper', gasPayer: 'shopper' },
        link: { feePayer: 'merchant', gasPayer: 'merchant' },
        merchant,
      }),
    ).toEqual({ feePayer: 'shopper', gasPayer: 'shopper' });
    expect(
      resolvePayers({
        sessionOverride: { feePayer: 'shopper' },
        link: { gasPayer: 'merchant' },
        merchant,
      }),
    ).toEqual({ feePayer: 'shopper', gasPayer: 'merchant' });
  });

  it('treats null as "not set"', () => {
    expect(
      resolvePayers({
        sessionOverride: { feePayer: null, gasPayer: null },
        link: { feePayer: null, gasPayer: null },
        merchant,
      }),
    ).toEqual({ feePayer: 'merchant', gasPayer: 'shopper' });
  });
});

describe('toBaseUnits', () => {
  it('converts exactly and rounds sub-unit remainders up', () => {
    expect(toBaseUnits('25', 6)).toBe(25_000_000n);
    expect(toBaseUnits('25.123456', 6)).toBe(25_123_456n);
    expect(toBaseUnits('0.0000001', 6)).toBe(1n);
    expect(toBaseUnits('1.5', 0)).toBe(2n);
  });

  it('rejects malformed and negative values', () => {
    expect(() => toBaseUnits('-1', 6)).toThrow();
    expect(() => toBaseUnits('1e3', 6)).toThrow();
    expect(() => toBaseUnits('', 6)).toThrow();
  });
});

describe('gasReimbursementUsd', () => {
  it('is zero when the shopper pays gas', () => {
    expect(gasReimbursementUsd('shopper', '0.80', '2.00')).toBe(0);
  });

  it('is the estimate when under the cap', () => {
    expect(gasReimbursementUsd('merchant', '0.80', '2.00')).toBe(0.8);
  });

  it('is capped by gas_max_usd', () => {
    expect(gasReimbursementUsd('merchant', '5.25', '2.00')).toBe(2);
    expect(gasReimbursementUsd('merchant', '5.25', '0')).toBe(0);
  });

  it('falls back to the default cap when the session/link sets none', () => {
    expect(DEFAULT_GAS_MAX_USD).toBe(2);
    expect(gasReimbursementUsd('merchant', '3.10', null)).toBe(2);
    expect(gasReimbursementUsd('merchant', '1.10', null)).toBe(1.1);
    expect(gasReimbursementUsd('merchant', '3.10', null, '0.75')).toBe(0.75);
  });

  it('takes the default cap from CHECKOUT_GAS_MAX_USD', () => {
    const saved = env().CHECKOUT_GAS_MAX_USD;
    env().CHECKOUT_GAS_MAX_USD = '1.25';
    try {
      expect(gasReimbursementUsd('merchant', '3.10', null)).toBe(1.25);
    } finally {
      env().CHECKOUT_GAS_MAX_USD = saved;
    }
  });
});

describe('quoteDeadline', () => {
  it('is now + QUOTE_TTL_MS when the session lives longer', () => {
    expect(quoteDeadline(NOW, EXPIRES)).toBe(new Date(NOW.getTime() + QUOTE_TTL_MS).toISOString());
  });

  it('is never later than the session expiry', () => {
    const soon = new Date(NOW.getTime() + 5 * 60_000);
    expect(quoteDeadline(NOW, soon)).toBe(soon.toISOString());
  });

  it('refuses an already-expired session', () => {
    expectCode(() => quoteDeadline(NOW, NOW), 'EXPIRED');
  });
});

describe('buildQuoteRequests', () => {
  it('builds a dry EXACT_INPUT probe of one whole origin token', () => {
    const { dry } = buildQuoteRequests(input());
    expect(dry).toMatchObject({
      dry: true,
      swapType: 'EXACT_INPUT',
      originAsset: ETH,
      destinationAsset: USDC,
      amount: '1000000000000000000',
      depositType: 'ORIGIN_CHAIN',
    });
  });

  it('shopper pays: EXACT_OUTPUT for the exact order total with appFees', () => {
    const { dry, real } = buildQuoteRequests(input());
    const req = real(quote('1', '1'));
    expect(req).toEqual({
      dry: false,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100,
      originAsset: ETH,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: USDC,
      amount: '25000000',
      refundTo: '0x1111111111111111111111111111111111111111',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'shop.tendr.testnet',
      recipientType: 'INTENTS',
      deadline: new Date(NOW.getTime() + QUOTE_TTL_MS).toISOString(),
      appFees: [{ recipient: 'fees.tendr.testnet', fee: 50 }],
    });
    expect(dry.deadline).toBe(req.deadline);
  });

  it('shopper pays, order priced in the settlement asset: uses the amount directly', () => {
    const { real } = buildQuoteRequests(
      input({ amountCurrency: USDC, orderAmount: '12.345678', settlementDecimals: 6 }),
    );
    expect(real(quote('1', '1')).amount).toBe('12345678');
  });

  it('shopper pays fees, merchant pays gas: the output shrinks by the reimbursement', () => {
    const { real } = buildQuoteRequests(input({ gasPayer: 'merchant', gasEstimateUsd: '0.80' }));
    expect(real(quote('1', '1')).amount).toBe('24200000');
  });

  it('uses DEFAULT_SLIPPAGE_BPS, CHECKOUT_SLIPPAGE_BPS, or an explicit slippageBps', () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(100);
    expect(buildQuoteRequests(input()).dry.slippageTolerance).toBe(100);
    const saved = env().CHECKOUT_SLIPPAGE_BPS;
    env().CHECKOUT_SLIPPAGE_BPS = 250;
    try {
      expect(buildQuoteRequests(input()).dry.slippageTolerance).toBe(250);
      expect(
        buildQuoteRequests(input({ slippageBps: 30 })).real(quote('1', '1')).slippageTolerance,
      ).toBe(30);
    } finally {
      env().CHECKOUT_SLIPPAGE_BPS = saved;
    }
  });

  it('omits appFees when feeBps is 0', () => {
    const { dry, real } = buildQuoteRequests(input({ feeBps: 0 }));
    expect(dry.appFees).toBeUndefined();
    expect(real(quote('1', '1')).appFees).toBeUndefined();
    const merchant = buildQuoteRequests(input({ feeBps: 0, feePayer: 'merchant' }));
    expect(merchant.real(quote('1000000000000000000', '2500.00')).appFees).toBeUndefined();
  });

  it('merchant pays: EXACT_INPUT sized so amountInUsd hits the order total within 0.1%', () => {
    const fixtures: Array<[string, string, string, number]> = [
      // [dry amountIn, dry amountInUsd, order USD, origin decimals]
      ['1000000000000000000', '2513.27', '25.00', 18],
      ['1000000000000000000', '0.0731', '99.99', 18],
      ['100000000', '67123.456789', '1234.56', 8],
      ['1000000', '0.999812', '7.50', 6],
    ];
    for (const [dryIn, dryUsd, order, decimals] of fixtures) {
      const { real } = buildQuoteRequests(
        input({ feePayer: 'merchant', orderAmount: order, originDecimals: decimals }),
      );
      const req = real(quote(dryIn, dryUsd));
      expect(req.swapType).toBe('EXACT_INPUT');
      expect(req.dry).toBe(false);
      expect(req.appFees).toEqual([{ recipient: 'fees.tendr.testnet', fee: 50 }]);
      // Price the sized amountIn at the dry rate (test-only float check of the bigint result).
      const usd = (Number(req.amount) * Number(dryUsd)) / Number(dryIn);
      expect(Math.abs(usd - Number(order)) / Number(order)).toBeLessThan(0.001);
      expect(usd).toBeGreaterThanOrEqual(Number(order) * 0.999999);
    }
  });

  it('merchant pays: sizes an exact amountIn', () => {
    const { real, targetUsd } = buildQuoteRequests(input({ feePayer: 'merchant' }));
    expect(targetUsd).toBe('25.000000');
    // ceil(1e18 × 25 / 2513.27)
    expect(real(quote('1000000000000000000', '2513.27')).amount).toBe('9947200261014535');
  });

  it('merchant pays: accepts exponent notation in the dry USD value, expanded exactly', () => {
    const { real } = buildQuoteRequests(input({ feePayer: 'merchant', orderAmount: '1' }));
    // 1 base unit = $1.5e-7 → $1 needs ceil(1 / 1.5e-7) = 6666667 base units.
    expect(real(quote('1', '1.5e-7')).amount).toBe('6666667');
    expect(real(quote('+10', '+1.5E-6')).amount).toBe('6666667');
    expect(real(quote('1', '2.5e1')).amount).toBe('1'); // $25 per unit → ceil(0.04)
  });

  it('merchant pays: unparseable dry values are OneClickError BAD_RESPONSE', () => {
    const { real } = buildQuoteRequests(input({ feePayer: 'merchant' }));
    const bad: Array<[string, string]> = [
      ['1000', '-1'],
      ['1000', 'abc'],
      ['1000', 'NaN'],
      ['1000', ''],
      ['1000', '1e999999'],
      ['-5', '2500'],
      ['1.5', '2500'],
      ['1e18', '2500'],
      ['abc', '2500'],
    ];
    for (const [amountIn, usd] of bad) {
      let caught: unknown;
      try {
        real(quote(amountIn, usd));
      } catch (err) {
        caught = err;
      }
      expect(caught, `${amountIn} / ${usd}`).toBeInstanceOf(OneClickError);
      expect((caught as OneClickError).code).toBe('BAD_RESPONSE');
    }
  });

  it('merchant pays fees and gas: targets order − reimbursement', () => {
    const { real } = buildQuoteRequests(
      input({ feePayer: 'merchant', gasPayer: 'merchant', gasEstimateUsd: '1.00' }),
    );
    // 1 token = $2.40 → $24.00 = 10 tokens exactly.
    const req = real(quote('1000000000000000000', '2.40'));
    expect(req.amount).toBe('10000000000000000000');
  });

  it('merchant pays: rounds the sized amountIn up', () => {
    const { real } = buildQuoteRequests(input({ feePayer: 'merchant', orderAmount: '1' }));
    // 3 base units cost $2, so $1 needs 1.5 units.
    const req = real(quote('3', '2'));
    expect(req.amount).toBe('2'); // 1.5 → 2
  });

  it('a reimbursement that eats the whole order is QUOTE_TOO_SMALL', () => {
    for (const feePayer of ['merchant', 'shopper'] as const) {
      expectCode(
        () =>
          buildQuoteRequests(
            input({
              feePayer,
              gasPayer: 'merchant',
              orderAmount: '1.00',
              gasEstimateUsd: '1.50',
              gasMaxUsd: null,
            }),
          ),
        'QUOTE_TOO_SMALL',
      );
    }
  });

  it('rejects a pricing currency other than USD or the settlement asset', () => {
    expectCode(() => buildQuoteRequests(input({ amountCurrency: 'EUR' })), 'VALIDATION_ERROR');
  });

  it('merchant pays: a dry quote without a usable price is rejected', () => {
    const { real } = buildQuoteRequests(input({ feePayer: 'merchant' }));
    expect(() => real(quote('1000000000000000000', '0'))).toThrow();
    expect(() => real(quote('0', '2500'))).toThrow();
  });

  it('deadline is never later than the session expiry', () => {
    const soon = new Date(NOW.getTime() + 3 * 60_000);
    const { dry, real } = buildQuoteRequests(input({ sessionExpiresAt: soon }));
    expect(dry.deadline).toBe(soon.toISOString());
    expect(new Date(real(quote('1', '1')).deadline).getTime()).toBeLessThanOrEqual(soon.getTime());
  });
});

describe('assertWithinTarget', () => {
  it('passes within the tolerance either side', () => {
    expect(() => assertWithinTarget(quote('1', '25.00'), '25')).not.toThrow();
    expect(() => assertWithinTarget(quote('1', '25.125'), '25')).not.toThrow(); // +50 bps
    expect(() => assertWithinTarget(quote('1', '24.875'), '25.000000')).not.toThrow(); // −50 bps
    expect(() => assertWithinTarget(quote('1', '2.5e1'), '25')).not.toThrow();
  });

  it('throws QUOTE_PRICE_MOVED past the tolerance', () => {
    expectCode(() => assertWithinTarget(quote('1', '25.126'), '25'), 'QUOTE_PRICE_MOVED');
    expectCode(() => assertWithinTarget(quote('1', '24.874'), '25'), 'QUOTE_PRICE_MOVED');
    expectCode(() => assertWithinTarget(quote('1', '25.01'), '25', 0), 'QUOTE_PRICE_MOVED');
    expect(() => assertWithinTarget(quote('1', '25.3'), '25', 200)).not.toThrow();
  });

  it('rejects an unparseable amountInUsd as BAD_RESPONSE', () => {
    expect(() => assertWithinTarget(quote('1', 'abc'), '25')).toThrow(OneClickError);
  });
});

describe('assertWithinMinimum', () => {
  it('passes a quote at or above the minimum', () => {
    expect(() => assertWithinMinimum(quote('1', '0.50'))).not.toThrow();
    expect(() => assertWithinMinimum(quote('1', '25.00', '24.80'))).not.toThrow();
  });

  it('throws QUOTE_TOO_SMALL for tiny orders', () => {
    expectCode(() => assertWithinMinimum(quote('1', '0.499999')), 'QUOTE_TOO_SMALL');
    expectCode(() => assertWithinMinimum(quote('1', '0.01')), 'QUOTE_TOO_SMALL');
  });

  it('throws when what the merchant receives is under the minimum', () => {
    expectCode(() => assertWithinMinimum(quote('1', '0.60', '0.40')), 'QUOTE_TOO_SMALL');
  });

  it('accepts exponent notation and rejects garbage as BAD_RESPONSE', () => {
    expectCode(() => assertWithinMinimum(quote('1', '1.5e-7')), 'QUOTE_TOO_SMALL');
    expect(() => assertWithinMinimum(quote('1', '5e0'))).not.toThrow();
    for (const v of ['-1', 'abc', 'NaN']) {
      expect(() => assertWithinMinimum(quote('1', v))).toThrow(OneClickError);
      expect(() => assertWithinMinimum(quote('1', '5', v))).toThrow(OneClickError);
    }
  });

  it('honours a custom minimum', () => {
    expectCode(() => assertWithinMinimum(quote('1', '4.99'), 5), 'QUOTE_TOO_SMALL');
    expect(() => assertWithinMinimum(quote('1', '5'), 5)).not.toThrow();
  });
});
