import { describe, expect, it } from 'vitest';
import { chainFamily, isValidAddress } from './address-format.js';

describe('address format', () => {
  it('maps 1Click blockchains to families', () => {
    expect(chainFamily('eth')).toBe('evm');
    expect(chainFamily('base')).toBe('evm');
    expect(chainFamily('sol')).toBe('solana');
    expect(chainFamily('tron')).toBe('tron');
    expect(chainFamily('near')).toBe('near');
    expect(chainFamily('btc')).toBe('bitcoin');
    expect(chainFamily('doge')).toBe('other');
  });

  it.each([
    ['eth', '0x1111111111111111111111111111111111111111', true],
    ['eth', '0x111111111111111111111111111111111111111', false],
    ['eth', 'alice.near', false],
    ['sol', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', true],
    ['sol', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', false],
    ['tron', 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', true],
    ['tron', 'XLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', false],
    ['near', 'alice.near', true],
    ['near', 'shop-1_a.testnet', true],
    ['near', 'a'.repeat(64).replace(/a/g, 'f'), true],
    ['near', 'Alice.near', false],
    ['near', 'alice..near', false],
    ['near', '-alice.near', false],
    ['btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', true],
    ['btc', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', true],
    ['btc', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', true],
    ['btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdQ', false],
    ['btc', '0x1111111111111111111111111111111111111111', false],
    ['doge', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', true],
    ['doge', 'has space in it', false],
  ])('%s %s → %s', (chain, address, ok) => {
    expect(isValidAddress(chain, address)).toBe(ok);
  });
});
