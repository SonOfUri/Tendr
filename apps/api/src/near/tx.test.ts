import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { serialize } from 'borsh';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalKeyVault } from '../keyvault/local.js';
import {
  SCHEMA,
  buildTransaction,
  decodeSigned,
  implicitAccountId,
  provisionActions,
  signTransaction,
  useGlobalContractByHash,
} from './tx.js';

const dir = mkdtempSync(join(tmpdir(), 'tendr-near-tx-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kv = new LocalKeyVault(join(dir, 'kv.json'));

describe('UseGlobalContract (NEP-591) encoding', () => {
  it('matches the nearcore borsh layout: Action variant 10, GlobalContractIdentifier::CodeHash 0', () => {
    // near-primitives `Action` enum: CreateAccount=0, DeployContract=1, FunctionCall=2,
    // Transfer=3, Stake=4, AddKey=5, DeleteKey=6, DeleteAccount=7, Delegate=8,
    // DeployGlobalContract=9, UseGlobalContract=10. `UseGlobalContractAction` is
    // `{ contract_identifier: GlobalContractIdentifier }` and `GlobalContractIdentifier` is
    // `CodeHash(CryptoHash)=0 | AccountId(AccountId)=1`. So the action borsh-encodes to
    // [0x0a, 0x00, <32 hash bytes>] — exactly what the Rust sandbox `provision` sends.
    const hash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const bytes = serialize(SCHEMA.Action, useGlobalContractByHash(hash));
    expect(Array.from(bytes)).toEqual([10, 0, ...hash]);
  });
});

describe('signTransaction', () => {
  it('tx_signature_verifies_against_kv_public_key', async () => {
    const pk = (await kv.publicKey('funding-near')).raw;
    const tx = buildTransaction({
      signerId: 'tendr.testnet',
      publicKey: pk,
      nonce: 7n,
      receiverId: 'shop.tendr.testnet',
      blockHash: new Uint8Array(32).fill(9),
      actions: provisionActions({
        initialBalanceYocto: 10n ** 24n,
        codeHash: new Uint8Array(32).fill(3),
        init: {
          signers: [{ id: 'per_1', keys: [{ ed25519: Buffer.alloc(32, 1).toString('base64') }] }],
          threshold: 1,
          recovery_key: null,
          rp_id: 'localhost',
          origins: ['http://localhost:3000'],
          intents_contract: 'intents-mock.tendr.testnet',
          poa_suffix: null,
          testnet_admin: 'tendr.testnet',
        },
      }),
    });
    const signed = await signTransaction(kv, 'funding-near', tx);
    const digest = sha256(tx.encode());
    expect(signed.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(Buffer.from(signed.hashBytes)).toEqual(Buffer.from(digest));
    const decoded = decodeSigned(signed.bytes);
    expect(Buffer.from(decoded.hashBytes)).toEqual(Buffer.from(digest));
    expect(Buffer.from(decoded.publicKey)).toEqual(Buffer.from(pk));
    expect(ed25519.verify(decoded.signature, digest, pk)).toBe(true);
    // A different key's signature must not verify.
    const other = (await kv.publicKey('relayer-accounts')).raw;
    expect(ed25519.verify(decoded.signature, digest, other)).toBe(false);
  });
});

describe('implicitAccountId', () => {
  it('is the lower-case hex of the ed25519 public key', () => {
    expect(implicitAccountId(new Uint8Array(32).fill(0xab))).toBe('ab'.repeat(32));
  });
});
