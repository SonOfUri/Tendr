import { QUOTE_TTL_MS } from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { SimulatedOneClick } from './oneclick/simulated.js';
import type { SimStore } from './oneclick/sim-store.js';
import { OneClickError, type QuoteResponse } from './oneclick/types.js';
import * as pricing from './pricing.js';
import {
  assertOutputWithinTarget,
  assertWithinMinimum,
  assertWithinTarget,
  buildQuoteRequests,
  DEFAULT_SLIPPAGE_BPS,
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

describe('the old gas discount', () => {
  it('no longer exists: pricing has no gas reimbursement', () => {
    expect('gasReimbursementUsd' in pricing).toBe(false);
    expect('gasReimbursementMicroUsd' in pricing).toBe(false);
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

  it('shopper pays fees, sponsored: dry = the unsponsored EXACT_OUTPUT, real = exactly its amountIn', () => {
    const { dry, real, networkFeeBps } = buildQuoteRequests(
      input({ merchantDeductionUsd: '0.80' }),
    );
    // The dry quote is the unsponsored order: Tendr's fee only.
    expect(dry).toMatchObject({ dry: true, swapType: 'EXACT_OUTPUT', amount: '25000000' });
    expect(dry.appFees).toEqual([{ recipient: 'fees.tendr.testnet', fee: 50 }]);
    // ceil(0.80 × (10000 + 50) / 24.20) = ceil(332.23…) = 333
    expect(networkFeeBps).toBe(333);
    const req = real(quote('10060000000000000', '25.15'));
    expect(req).toMatchObject({ dry: false, swapType: 'EXACT_INPUT', amount: '10060000000000000' });
    expect(req.appFees).toEqual([{ recipient: 'fees.tendr.testnet', fee: 50 + 333 }]);
    expect(() => real(quote('0', '1'))).toThrow(OneClickError);
  });

  it('shopper pays fees, sponsored: sizes the send from the dry minAmountIn when present', () => {
    const { real, expectedOutUsd } = buildQuoteRequests(input({ merchantDeductionUsd: '0.80' }));
    const dry = quote('10160600000000000', '25.40');
    dry.quote.minAmountIn = '10060000000000000';
    expect(real(dry).amount).toBe('10060000000000000');
    // The merchant should receive the order minus the deduction.
    expect(expectedOutUsd).toBe('24.200000');
    // Unsponsored and merchant-pays quotes have no output target.
    expect(buildQuoteRequests(input()).expectedOutUsd).toBeNull();
    expect(
      buildQuoteRequests(input({ feePayer: 'merchant', merchantDeductionUsd: '0.80' }))
        .expectedOutUsd,
    ).toBeNull();
  });

  it('the input-charged model sizes the bps on the input', () => {
    // shopper: ceil(0.80 × (10000 − 50) / 25) = 319; merchant: ceil(0.80 × 10000 / 25) = 320
    expect(buildQuoteRequests(input({ merchantDeductionUsd: '0.80' }), 'input').networkFeeBps).toBe(
      319,
    );
    expect(
      buildQuoteRequests(input({ feePayer: 'merchant', merchantDeductionUsd: '0.80' }), 'input')
        .networkFeeBps,
    ).toBe(320);
  });

  it('merchant pays fees, sponsored: same send, the deduction is collected by appFees', () => {
    const { real, targetUsd, networkFeeBps } = buildQuoteRequests(
      input({ feePayer: 'merchant', merchantDeductionUsd: '0.10' }),
    );
    expect(targetUsd).toBe('25.000000');
    // ceil(0.10 × 10050² / (25 × 10000 − 0.10 × 10050)) = ceil(40.56…) = 41
    expect(networkFeeBps).toBe(41);
    const req = real(quote('1000000000000000000', '2513.27'));
    expect(req.amount).toBe('9947200261014535'); // unchanged versus unsponsored
    expect(req.appFees).toEqual([{ recipient: 'fees.tendr.testnet', fee: 91 }]);
  });

  it('no deduction adds no basis points', () => {
    expect(buildQuoteRequests(input()).networkFeeBps).toBe(0);
    expect(buildQuoteRequests(input({ merchantDeductionUsd: '0' })).networkFeeBps).toBe(0);
    // Sponsored with no Tendr fee: appFees carries only the deduction.
    // ceil(0.25 × 10000 / 24.75) = ceil(101.01…) = 102
    const { dry, real } = buildQuoteRequests(input({ feeBps: 0, merchantDeductionUsd: '0.25' }));
    expect(dry.appFees).toBeUndefined();
    expect(real(quote('1', '1')).appFees).toEqual([{ recipient: 'fees.tendr.testnet', fee: 102 }]);
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

  it('T3: an untrusted provider value is truncated to 200 chars in BAD_RESPONSE details', () => {
    const { real } = buildQuoteRequests(input({ feePayer: 'merchant' }));
    const huge = 'x'.repeat(10_000);
    let caught: unknown;
    try {
      real(quote('1000', huge));
    } catch (err) {
      caught = err;
    }
    const details = (caught as OneClickError).details as { value: string };
    expect(details.value.length).toBeLessThanOrEqual(200);
    expect(details.value.startsWith('xxx')).toBe(true);
  });

  it('merchant pays: rounds the sized amountIn up', () => {
    const { real } = buildQuoteRequests(input({ feePayer: 'merchant', orderAmount: '1' }));
    // 3 base units cost $2, so $1 needs 1.5 units.
    const req = real(quote('3', '2'));
    expect(req.amount).toBe('2'); // 1.5 → 2
  });

  it('a deduction that eats the whole order (or the fee headroom) is QUOTE_TOO_SMALL', () => {
    for (const feePayer of ['merchant', 'shopper'] as const) {
      for (const merchantDeductionUsd of ['1.50', '1.00', '0.999']) {
        expectCode(
          () => buildQuoteRequests(input({ feePayer, orderAmount: '1.00', merchantDeductionUsd })),
          'QUOTE_TOO_SMALL',
        );
      }
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

describe('assertOutputWithinTarget', () => {
  it('passes at or above the expected output less the tolerance', () => {
    expect(() => assertOutputWithinTarget(quote('1', '25', '24.20'), '24.2')).not.toThrow();
    expect(() => assertOutputWithinTarget(quote('1', '25', '30'), '24.2')).not.toThrow();
    // −50 bps of 24.20 = 24.079
    expect(() => assertOutputWithinTarget(quote('1', '25', '24.079'), '24.2')).not.toThrow();
  });

  it('throws QUOTE_PRICE_MOVED below it', () => {
    expectCode(
      () => assertOutputWithinTarget(quote('1', '25', '24.078'), '24.2'),
      'QUOTE_PRICE_MOVED',
    );
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

describe('sponsored quotes against the 1Click simulator', () => {
  // A store that keeps nothing: these tests read only the quote amounts.
  const store = { create: async () => true } as unknown as SimStore;
  const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';

  it('EXACT_OUTPUT with a slippage buffer: the sponsored send is the effective cost, never more', async () => {
    const sim = new SimulatedOneClick({ store, exactOutputSlippageBuffer: true });
    const inp = (over: Partial<PricingInput>) =>
      input({ originAsset: USDC_BASE, originDecimals: 6, orderAmount: '1000.00', ...over });
    // The unsponsored shopper sends amountIn and gets the excess over minAmountIn back.
    const plainReqs = buildQuoteRequests(inp({}));
    const plain = (await sim.quote(plainReqs.real(await sim.quote(plainReqs.dry)))).quote;
    expect(BigInt(plain.minAmountIn!)).toBeLessThan(BigInt(plain.amountIn));
    const reqs = buildQuoteRequests(inp({ merchantDeductionUsd: '0.048' }));
    const sponsored = await sim.quote(reqs.real(await sim.quote(reqs.dry)));
    expect(BigInt(sponsored.quote.amountIn)).toBeLessThanOrEqual(BigInt(plain.minAmountIn!));
    expect(sponsored.quote.amountIn).toBe(plain.minAmountIn);
    // And the merchant still gets the order minus about the fee.
    expect(() => assertOutputWithinTarget(sponsored, reqs.expectedOutUsd!)).not.toThrow();
  });

  for (const appFeeBase of ['output', 'input'] as const) {
    const sim = new SimulatedOneClick({ store, appFeeBase });

    async function priced(over: Partial<PricingInput>) {
      const reqs = buildQuoteRequests(
        input({
          originAsset: USDC_BASE,
          originDecimals: 6,
          recipient: 'shop.tendr.testnet',
          ...over,
        }),
        appFeeBase,
      );
      const res = await sim.quote(reqs.real(await sim.quote(reqs.dry)));
      if (over.feePayer === 'merchant') assertWithinTarget(res, reqs.targetUsd);
      if (reqs.expectedOutUsd) assertOutputWithinTarget(res, reqs.expectedOutUsd);
      return res.quote;
    }

    for (const feePayer of ['merchant', 'shopper'] as const) {
      for (const [order, fee] of [
        ['25.00', '0.048'],
        ['7.50', '0.075'],
        ['1000.00', '0.048'],
        ['1234.56', '1'],
      ] as const) {
        it(`${appFeeBase}-charged appFees, ${feePayer} pays Tendr's fee, $${order} order, $${fee} sponsored: the exact same send, merchant gets about the fee less`, async () => {
          const plain = await priced({ feePayer, orderAmount: order });
          const sponsored = await priced({
            feePayer,
            orderAmount: order,
            merchantDeductionUsd: fee,
          });
          // The shopper sends exactly what they would without sponsorship, to the base unit.
          expect(sponsored.amountIn).toBe(plain.amountIn);
          // The merchant's output is lower by at least about the fee, and by at most the fee plus
          // 1 bps of the order (whole-bps rounding) plus 1Click's own fee on it.
          const less = Number(plain.amountOutUsd) - Number(sponsored.amountOutUsd);
          expect(less).toBeGreaterThan(Number(fee) * 0.98);
          expect(less).toBeLessThanOrEqual(Number(fee) * 1.01 + Number(order) * 0.0001 + 0.000002);
        });
      }
    }
  }
});
