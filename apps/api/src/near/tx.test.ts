import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { serialize } from 'borsh';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalKeyVault } from '../keyvault/local.js';
import {
  RELAYER_NEAR_MAX_STORAGE_DEPOSIT,
  SCHEMA,
  TGAS,
  buildTransaction,
  decodeSigned,
  decodeSignedDelegate,
  delegateAction,
  delegateActionHash,
  encodeSignedDelegateAction,
  functionCallAction,
  implicitAccountId,
  provisionActions,
  signTransaction,
  signedDelegateAction,
  transferAction,
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

describe('NEP-366 delegate actions', () => {
  const secret = ed25519.utils.randomPrivateKey();
  const pk = ed25519.getPublicKey(secret);
  const da = () =>
    delegateAction({
      senderId: 'alice.near',
      receiverId: 'usdt.tether-token.near',
      actions: [
        functionCallAction('ft_transfer', { receiver_id: 'bob.near', amount: '5' }, 15n * TGAS, 1n),
      ],
      nonce: 11n,
      maxBlockHeight: 1000n,
      publicKey: pk,
    });

  it('signs sha256(prefix 2^30 + 366 ‖ borsh(DelegateAction)) and round-trips', () => {
    const d = da();
    const hash = delegateActionHash(d);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(2 ** 30 + 366);
    expect(Buffer.from(hash)).toEqual(
      Buffer.from(sha256(Buffer.concat([prefix, serialize(SCHEMA.DelegateAction, d)]))),
    );
    const bytes = encodeSignedDelegateAction(d, ed25519.sign(hash, secret));
    const decoded = decodeSignedDelegate(bytes);
    expect(decoded.senderId).toBe('alice.near');
    expect(decoded.receiverId).toBe('usdt.tether-token.near');
    expect(decoded.nonce).toBe(11n);
    expect(decoded.maxBlockHeight).toBe(1000n);
    expect(Buffer.from(decoded.publicKey)).toEqual(Buffer.from(pk));
    expect(decoded.actions).toEqual([
      {
        kind: 'functionCall',
        methodName: 'ft_transfer',
        args: new TextEncoder().encode('{"receiver_id":"bob.near","amount":"5"}'),
        gas: 15n * TGAS,
        deposit: 1n,
      },
    ]);
    expect(ed25519.verify(decoded.signature, decoded.hash, pk)).toBe(true);
  });

  it('refuses non-canonical bytes (trailing or missing data)', () => {
    const d = da();
    const bytes = encodeSignedDelegateAction(d, ed25519.sign(delegateActionHash(d), secret));
    expect(() => decodeSignedDelegate(new Uint8Array([...bytes, 0]))).toThrow();
    expect(() => decodeSignedDelegate(bytes.subarray(0, bytes.length - 1))).toThrow();
  });
});

describe('relayer-near signing guard', () => {
  const build = async (receiverId: string, actions: ReturnType<typeof transferAction>[]) => {
    const { raw } = await kv.publicKey('relayer-near');
    return buildTransaction({
      signerId: implicitAccountId(raw),
      publicKey: raw,
      nonce: 1n,
      receiverId,
      blockHash: new Uint8Array(32).fill(1),
      actions,
    });
  };
  const storage = (account: string, registrationOnly: boolean, deposit: bigint) =>
    functionCallAction(
      'storage_deposit',
      { account_id: account, registration_only: registrationOnly },
      30n * TGAS,
      deposit,
    );

  it('signs a registration-only storage_deposit within the deposit cap', async () => {
    const tx = await build('usdt.tether-token.near', [
      storage('bob.near', true, 1_250_000_000_000_000_000_000n),
    ]);
    await expect(signTransaction(kv, 'relayer-near', tx)).resolves.toBeTruthy();
  });

  it('signs exactly one signed delegate whose sender is the receiver', async () => {
    const s = ed25519.utils.randomPrivateKey();
    const d = delegateAction({
      senderId: 'alice.near',
      receiverId: 'usdt.tether-token.near',
      actions: [
        functionCallAction('ft_transfer', { receiver_id: 'b.near', amount: '1' }, 15n * TGAS, 1n),
      ],
      nonce: 2n,
      maxBlockHeight: 10n,
      publicKey: ed25519.getPublicKey(s),
    });
    const sd = decodeSignedDelegate(
      encodeSignedDelegateAction(d, ed25519.sign(delegateActionHash(d), s)),
    );
    await expect(
      signTransaction(kv, 'relayer-near', await build('alice.near', [signedDelegateAction(sd)])),
    ).resolves.toBeTruthy();
    // The outer receiver must be the delegate's sender (NEP-366).
    await expect(
      signTransaction(kv, 'relayer-near', await build('mallory.near', [signedDelegateAction(sd)])),
    ).rejects.toThrow(/relayer-near/);
  });

  it('refuses anything else: transfers, other calls, unbounded deposits, batches', async () => {
    const bad = [
      await build('bob.near', [transferAction(1n)]),
      await build('usdt.tether-token.near', [
        functionCallAction('ft_transfer', { receiver_id: 'x.near', amount: '1' }, TGAS, 1n),
      ]),
      await build('usdt.tether-token.near', [storage('bob.near', false, 1n)]),
      // Registrations only on the gasless token contracts.
      await build('evil.near', [storage('bob.near', true, 1n)]),
      await build('usdt.tether-token.near', [
        storage('bob.near', true, RELAYER_NEAR_MAX_STORAGE_DEPOSIT + 1n),
      ]),
      await build('usdt.tether-token.near', [
        storage('bob.near', true, 1n),
        storage('eve.near', true, 1n),
      ]),
    ];
    for (const tx of bad) {
      await expect(signTransaction(kv, 'relayer-near', tx)).rejects.toThrow(/relayer-near/);
    }
  });

  it('other keys never sign a delegate', async () => {
    const s = ed25519.utils.randomPrivateKey();
    const d = delegateAction({
      senderId: 'alice.near',
      receiverId: 't.near',
      actions: [],
      nonce: 2n,
      maxBlockHeight: 10n,
      publicKey: ed25519.getPublicKey(s),
    });
    const sd = decodeSignedDelegate(
      encodeSignedDelegateAction(d, ed25519.sign(delegateActionHash(d), s)),
    );
    const tx = await build('alice.near', [signedDelegateAction(sd)]);
    await expect(signTransaction(kv, 'relayer-accounts', tx)).rejects.toThrow(/delegate/);
  });
});
