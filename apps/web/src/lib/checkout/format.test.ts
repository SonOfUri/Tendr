import { describe, expect, it } from 'vitest';
import {
  explorerTxUrl,
  formatCountdown,
  formatOrderAmount,
  formatUnits,
  formatUsd,
  networkName,
  safeHttpUrl,
} from './format';

describe('formatUnits (no floats)', () => {
  it('formats base units with the token decimals', () => {
    expect(formatUnits('28410000000000000', 18)).toBe('0.02841');
    expect(formatUnits('25000000', 6)).toBe('25');
    expect(formatUnits('1', 18)).toBe('0.000000000000000001');
    expect(formatUnits(123456789012345678901234567890n, 18)).toBe('123456789012.34567890123456789');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('5', 0)).toBe('5');
  });

  it('refuses garbage instead of guessing', () => {
    expect(formatUnits('1.5', 6)).toBeNull();
    expect(formatUnits('-1', 6)).toBeNull();
    expect(formatUnits('abc', 6)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('rounds a decimal string to cents, up (never understates)', () => {
    expect(formatUsd('25')).toBe('$25.00');
    expect(formatUsd('0.311')).toBe('$0.32');
    expect(formatUsd('1234567.5')).toBe('$1,234,567.50');
    expect(formatUsd('0.004')).toBe('$0.01');
    expect(formatUsd('nope')).toBeNull();
  });
});

describe('formatOrderAmount', () => {
  it('USD orders show dollars; others show the token symbol', () => {
    expect(formatOrderAmount('84', 'USD', null)).toBe('$84.00');
    expect(formatOrderAmount('84.5', 'nep141:usdc.test', 'USDC')).toBe('84.5 USDC');
    expect(formatOrderAmount('84.5', 'nep141:usdc.test', null)).toBe('84.5');
  });
});

describe('formatCountdown', () => {
  it('shows m:ss and stops at zero', () => {
    expect(formatCountdown(12 * 60_000)).toBe('12:00');
    expect(formatCountdown(61_500)).toBe('1:01');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('networks', () => {
  it('has plain names and explorer links', () => {
    expect(networkName('arb')).toBe('Arbitrum');
    expect(networkName('sol')).toBe('Solana');
    expect(networkName('zzz')).toBe('ZZZ');
    expect(explorerTxUrl('eth', '0xabc')).toBe('https://etherscan.io/tx/0xabc');
    expect(explorerTxUrl('unknown', '0xabc')).toBeNull();
    expect(explorerTxUrl('eth', 'a/b')).toBeNull();
  });
});

describe('safeHttpUrl', () => {
  it('keeps http(s) links only', () => {
    expect(safeHttpUrl('https://shop.example/thanks')).toBe('https://shop.example/thanks');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,x')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
