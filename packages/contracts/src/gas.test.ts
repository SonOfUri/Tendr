import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAS_POLICY,
  GAS_CHAINS,
  GasPolicySchema,
  GasUsageQuerySchema,
  usdToMicros,
} from './gas.js';

const valid = {
  enabled: true,
  per_payment_cap_usd: '1',
  monthly_budget_usd: '50',
  min_order_usd: '0',
  chains: ['base', 'sol'],
  tokens: [],
  first_time_only: false,
};

describe('GasPolicySchema', () => {
  it('accepts a valid policy', () => {
    expect(GasPolicySchema.parse(valid)).toEqual(valid);
  });

  it('accepts the defaults', () => {
    expect(GasPolicySchema.safeParse({ ...DEFAULT_GAS_POLICY, enabled: true }).success).toBe(true);
  });

  it('rejects negative amounts', () => {
    for (const field of ['per_payment_cap_usd', 'monthly_budget_usd', 'min_order_usd']) {
      expect(GasPolicySchema.safeParse({ ...valid, [field]: '-1' }).success, field).toBe(false);
    }
  });

  it('rejects numbers, exponents and more than 6 decimals', () => {
    for (const bad of [1, '1e3', '1.1234567', '', '.5', '1.', ' 1']) {
      expect(
        GasPolicySchema.safeParse({ ...valid, per_payment_cap_usd: bad }).success,
        `${bad}`,
      ).toBe(false);
    }
    expect(GasPolicySchema.safeParse({ ...valid, per_payment_cap_usd: '0.123456' }).success).toBe(
      true,
    );
  });

  it('rejects unknown chains', () => {
    expect(GasPolicySchema.safeParse({ ...valid, chains: ['base', 'doge'] }).success).toBe(false);
    expect(GasPolicySchema.safeParse({ ...valid, chains: ['btc'] }).success).toBe(false);
  });

  it('rejects a per-payment cap above the monthly budget', () => {
    const r = GasPolicySchema.safeParse({
      ...valid,
      per_payment_cap_usd: '50.000001',
      monthly_budget_usd: '50',
    });
    expect(r.success).toBe(false);
    expect(
      GasPolicySchema.safeParse({ ...valid, per_payment_cap_usd: '50', monthly_budget_usd: '50' })
        .success,
    ).toBe(true);
  });

  it('removes duplicate chains and tokens', () => {
    const p = GasPolicySchema.parse({
      ...valid,
      chains: ['base', 'base', 'sol'],
      tokens: ['nep141:usdc.near', 'nep141:usdc.near'],
    });
    expect(p.chains).toEqual(['base', 'sol']);
    expect(p.tokens).toEqual(['nep141:usdc.near']);
  });

  it('rejects unknown fields', () => {
    expect(GasPolicySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

describe('DEFAULT_GAS_POLICY', () => {
  it('is $1 per payment, $50 per month, no minimum order', () => {
    expect(DEFAULT_GAS_POLICY).toMatchObject({
      enabled: false,
      per_payment_cap_usd: '1',
      monthly_budget_usd: '50',
      min_order_usd: '0',
      tokens: [],
      first_time_only: false,
    });
  });

  it('covers every supported chain except Ethereum mainnet', () => {
    expect(DEFAULT_GAS_POLICY.chains).not.toContain('eth');
    expect(GAS_CHAINS).toContain('eth');
    expect([...DEFAULT_GAS_POLICY.chains].sort()).toEqual(
      GAS_CHAINS.filter((c) => c !== 'eth').sort(),
    );
    expect([...GAS_CHAINS].sort()).toEqual(
      [
        'eth',
        'base',
        'arb',
        'op',
        'pol',
        'bsc',
        'avax',
        'gnosis',
        'bera',
        'sol',
        'near',
        'tron',
      ].sort(),
    );
  });
});

describe('GasUsageQuerySchema', () => {
  it('accepts YYYY-MM and nothing else', () => {
    expect(GasUsageQuerySchema.parse({ month: '2026-10' })).toEqual({ month: '2026-10' });
    expect(GasUsageQuerySchema.parse({})).toEqual({});
    for (const bad of ['2026-13', '2026-1', '26-10', '2026-00', '2026-10-01']) {
      expect(GasUsageQuerySchema.safeParse({ month: bad }).success, bad).toBe(false);
    }
  });
});

describe('usdToMicros', () => {
  it('converts decimal strings to integer micro-dollars', () => {
    expect(usdToMicros('1')).toBe(1_000_000n);
    expect(usdToMicros('0.000001')).toBe(1n);
    expect(usdToMicros('12.5')).toBe(12_500_000n);
  });
});
