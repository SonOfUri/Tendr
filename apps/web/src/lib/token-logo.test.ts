import { describe, expect, it } from 'vitest';
import { dextoolsLogoUrl, dextoolsTarget, nearFtAccount, nearTokenIcon, publicImageUrl } from './token-logo';

describe('dextoolsTarget', () => {
  it('reads an EVM contract out of an omft asset id', () => {
    expect(
      dextoolsTarget('nep141:eth-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48.omft.near'),
    ).toEqual({
      chain: 'ether',
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
  });

  it('reads a bridged Ethereum contract from the NEAR factory id', () => {
    expect(
      dextoolsTarget('nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near'),
    ).toEqual({
      chain: 'ether',
      address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
  });

  it('uses the NEAR account for a native token', () => {
    expect(dextoolsTarget('nep141:token.0xshitzu.near')).toEqual({
      chain: 'near',
      address: 'token.0xshitzu.near',
    });
  });

  it('skips a Solana omft id, which is a digest rather than a mint', () => {
    expect(
      dextoolsTarget('nep141:sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near'),
    ).toBeNull();
  });

  it('reads a NEAR account, including ones that do not end in .near', () => {
    expect(nearFtAccount('nep141:token.0xshitzu.near')).toBe('token.0xshitzu.near');
    expect(nearFtAccount('nep141:token.sweat')).toBe('token.sweat');
    expect(
      nearFtAccount('nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'),
    ).toBe('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
    expect(
      nearFtAccount('nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'),
    ).toBeNull();
  });

  it('keeps an on-chain icon and corrects a mislabeled webp', () => {
    expect(nearTokenIcon('data:image/svg+xml,%3Csvg%3E%3C/svg%3E')).toBe(
      'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
    );
    expect(nearTokenIcon('data:image/png;base64,UklGRpwAAA==')).toBe(
      'data:image/webp;base64,UklGRpwAAA==',
    );
    expect(nearTokenIcon('https://evil.example/logo.png')).toBeNull();
    expect(publicImageUrl('https://image.mitte.gg/token-images/abc')).toBe(
      'https://image.mitte.gg/token-images/abc',
    );
    expect(publicImageUrl('https://127.0.0.1/logo.png')).toBeNull();
    expect(publicImageUrl('http://image.mitte.gg/logo.png')).toBeNull();
  });

  it('skips chains Dextools is not queried for', () => {
    expect(
      dextoolsTarget('nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near'),
    ).toBeNull();
  });
});

describe('dextoolsLogoUrl', () => {
  it('keeps a Dextools logo and drops every other host', () => {
    expect(
      dextoolsLogoUrl(
        'https://www.dextools.io/resources/tokens/logos/ether/0xa0.png?1',
      ),
    ).toBe('https://www.dextools.io/resources/tokens/logos/ether/0xa0.png?1');
    expect(dextoolsLogoUrl('https://evil.example/logo.png')).toBeNull();
    expect(dextoolsLogoUrl('http://www.dextools.io/resources/tokens/logos/a.png')).toBeNull();
  });
});
