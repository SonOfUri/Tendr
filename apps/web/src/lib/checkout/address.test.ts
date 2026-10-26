import { describe, expect, it } from 'vitest';
import { isValidAddress } from './address';

describe('address format check (mirrors the API)', () => {
  it('EVM: 0x + 40 hex, mixed case must match EIP-55', () => {
    expect(isValidAddress('arb', '0x1111111111111111111111111111111111111111')).toBe(true);
    expect(isValidAddress('eth', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(true);
    expect(isValidAddress('eth', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false);
    expect(isValidAddress('base', '0x123')).toBe(false);
  });

  it('Solana, Tron, NEAR and Bitcoin', () => {
    expect(isValidAddress('sol', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true);
    expect(isValidAddress('sol', '0x1111111111111111111111111111111111111111')).toBe(false);
    expect(isValidAddress('tron', 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7')).toBe(true);
    expect(isValidAddress('near', 'alice.near')).toBe(true);
    expect(isValidAddress('near', 'Alice.near')).toBe(false);
    expect(isValidAddress('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(isValidAddress('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdQ')).toBe(false);
  });

  it('unknown networks: printable, no spaces, sane length', () => {
    expect(isValidAddress('xyz', 'abcdefgh')).toBe(true);
    expect(isValidAddress('xyz', 'abc def gh')).toBe(false);
  });
});
