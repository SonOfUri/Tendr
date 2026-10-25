import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { UsageError, parseFlags, parseNear, parseSecretKey } from './lib/near-script.js';
import { parsePublishArgs } from './onchain-publish-testnet.js';

const KEY = (() => {
  const seed = new Uint8Array(32).fill(7);
  const pub = ed25519.getPublicKey(seed);
  return `ed25519:${bs58.encode(Buffer.concat([seed, pub]))}`;
})();
const ENV = { NEAR_PUBLISH_PRIVATE_KEY: KEY };

describe('onchain:publish:testnet argument parsing', () => {
  it('refuses to run without --network testnet', () => {
    expect(() => parsePublishArgs([], ENV)).toThrow(UsageError);
    expect(() => parsePublishArgs([], ENV)).toThrow(/--network testnet/);
  });

  it.each(['mainnet', 'near', 'Testnet', 'testnet2'])('refuses --network %s', (n) => {
    expect(() => parsePublishArgs(['--network', n], ENV)).toThrow(UsageError);
  });

  it('refuses --network with no value', () => {
    expect(() => parsePublishArgs(['--network'], ENV)).toThrow(/needs a value/);
  });

  it('refuses a mainnet publisher account, a foreign mock account and a non-testnet RPC', () => {
    expect(() =>
      parsePublishArgs(['--network', 'testnet'], { ...ENV, NEAR_PUBLISH_ACCOUNT_ID: 'tendr.near' }),
    ).toThrow(/not a \.testnet account/);
    expect(() =>
      parsePublishArgs(['--network', 'testnet'], {
        ...ENV,
        MOCK_INTENTS_ACCOUNT_ID: 'mock.other.testnet',
      }),
    ).toThrow(/sub-account/);
    expect(() =>
      parsePublishArgs(['--network', 'testnet'], {
        ...ENV,
        NEAR_RPC_URL_TEST: 'https://rpc.mainnet.near.org',
      }),
    ).toThrow(/does not look like testnet/);
  });

  it('refuses without a key and rejects unknown flags', () => {
    expect(() => parsePublishArgs(['--network', 'testnet'], {})).toThrow(
      /NEAR_PUBLISH_PRIVATE_KEY/,
    );
    expect(() => parsePublishArgs(['--network', 'testnet', '--mainnet'], ENV)).toThrow(
      /unknown argument/,
    );
  });

  it('accepts an explicit testnet run (both flag spellings) with the defaults', () => {
    for (const argv of [
      ['--network', 'testnet'],
      ['--network=testnet', '--skip-build'],
    ]) {
      const a = parsePublishArgs(argv, ENV);
      expect(a.publisherId).toBe('tendr.testnet');
      expect(a.mockId).toBe('intents-mock.tendr.testnet');
      expect(a.rpcUrl).toBe('https://rpc.testnet.near.org');
      expect(a.skipBuild).toBe(argv.includes('--skip-build'));
    }
  });
});

describe('near-script helpers', () => {
  it('parses flags strictly', () => {
    expect(() => parseFlags(['--a'], { a: 'value' })).toThrow(/needs a value/);
    expect(() => parseFlags(['--a', '--b'], { a: 'value', b: 'bool' })).toThrow(/needs a value/);
    expect(() => parseFlags(['--b=1'], { b: 'bool' })).toThrow(/takes no value/);
    expect(() => parseFlags(['stray'], {})).toThrow(/unknown argument/);
  });

  it('parses secret keys and NEAR amounts', () => {
    expect(parseSecretKey(KEY).nearPublicKey).toMatch(/^ed25519:/);
    expect(() => parseSecretKey('secp256k1:abc')).toThrow(UsageError);
    expect(() => parseSecretKey('ed25519:0OIl')).toThrow(UsageError);
    expect(parseNear('1.5')).toBe(1_500_000_000_000_000_000_000_000n);
    expect(() => parseNear('x')).toThrow(UsageError);
  });
});
