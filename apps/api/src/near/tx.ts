// NEAR transaction building and KMS signing.
//
// A NEAR transaction is signed over sha256(borsh(Transaction)); the key vault signs that digest
// with the named Ed25519 key, so no private key ever leaves the vault (KMS in production).
//
// `UseGlobalContract` (NEP-591, https://github.com/near/NEPs/blob/master/neps/nep-0591.md) is
// supported natively by @near-js/transactions >= 2.x: Action variant 10 with
// `GlobalContractIdentifier::CodeHash` (variant 0, 32 bytes) — the same layout near-primitives
// produces in the Rust sandbox test (onchain/merchant-account/tests/sandbox.rs `provision`).
// tx.test.ts pins those bytes.
import { KeyType } from '@near-js/crypto';
import { PublicKey } from '@near-js/crypto';
import {
  Action,
  CreateAccount,
  FunctionCall,
  GlobalContractIdentifier,
  SCHEMA,
  Signature,
  SignedTransaction,
  Transaction,
  Transfer,
  UseGlobalContract,
  decodeSignedTransaction,
} from '@near-js/transactions';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';
import type { KeyVault } from '../keyvault/types.js';
import type { InitConfigJson } from './client.js';

export { SCHEMA };

/** Tendr's NEAR signing keys. `funding-near` only creates accounts; `relayer-accounts` only calls. */
export type NearSigningKey = 'funding-near' | 'relayer-accounts';

const TGAS = 1_000_000_000_000n;
/** Gas for a relayed contract call when the caller does not set one. */
export const DEFAULT_CALL_GAS = 100n * TGAS;
/** Gas for the `new` call that initialises a freshly provisioned merchant account. */
export const INIT_GAS = 100n * TGAS;

export function createAccountAction(): Action {
  return new Action({ createAccount: new CreateAccount() });
}

export function transferAction(deposit: bigint): Action {
  return new Action({ transfer: new Transfer({ deposit }) });
}

/** NEP-591: make the account run the global contract published under `codeHash`. */
export function useGlobalContractByHash(codeHash: Uint8Array): Action {
  if (codeHash.length !== 32) throw new Error('code hash must be 32 bytes');
  return new Action({
    useGlobalContract: new UseGlobalContract({
      contractIdentifier: new GlobalContractIdentifier({ CodeHash: codeHash }),
    }),
  });
}

/** A function call whose args are JSON-encoded. */
export function functionCallAction(
  methodName: string,
  args: object,
  gas: bigint,
  deposit: bigint,
): Action {
  return new Action({
    functionCall: new FunctionCall({
      methodName,
      args: new TextEncoder().encode(JSON.stringify(args)),
      gas,
      deposit,
    }),
  });
}

/**
 * The whole provisioning batch, in order: create the account, seed its balance, point it at the
 * global merchant-account code, and initialise it. There is deliberately no AddKey: a merchant
 * account has zero access keys from creation onward.
 */
export function provisionActions(p: {
  initialBalanceYocto: bigint;
  codeHash: Uint8Array;
  init: InitConfigJson;
}): Action[] {
  return [
    createAccountAction(),
    transferAction(p.initialBalanceYocto),
    useGlobalContractByHash(p.codeHash),
    functionCallAction('new', { config: p.init }, INIT_GAS, 0n),
  ];
}

export function buildTransaction(p: {
  signerId: string;
  /** 32-byte raw Ed25519 public key of the signing access key. */
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: Action[];
}): Transaction {
  return new Transaction({
    signerId: p.signerId,
    publicKey: new PublicKey({ keyType: KeyType.ED25519, data: p.publicKey }),
    nonce: p.nonce,
    receiverId: p.receiverId,
    blockHash: p.blockHash,
    actions: p.actions,
  });
}

export interface SignedTx {
  signed: SignedTransaction;
  /** borsh(SignedTransaction), ready for `send_tx`. */
  bytes: Uint8Array;
  /** sha256(borsh(Transaction)) — the transaction hash and the signed digest. */
  hashBytes: Uint8Array;
  /** base58 transaction hash, as explorers and RPC show it. */
  hash: string;
}

/** Signs `tx` with `key` in the vault: signature = Ed25519(sha256(borsh(tx))). */
export async function signTransaction(
  kv: KeyVault,
  key: NearSigningKey,
  tx: Transaction,
): Promise<SignedTx> {
  const hashBytes = sha256(tx.encode());
  const sig = await kv.sign(key, hashBytes);
  if (sig.curve !== 'ed25519') throw new Error(`${key} is not an ed25519 key`);
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({ keyType: KeyType.ED25519, data: sig.signature }),
  });
  return { signed, bytes: signed.encode(), hashBytes, hash: bs58.encode(hashBytes) };
}

/** A borsh-decoded action: its variant name and fields (byte arrays as Uint8Array). */
export interface DecodedAction {
  kind: string;
  fields: Record<string, unknown>;
}

export interface DecodedSignedTx {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: DecodedAction[];
  /** sha256(borsh(Transaction)): what the signature signs. */
  hashBytes: Uint8Array;
  signature: Uint8Array;
}

const bytesOf = (v: unknown): Uint8Array => Uint8Array.from(v as ArrayLike<number>);
const variant = (v: unknown): [string, unknown] =>
  Object.entries(v as object)[0] as [string, unknown];

/** Decodes `borsh(SignedTransaction)` into plain values (for checks and tests). */
export function decodeSigned(bytes: Uint8Array): DecodedSignedTx {
  const { transaction: t, signature } = decodeSignedTransaction(bytes) as unknown as {
    transaction: {
      signerId: string;
      publicKey: object;
      nonce: bigint;
      receiverId: string;
      blockHash: ArrayLike<number>;
      actions: object[];
    };
    signature: object;
  };
  const tx = new Transaction(t as unknown as ConstructorParameters<typeof Transaction>[0]);
  return {
    signerId: t.signerId,
    publicKey: bytesOf((variant(t.publicKey)[1] as { data: unknown }).data),
    nonce: BigInt(t.nonce),
    receiverId: t.receiverId,
    blockHash: bytesOf(t.blockHash),
    actions: t.actions.map((a) => {
      const [kind, fields] = variant(a);
      return { kind, fields: fields as Record<string, unknown> };
    }),
    hashBytes: sha256(tx.encode()),
    signature: bytesOf((variant(signature)[1] as { data: unknown }).data),
  };
}

/** A NEAR implicit account id: the lower-case hex of the Ed25519 public key. */
export function implicitAccountId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Expected a 32-byte ed25519 public key');
  return Buffer.from(publicKey).toString('hex');
}

/** Decodes a base58 NEAR CryptoHash (e.g. a global contract code hash). */
export function decodeHash(b58: string): Uint8Array {
  const raw = bs58.decode(b58);
  if (raw.length !== 32) throw new Error('Expected a base58 32-byte hash');
  return raw;
}
