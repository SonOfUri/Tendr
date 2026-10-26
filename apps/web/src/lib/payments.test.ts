import { describe, expect, it } from 'vitest';
import { explorerTxUrl, feeLines, formatUsd, type FeeLine } from './payments';

const USDC_TEST = 'nep141:usdc.fakes.testnet';

describe('formatUsd (no floats)', () => {
  it('rounds half up to cents with string arithmetic', () => {
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd('0.125')).toBe('$0.13');
    expect(formatUsd('0.124999')).toBe('$0.12');
    expect(formatUsd('12.5')).toBe('$12.50');
    expect(formatUsd('1234567.995')).toBe('$1,234,568.00');
    // Beyond what a float can hold exactly.
    expect(formatUsd('90071992547409931.01')).toBe('$90,071,992,547,409,931.01');
  });

  it('shows tiny non-zero values as under a cent, and passes junk through', () => {
    expect(formatUsd('0.004')).toBe('< $0.01');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd('1e5')).toBe('1e5');
  });
});

describe('feeLines', () => {
  const line = (o: Partial<FeeLine>): FeeLine => ({
    kind: 'tendr_fee',
    asset: USDC_TEST,
    amount: '125000',
    amount_usd: '0.125',
    estimated: false,
    ...o,
  });

  it('labels each fee, formats registered amounts by decimals and marks estimates', () => {
    const out = feeLines(
      [
        line({}),
        line({ kind: 'oneclick_fee', amount: '1000000', amount_usd: '1' }),
        line({ kind: 'network_fee', amount: '500000', amount_usd: '0.5', estimated: true }),
        line({ kind: 'gas_reimbursement', amount: '10000', amount_usd: '0.01', estimated: true }),
      ],
      false,
    );
    expect(out).toEqual([
      { label: 'Tendr fee', amount: '0.125 USDC', usd: '$0.13', estimated: false },
      { label: '1Click fee and spread', amount: '1 USDC', usd: '$1.00', estimated: false },
      {
        label: 'Network fee (estimated)',
        amount: '0.5 USDC',
        usd: '$0.50',
        estimated: true,
      },
      {
        label: 'Gas reimbursement (estimated)',
        amount: '0.01 USDC',
        usd: '$0.01',
        estimated: true,
      },
    ]);
  });

  it('an unregistered asset stays in raw base units with its full id', () => {
    const [l] = feeLines(
      [line({ asset: 'nep141:x.near', amount: '123456789012345678901234567890' })],
      false,
    );
    expect(l!.amount).toBe('123456789012345678901234567890 smallest units of nep141:x.near');
    expect(l!.usd).toBe('$0.13');
  });

  it('an unknown USD value shows a dash', () => {
    expect(feeLines([line({ amount_usd: null })], false)[0]!.usd).toBe('—');
  });
});

describe('explorerTxUrl', () => {
  it('links NEAR and EVM transactions per mode; unknown chains get no link', () => {
    expect(explorerTxUrl('near', 'abc', true)).toBe('https://nearblocks.io/txns/abc');
    expect(explorerTxUrl('near', 'abc', false)).toBe('https://testnet.nearblocks.io/txns/abc');
    expect(explorerTxUrl('eth', '0x1', true)).toBe('https://etherscan.io/tx/0x1');
    expect(explorerTxUrl('mystery', '0x1', true)).toBeNull();
    expect(explorerTxUrl(null, '0x1', true)).toBeNull();
  });
});
