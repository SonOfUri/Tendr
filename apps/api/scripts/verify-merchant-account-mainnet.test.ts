import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { UsageError } from './lib/near-script.js';
import {
  CONFIRM_FLAG,
  compressedPublicKey,
  omftLabel,
  parseVerifyArgs,
  probeProviderRetries,
  readPoaPrefixes,
  signedApproval,
} from './verify-merchant-account-mainnet.js';

const KEY = (() => {
  const seed = new Uint8Array(32).fill(9);
  return `ed25519:${bs58.encode(Buffer.concat([seed, ed25519.getPublicKey(seed)]))}`;
})();
const EVM = '0x1111111111111111111111111111111111111111';
const ENV = { VERIFY_FUNDER_ACCOUNT_ID: 'me.near', VERIFY_FUNDER_PRIVATE_KEY: KEY };
const OK = [`--${CONFIRM_FLAG}`, '--evm-address', EVM];

describe('onchain:verify:mainnet argument parsing', () => {
  it('refuses without the exact confirmation flag and says what it would spend', () => {
    for (const argv of [[], ['--evm-address', EVM], ['--yes-i-understand'], ['--yes']]) {
      expect(() => parseVerifyArgs(argv, ENV)).toThrow(UsageError);
    }
    expect(() => parseVerifyArgs(['--evm-address', EVM], ENV)).toThrow(
      /--yes-i-understand-this-spends-mainnet-funds[\s\S]*MAINNET funds/,
    );
  });

  it('refuses a missing or malformed EVM address, a missing funder, a testnet funder or RPC', () => {
    expect(() => parseVerifyArgs([`--${CONFIRM_FLAG}`], ENV)).toThrow(/evm-address/);
    expect(() => parseVerifyArgs([`--${CONFIRM_FLAG}`, '--evm-address', '0x12'], ENV)).toThrow(
      /evm-address/,
    );
    expect(() => parseVerifyArgs(OK, {})).toThrow(/VERIFY_FUNDER_ACCOUNT_ID/);
    expect(() => parseVerifyArgs(OK, { ...ENV, VERIFY_FUNDER_ACCOUNT_ID: 'me.testnet' })).toThrow(
      /testnet/,
    );
    expect(() =>
      parseVerifyArgs(OK, { ...ENV, NEAR_RPC_URL_LIVE: 'https://rpc.testnet.near.org' }),
    ).toThrow(/looks like testnet/);
  });

  it('refuses unknown flags, a bad phase, a bad amount and non-nep141 assets', () => {
    expect(() => parseVerifyArgs([...OK, '--force'], ENV)).toThrow(/unknown argument/);
    expect(() => parseVerifyArgs([...OK, '--phase', 'both'], ENV)).toThrow(/--phase/);
    expect(() => parseVerifyArgs([...OK, '--amount', '0'], ENV)).toThrow(/--amount/);
    expect(() => parseVerifyArgs([...OK, '--origin-asset', 'eth'], ENV)).toThrow(/nep141/);
  });

  it('accepts a confirmed run with defaults (about $1 of NEAR USDC to eth USDC)', () => {
    const a = parseVerifyArgs(OK, ENV);
    expect(a.phase).toBe('prepare');
    expect(a.amount).toBe('1000000');
    expect(a.originAsset).toContain(
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    );
    expect(a.destAsset).toBe('nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near');
    expect(a.rpcUrl).toBe('https://rpc.mainnet.near.org');
    expect(a.cleanup).toBe(false);
    const f = parseVerifyArgs([...OK, '--phase=finish', '--cleanup'], ENV);
    expect(f.phase).toBe('finish');
    expect(f.cleanup).toBe(true);
  });
});

describe('verify script helpers', () => {
  it('reads the PoA prefix table from money.rs and labels omft accounts', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const rust = readFileSync(
      resolve(here, '../../../onchain/merchant-account/src/money.rs'),
      'utf8',
    );
    const prefixes = readPoaPrefixes(rust);
    expect(prefixes).toEqual(expect.arrayContaining(['eth', 'base', 'arb', 'sol', 'btc']));
    expect(prefixes).toHaveLength(10);
    expect(omftLabel('eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near')).toBe('eth');
    expect(omftLabel('btc.omft.near')).toBe('btc');
    expect(omftLabel('sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near')).toBe('sol');
    expect(omftLabel('usdc.near')).toBeNull();
  });

  it('signs a passkey approval the contract rules accept', () => {
    const priv = p256.utils.randomPrivateKey();
    const challenge = sha256('payload');
    const a = signedApproval(priv, 'per_verify', challenge);
    const authData = Buffer.from(a.assertion.authenticator_data, 'base64');
    expect(authData.subarray(0, 32)).toEqual(Buffer.from(sha256('localhost')));
    expect(authData[32]! & 0x05).toBe(0x05);
    const cd = JSON.parse(a.assertion.client_data_json) as {
      challenge: string;
      type: string;
      origin: string;
    };
    expect(cd).toMatchObject({ type: 'webauthn.get', origin: 'http://localhost:3000' });
    expect(cd.challenge).toBe(Buffer.from(challenge).toString('base64url'));
    const digest = sha256(Buffer.concat([authData, sha256(a.assertion.client_data_json)]));
    const sig = Buffer.from(a.assertion.signature, 'base64');
    expect(sig).toHaveLength(64);
    const parsed = p256.Signature.fromCompact(sig.toString('hex'));
    expect(parsed.hasHighS()).toBe(false);
    expect(p256.verify(sig, digest, compressedPublicKey(priv))).toBe(true);
    expect(a.key).toEqual({ p256: Buffer.from(compressedPublicKey(priv)).toString('base64') });
  });

  it('observes that the @near-js provider retries a failing send_tx by itself', async () => {
    const r = await probeProviderRetries(2);
    expect(r).toEqual({ requests: 3, resolved: true, method: 'send_tx' });
  }, 20_000);
});
