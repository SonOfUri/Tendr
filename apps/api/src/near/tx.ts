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
import { deserialize, serialize } from 'borsh';
import type { KeyVault } from '../keyvault/types.js';
import type { InitConfigJson } from './client.js';
import { NEAR_GASLESS_TOKENS } from './tokens.js';

export { SCHEMA };

/**
 * Tendr's NEAR signing keys. `funding-near` only creates accounts; `relayer-accounts` only calls;
 * `relayer-near` only relays shoppers' gasless payments (NEP-366 meta-transactions) and registers
 * accounts on token contracts (`assertRelayerNearTransaction`).
 */
export type NearSigningKey = 'funding-near' | 'relayer-accounts' | 'relayer-near';

export const TGAS = 1_000_000_000_000n;
/** Gas for a relayed contract call when the caller does not set one. */
export const DEFAULT_CALL_GAS = 100n * TGAS;
/**
 * Gas for relayed `propose` / `approve` / `cancel`: the maximum, since the approval that reaches
 * the threshold executes the proposal in the same call (transfers start promises with their own
 * gas, upgrades call `migrate`).
 */
export const RELAY_GAS = 300n * TGAS;
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

/**
 * Signs `tx` with `key` in the vault: signature = Ed25519(sha256(borsh(tx))). `relayer-near`
 * signs only the shapes `assertRelayerNearTransaction` allows, and only it relays delegates.
 */
export async function signTransaction(
  kv: KeyVault,
  key: NearSigningKey,
  tx: Transaction,
): Promise<SignedTx> {
  if (key === 'relayer-near') {
    assertRelayerNearTransaction(tx);
  } else if (tx.actions.some((a) => actionKind(a) === 'signedDelegate')) {
    throw new Error(`${key} never relays a delegate action`);
  }
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

// ---------------------------------------------------------------------------------------------
// NEP-366 meta-transactions (https://github.com/near/NEPs/blob/master/neps/nep-0366.md)
// ---------------------------------------------------------------------------------------------

/** The u32 prefix (2^30 + 366) before borsh(DelegateAction) in what a delegate signs. */
const DELEGATE_PREFIX = 2 ** 30 + 366;

/** A delegate action as borsh encodes it (plain values: no classes needed). */
export interface DelegateActionValue {
  senderId: string;
  receiverId: string;
  actions: Action[] | object[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: { ed25519Key: { data: Uint8Array | number[] } } | object;
}

/** A delegate action signed by an ed25519 key of `senderId`. */
export function delegateAction(p: {
  senderId: string;
  receiverId: string;
  actions: Action[];
  nonce: bigint;
  maxBlockHeight: bigint;
  /** 32-byte raw Ed25519 public key. */
  publicKey: Uint8Array;
}): DelegateActionValue {
  return {
    senderId: p.senderId,
    receiverId: p.receiverId,
    actions: p.actions,
    nonce: p.nonce,
    maxBlockHeight: p.maxBlockHeight,
    publicKey: { ed25519Key: { data: p.publicKey } },
  };
}

/** What the sender's key signs: sha256(u32le(2^30 + 366) ‖ borsh(DelegateAction)). */
export function delegateActionHash(da: DelegateActionValue): Uint8Array {
  const body = serialize(SCHEMA.DelegateAction, da);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, DELEGATE_PREFIX, true);
  out.set(body, 4);
  return sha256(out);
}

/** borsh(SignedDelegate) of `da` with an ed25519 signature (what a wallet hands back). */
export function encodeSignedDelegateAction(
  da: DelegateActionValue,
  signature: Uint8Array,
): Uint8Array {
  return serialize(SCHEMA.SignedDelegate, {
    delegateAction: da,
    signature: { ed25519Signature: { data: signature } },
  });
}

/** A decoded delegate action's function call (the only action kind gasless payments allow). */
export type DecodedDelegateAction =
  | {
      kind: 'functionCall';
      methodName: string;
      args: Uint8Array;
      gas: bigint;
      deposit: bigint;
    }
  | { kind: string };

export interface DecodedSignedDelegate {
  senderId: string;
  receiverId: string;
  actions: DecodedDelegateAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  /** 32-byte raw Ed25519 public key (only ed25519 keys are accepted). */
  publicKey: Uint8Array;
  signature: Uint8Array;
  /** What the signature signs (`delegateActionHash`). */
  hash: Uint8Array;
  /** The decoded borsh value, re-encodable as is (the outer transaction's action). */
  raw: { delegateAction: DelegateActionValue; signature: object };
}

/**
 * Decodes borsh(SignedDelegate). Throws unless the bytes are exactly one canonical encoding (no
 * trailing data) of a delegate signed by an ed25519 key.
 */
export function decodeSignedDelegate(bytes: Uint8Array): DecodedSignedDelegate {
  const raw = deserialize(SCHEMA.SignedDelegate, bytes) as {
    delegateAction: {
      senderId: string;
      receiverId: string;
      actions: object[];
      nonce: bigint | number;
      maxBlockHeight: bigint | number;
      publicKey: object;
    };
    signature: object;
  };
  const again = serialize(SCHEMA.SignedDelegate, raw);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) {
    throw new Error('not a canonical signed delegate');
  }
  const [keyKind, key] = variant(raw.delegateAction.publicKey);
  const [sigKind, sig] = variant(raw.signature);
  if (keyKind !== 'ed25519Key' || sigKind !== 'ed25519Signature') {
    throw new Error('only ed25519 delegate keys are accepted');
  }
  const da = raw.delegateAction as unknown as DelegateActionValue;
  return {
    senderId: raw.delegateAction.senderId,
    receiverId: raw.delegateAction.receiverId,
    actions: raw.delegateAction.actions.map((a) => {
      const [kind, f] = variant(a);
      if (kind !== 'functionCall') return { kind };
      const fc = f as { methodName: string; args: unknown; gas: unknown; deposit: unknown };
      return {
        kind,
        methodName: fc.methodName,
        args: bytesOf(fc.args),
        gas: BigInt(fc.gas as bigint),
        deposit: BigInt(fc.deposit as bigint),
      };
    }),
    nonce: BigInt(raw.delegateAction.nonce),
    maxBlockHeight: BigInt(raw.delegateAction.maxBlockHeight),
    publicKey: bytesOf((key as { data: unknown }).data),
    signature: bytesOf((sig as { data: unknown }).data),
    hash: delegateActionHash(da),
    raw: { delegateAction: da, signature: raw.signature },
  };
}

/** The outer transaction's single action: the signed delegate (NEP-366 `Delegate`). */
export function signedDelegateAction(sd: DecodedSignedDelegate): Action {
  return new Action({
    signedDelegate: sd.raw,
  } as unknown as ConstructorParameters<typeof Action>[0]);
}

function actionKind(a: Action | object): string {
  return (a as { enum?: string }).enum ?? Object.keys(a)[0] ?? '';
}

/**
 * The most `relayer-near` attaches to a `storage_deposit` registration (0.01 NEAR; NEP-141 tokens
 * ask 0.00125).
 */
export const RELAYER_NEAR_MAX_STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n;

/**
 * `relayer-near` signs exactly two shapes, each a single action: a NEP-366 signed delegate whose
 * sender is the transaction's receiver (the shopper's meta-transaction), or a `storage_deposit`
 * `{ account_id, registration_only: true }` on an allow-listed gasless token contract with at
 * most RELAYER_NEAR_MAX_STORAGE_DEPOSIT attached (registering a deposit or gas-fee account). Never a NEAR transfer, key
 * change or any other call: a stolen code path can only waste the relayer's working gas.
 */
export function assertRelayerNearTransaction(tx: Transaction): void {
  const refuse = (why: string): never => {
    throw new Error(`relayer-near refuses to sign: ${why}`);
  };
  if (tx.actions.length !== 1) refuse('exactly one action');
  const action = tx.actions[0]!;
  const kind = actionKind(action);
  if (kind === 'signedDelegate') {
    const sd = (action as unknown as { signedDelegate: { delegateAction: { senderId: string } } })
      .signedDelegate;
    if (sd.delegateAction.senderId !== tx.receiverId) {
      refuse('the receiver must be the delegate sender');
    }
    return;
  }
  if (kind !== 'functionCall') refuse(`a ${kind} action`);
  const fc = action.functionCall!;
  if (fc.methodName !== 'storage_deposit') refuse(`a ${fc.methodName} call`);
  if (!NEAR_GASLESS_TOKENS.some((t) => t.contract === tx.receiverId)) {
    refuse(`storage_deposit on ${tx.receiverId} (not a gasless token)`);
  }
  if (BigInt(fc.deposit) > RELAYER_NEAR_MAX_STORAGE_DEPOSIT) refuse('a deposit above the cap');
  let args: unknown;
  try {
    args = JSON.parse(new TextDecoder().decode(fc.args));
  } catch {
    return refuse('unreadable arguments');
  }
  const a = args as Record<string, unknown>;
  if (
    !a ||
    typeof a !== 'object' ||
    Object.keys(a).sort().join(',') !== 'account_id,registration_only' ||
    typeof a.account_id !== 'string' ||
    a.registration_only !== true
  ) {
    refuse('storage_deposit must be registration-only for one account');
  }
}

/** Decodes a base58 NEAR CryptoHash (e.g. a global contract code hash). */
export function decodeHash(b58: string): Uint8Array {
  const raw = bs58.decode(b58);
  if (raw.length !== 32) throw new Error('Expected a base58 32-byte hash');
  return raw;
}
