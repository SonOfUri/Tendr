import { TIDEPOOL_TOKENS } from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import { adapterFor, payTargetFor, type DepositRequest } from './index';
import { assertDepositMatches } from './match';
import { parseBaseUnits, toHexQuantity } from './amount';
import { WalletError } from './errors';

describe('adapterFor / payTargetFor: which wallet family pays a 1Click asset', () => {
  it.each([
    // EVM: native coin and ERC-20 on each chain (the contract comes from the asset id).
    ['nep141:eth.omft.near', 'eth', 'evm', 'native', undefined, 1],
    ['nep141:base.omft.near', 'base', 'evm', 'native', undefined, 8453],
    ['nep141:arb.omft.near', 'arb', 'evm', 'native', undefined, 42161],
    ['nep141:gnosis.omft.near', 'gnosis', 'evm', 'native', undefined, 100],
    [
      'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
      'eth',
      'evm',
      'token',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      1,
    ],
    [
      'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      'base',
      'evm',
      'token',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      8453,
    ],
    // Solana: SOL and the SPL tokens whose mint is known.
    ['nep141:sol.omft.near', 'sol', 'solana', 'native', undefined, undefined],
    [
      'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
      'sol',
      'solana',
      'token',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      undefined,
    ],
    [
      'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
      'sol',
      'solana',
      'token',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      undefined,
    ],
    // Bitcoin: native only.
    ['nep141:btc.omft.near', 'btc', 'bitcoin', 'native', undefined, undefined],
    // Tron: TRX and USDT (TRC-20).
    ['nep141:tron.omft.near', 'tron', 'tron', 'native', undefined, undefined],
    [
      'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
      'tron',
      'tron',
      'token',
      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      undefined,
    ],
    // NEAR: NEP-141 tokens (wNEAR included).
    ['nep141:wrap.near', 'near', 'near', 'token', 'wrap.near', undefined],
    ['nep141:usdt.tether-token.near', 'near', 'near', 'token', 'usdt.tether-token.near', undefined],
    [
      'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      'near',
      'near',
      'token',
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      undefined,
    ],
  ])('%s on %s → %s %s', (assetId, blockchain, family, kind, contract, chainId) => {
    const target = payTargetFor(assetId);
    expect(target).not.toBeNull();
    expect(target!.family).toBe(family);
    expect(target!.kind).toBe(kind);
    expect(target!.contract).toBe(contract);
    expect(target!.chainId).toBe(chainId);
    const route = adapterFor(assetId, blockchain);
    expect(route?.chainFamily).toBe(family);
    expect(typeof route?.load).toBe('function');
  });

  it.each([
    // HOT-bridged assets: the contract is not readable from the id → manual send only.
    'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
    // SPL / TRC-20 tokens whose mint is not in the verified table.
    'nep141:sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near',
    'nep141:tron-0000000000000000000000000000000000000000.omft.near',
    // Chains with no wallet support here.
    'nep141:zec.omft.near',
    'nep141:doge.omft.near',
    // omdep-bridged tokens.
    'nep141:sol-0x936420c6ae310eb29511d139991654f922456fbe.omdep.near',
    // Not a 1Click id at all.
    'eth',
    '',
    'nep141:',
    'nep141:UPPER.near',
  ])('%s has no wallet route (manual send only)', (assetId) => {
    expect(payTargetFor(assetId)).toBeNull();
    expect(adapterFor(assetId)).toBeNull();
  });

  it("refuses a route when the token's network disagrees with the asset id", () => {
    expect(adapterFor('nep141:eth.omft.near', 'base')).toBeNull();
    expect(adapterFor('nep141:wrap.near', 'eth')).toBeNull();
    expect(adapterFor('nep141:sol.omft.near', 'solana')?.chainFamily).toBe('solana');
  });
});

describe('base units are exact BigInt (never floats)', () => {
  it('parses a 1Click base-unit string exactly', () => {
    expect(parseBaseUnits('1')).toBe(1n);
    expect(parseBaseUnits('1000000000000000000000001')).toBe(1000000000000000000000001n);
    // Beyond Number.MAX_SAFE_INTEGER: a float would have lost the last digits.
    expect(parseBaseUnits('9007199254740993')).toBe(9007199254740993n);
    expect(parseBaseUnits('123456789012345678901234567890').toString()).toBe(
      '123456789012345678901234567890',
    );
  });

  it.each(['', '0', '00', '1.5', '1e18', '-1', '+1', ' 1', '1 ', '0x10', 'abc', '١٢'])(
    'rejects %j',
    (raw) => {
      expect(() => parseBaseUnits(raw)).toThrow(WalletError);
    },
  );

  it('encodes a hex quantity exactly', () => {
    expect(toHexQuantity(0n)).toBe('0x0');
    expect(toHexQuantity(255n)).toBe('0xff');
    expect(toHexQuantity(10n ** 18n)).toBe('0xde0b6b3a7640000');
    expect(toHexQuantity(123456789012345678901234567890n)).toBe('0x18ee90ff6c373e0ee4e3f0ad2');
  });
});

describe('assertDepositMatches: only ever the locked quote', () => {
  const target = payTargetFor('nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near')!;
  const ok: DepositRequest = {
    depositAddress: '0x2222222222222222222222222222222222222222',
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    amount: '84000000',
    decimals: 6,
  };

  it('returns the exact amount for a matching request', () => {
    expect(assertDepositMatches(target, ok)).toBe(84000000n);
  });

  it('refuses a different asset, a bad amount or a malformed deposit address', () => {
    expect(() => assertDepositMatches(target, { ...ok, assetId: 'nep141:eth.omft.near' })).toThrow(
      WalletError,
    );
    expect(() => assertDepositMatches(target, { ...ok, amount: '84.5' })).toThrow(WalletError);
    expect(() =>
      assertDepositMatches(target, { ...ok, depositAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }),
    ).toThrow(WalletError);
    expect(() => assertDepositMatches(target, { ...ok, decimals: -1 })).toThrow(WalletError);
  });
});

describe('Tidepool payment networks', () => {
  it.each(Object.values(TIDEPOOL_TOKENS))(
    'pins $blockchain $symbol to its test network and token',
    (token) => {
      const target = payTargetFor(token.assetId);
      expect(target).toMatchObject({
        network: 'testnet',
        contract: token.contract,
        decimals: 6,
        blockchain: token.blockchain,
      });
      if (token.blockchain === 'base') expect(target?.chainId).toBe(84532);
      expect(adapterFor(token.assetId, token.blockchain)).not.toBeNull();
      expect(adapterFor(token.assetId, 'eth')).toBeNull();
    },
  );
  it('never routes an unlisted testnet token through a mainnet NEAR wallet', () => {
    expect(payTargetFor('nep141:unknown.tp-omft.testnet')).toBeNull();
    expect(payTargetFor('nep141:wrap.testnet')).toBeNull();
  });
});
