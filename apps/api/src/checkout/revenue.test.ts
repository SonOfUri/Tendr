import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { revenueLines } from './revenue.js';

const D = Prisma.Decimal;
const base = {
  originAsset: 'nep141:usdc.base',
  chain: 'base',
  amountIn: new D('25000000'), // 25 USDC
  amountInUsd: new D('25'),
  amountOutUsd: new D('24.80'),
  feeBps: 50,
  networkFeeBps: 0,
  networkFeeUsd: null,
  networkFeePaidBy: null,
} as const;

const bySource = (lines: ReturnType<typeof revenueLines>) =>
  Object.fromEntries(lines.map((l) => [l.source, l]));

describe('revenueLines', () => {
  it('a sponsored fee is the gas reimbursement its appFees bps collected, and no network_fee', () => {
    const l = bySource(
      revenueLines({
        ...base,
        amountOutUsd: new D('24.70'),
        networkFeeBps: 41,
        networkFeeUsd: new D('0.048'),
        networkFeePaidBy: 'merchant',
      }),
    );
    expect(l.gas_reimbursement!.amount.toFixed()).toBe('102500'); // 41 bps × 25 USDC
    expect(l.gas_reimbursement!.amountUsd!.toFixed()).toBe('0.1025');
    expect(l.app_fee!.amountUsd!.toFixed()).toBe('0.125');
    // 25 − 24.70 − 0.125 − 0.1025
    expect(l.oneclick_fee!.amountUsd!.toFixed()).toBe('0.0725');
    expect(l.network_fee).toBeUndefined();
  });

  it("the shopper's own fee is the quote's estimate; without one, the static table", () => {
    const shopper = bySource(
      revenueLines({ ...base, networkFeeUsd: new D('0.04'), networkFeePaidBy: 'buyer' }),
    );
    expect(shopper.network_fee!.amountUsd!.toFixed()).toBe('0.04');
    expect(shopper.gas_reimbursement).toBeUndefined();
    const legacy = bySource(revenueLines(base));
    expect(legacy.network_fee!.amountUsd!.toFixed()).toBe('0.5');
  });
});
