import { describe, expect, it } from 'vitest';
import { canonicalIntentsChain, oneclickChainId } from './intents-catalog.js';

describe('intents catalog chains', () => {
  it('maps legacy contract names onto 1Click ids', () => {
    expect(oneclickChainId('arbitrum')).toBe('arb');
    expect(oneclickChainId('Arb')).toBe('arb');
    expect(oneclickChainId('doge')).toBe('doge');
  });

  it('accepts every known Intents chain and stores the contract name where one exists', async () => {
    expect(await canonicalIntentsChain(false, 'doge')).toBe('doge');
    expect(await canonicalIntentsChain(false, 'cardano')).toBe('cardano');
    expect(await canonicalIntentsChain(false, 'arb')).toBe('arbitrum');
    expect(await canonicalIntentsChain(false, 'arbitrum')).toBe('arbitrum');
    expect(await canonicalIntentsChain(false, 'near')).toBe('near');
  });

  it('rejects a chain 1Click does not list', async () => {
    expect(await canonicalIntentsChain(false, 'dogecoin')).toBeNull();
    expect(await canonicalIntentsChain(false, 'moon')).toBeNull();
    expect(await canonicalIntentsChain(false, 'ETH')).toBe('eth');
  });
});
