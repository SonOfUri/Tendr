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
    // appFees are charged on the output (ONECLICK_APP_FEE_BASE): 41 bps × 24.70 USDC.
    expect(l.gas_reimbursement!.amount.toFixed()).toBe('101270');
    expect(l.gas_reimbursement!.amountUsd!.toFixed()).toBe('0.10127');
    expect(l.app_fee!.amountUsd!.toFixed()).toBe('0.1235');
    // 25 − 24.70 − 0.1235 − 0.10127
    expect(l.oneclick_fee!.amountUsd!.toFixed()).toBe('0.07523');
    expect(l.network_fee).toBeUndefined();
  });

  it('input-charged appFees take their bps of amount_in', () => {
    const l = bySource(
      revenueLines(
        { ...base, amountOutUsd: new D('24.70'), networkFeeBps: 41, networkFeePaidBy: 'merchant' },
        'input',
      ),
    );
    expect(l.gas_reimbursement!.amount.toFixed()).toBe('102500'); // 41 bps × 25 USDC
    expect(l.app_fee!.amount.toFixed()).toBe('125000');
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

  it('a row without USD values still records the app fee (on amount_in)', () => {
    const l = bySource(revenueLines({ ...base, amountInUsd: null, amountOutUsd: null }));
    expect(l.app_fee!.amount.toFixed()).toBe('125000'); // 50 bps × 25 USDC
    expect(l.app_fee!.amountUsd).toBeNull();
  });
});
