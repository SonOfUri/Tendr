// Tron transactions for gasless USDT payments (project 5a, spec §2.3 Tron; rulings T9-a … T9-e):
// addresses, the protobuf `Transaction.raw` the shopper and `gas-tron` sign, the exact checks on
// the shopper's `approve`, and the `gas-tron` signing guard.
//
// A Tron transaction is `Transaction { raw raw_data = 1; repeated bytes signature = 2; }`; its id
// is sha256(raw_data) and each signature is secp256k1 over that id, 65 bytes r ‖ s ‖ v (v 27/28
// as TronWeb writes it; 0/1 accepted). We build and read `raw` ourselves (no TronWeb): only the
// fields below exist, in field-number order, proto3 defaults omitted, so a decoded transaction
// re-encodes to identical bytes or it is refused.
//
//   raw       1 ref_block_bytes · 4 ref_block_hash · 8 expiration (ms) · 11 contract (exactly one)
//             · 14 timestamp (ms) · 18 fee_limit (sun)
//   contract  1 type · 2 parameter (Any: 1 type_url · 2 value)
//   31 TriggerSmartContract      1 owner · 2 contract · 4 data
//   57 DelegateResourceContract  1 owner · 2 resource (0 bandwidth, 1 energy) · 3 balance · 4 receiver
//   58 UnDelegateResourceContract  the same, without lock
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { TENDR_FORWARDER_ABI } from '@tendr/contracts';
import bs58 from 'bs58';
import { Interface } from 'ethers';
import type { KeyVault } from '../keyvault/types.js';

const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

/** A base58check Tron address (`T…`, 21 bytes with the `0x41` prefix). */
export const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** `T…` → its 21 bytes (`0x41` + 20), or null when it is not a valid Tron address. */
export function tronBytes(address: string): Uint8Array | null {
  if (!TRON_ADDRESS_RE.test(address)) return null;
  let raw: Uint8Array;
  try {
    raw = bs58.decode(address);
  } catch {
    return null;
  }
  if (raw.length !== 25 || raw[0] !== 0x41) return null;
  const payload = raw.subarray(0, 21);
  const check = sha256(sha256(payload)).subarray(0, 4);
  if (!check.equals(Buffer.from(raw.subarray(21)))) return null;
  return Uint8Array.from(payload);
}

/** 21 bytes (`0x41` + 20) → `T…`. */
export function tronAddress(bytes21: Uint8Array): string {
  if (bytes21.length !== 21 || bytes21[0] !== 0x41) throw new Error('not a Tron address');
  const check = sha256(sha256(bytes21)).subarray(0, 4);
  return bs58.encode(Buffer.concat([Buffer.from(bytes21), check]));
}

/** Whether `address` is a valid base58check Tron address. */
export const isTronAddress = (address: string): boolean => tronBytes(address) !== null;

/** `T…` → `0x` + 20-byte hex (lower case), as the TVM's ABI and TIP-712 see it. */
export function tronToEvm(address: string): string {
  const b = tronBytes(address);
  if (!b) throw new Error('not a Tron address');
  return `0x${Buffer.from(b.subarray(1)).toString('hex')}`;
}

/** `0x` + 20-byte hex (or 20 bare hex bytes, or 21 starting `41`) → `T…`. */
export function evmToTron(hex: string): string {
  const h = hex.replace(/^0x/i, '').toLowerCase();
  if (/^41[0-9a-f]{40}$/.test(h)) return tronAddress(Buffer.from(h, 'hex'));
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('not a 20-byte address');
  return tronAddress(Buffer.from(`41${h}`, 'hex'));
}

/** The Tron address of an uncompressed secp256k1 public key (65 bytes, `04…`). */
export function tronAddressOfPublicKey(raw: Uint8Array): string {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('expected a 65-byte public key');
  const h = keccak_256(raw.subarray(1));
  return tronAddress(Uint8Array.from([0x41, ...h.subarray(12)]));
}

// ---------------------------------------------------------------------------------------------
// Protobuf (the subset Tron transactions use)
// ---------------------------------------------------------------------------------------------

class Writer {
  private readonly out: number[] = [];

  private varint(n: bigint): void {
    if (n < 0n) throw new Error('negative varint');
    let v = n;
    while (v >= 0x80n) {
      this.out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.out.push(Number(v));
  }

  /** A varint field; omitted when 0 (proto3). */
  uint(field: number, n: bigint | number): this {
    const v = BigInt(n);
    if (v === 0n) return this;
    this.varint(BigInt(field << 3));
    this.varint(v);
    return this;
  }

  /** A length-delimited field; omitted when empty (proto3). */
  bytes(field: number, b: Uint8Array): this {
    if (b.length === 0) return this;
    this.varint(BigInt((field << 3) | 2));
    this.varint(BigInt(b.length));
    for (const x of b) this.out.push(x);
    return this;
  }

  string(field: number, s: string): this {
    return this.bytes(field, Buffer.from(s, 'utf8'));
  }

  done(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

type PbValue = { field: number; varint?: bigint; bytes?: Uint8Array };

/** Decodes one message's fields (varint and length-delimited only); throws on anything else. */
function readFields(b: Uint8Array): PbValue[] {
  const out: PbValue[] = [];
  let i = 0;
  const varint = (): bigint => {
    let v = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (i >= b.length) throw new Error('truncated varint');
      const x = b[i++]!;
      v |= BigInt(x & 0x7f) << shift;
      if (!(x & 0x80)) return v;
    }
    throw new Error('varint too long');
  };
  while (i < b.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field <= 0) throw new Error('bad field number');
    if (wire === 0) {
      out.push({ field, varint: varint() });
    } else if (wire === 2) {
      const len = Number(varint());
      if (i + len > b.length) throw new Error('truncated field');
      out.push({ field, bytes: b.subarray(i, i + len) });
      i += len;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

/** The fields of `b` as a map; throws on an unknown or repeated field (`allowed` lists them). */
function fieldMap(
  b: Uint8Array,
  allowed: Record<number, 'varint' | 'bytes'>,
): Map<number, PbValue> {
  const m = new Map<number, PbValue>();
  for (const f of readFields(b)) {
    const kind = allowed[f.field];
    if (!kind) throw new Error(`unexpected field ${f.field}`);
    if ((kind === 'varint') !== (f.varint !== undefined)) throw new Error(`bad field ${f.field}`);
    if (m.has(f.field)) throw new Error(`repeated field ${f.field}`);
    m.set(f.field, f);
  }
  return m;
}

const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

export const TRIGGER_SMART_CONTRACT = 31;
export const DELEGATE_RESOURCE = 57;
export const UNDELEGATE_RESOURCE = 58;
const TYPE_URLS: Record<number, string> = {
  [TRIGGER_SMART_CONTRACT]: 'type.googleapis.com/protocol.TriggerSmartContract',
  [DELEGATE_RESOURCE]: 'type.googleapis.com/protocol.DelegateResourceContract',
  [UNDELEGATE_RESOURCE]: 'type.googleapis.com/protocol.UnDelegateResourceContract',
};

export type TronResource = 'energy' | 'bandwidth';
const RESOURCE_CODE: Record<TronResource, number> = { bandwidth: 0, energy: 1 };

/** The block a transaction references (TaPoS): bytes 6–8 of its number, bytes 8–16 of its id. */
export interface RefBlock {
  /** 2 bytes. */
  bytes: Uint8Array;
  /** 8 bytes. */
  hash: Uint8Array;
}

/** A block as TronGrid returns it (`blockID` hex, number, timestamp ms). */
export function refBlockOf(blockId: string): RefBlock {
  if (!/^[0-9a-fA-F]{64}$/.test(blockId)) throw new Error('bad block id');
  const id = Buffer.from(blockId, 'hex');
  return { bytes: Uint8Array.from(id.subarray(6, 8)), hash: Uint8Array.from(id.subarray(8, 16)) };
}

export type TronContract =
  | { type: 'trigger'; owner: string; contract: string; data: Uint8Array }
  | {
      type: 'delegate' | 'undelegate';
      owner: string;
      receiver: string;
      resource: TronResource;
      balance: bigint;
    };

export interface TronRaw {
  ref: RefBlock;
  /** ms since the epoch. */
  expiration: bigint;
  timestamp: bigint;
  /** sun; 0 for system contracts. */
  feeLimit: bigint;
  contract: TronContract;
}

function encodeContract(c: TronContract): { type: number; value: Uint8Array } {
  const addr = (a: string) => {
    const b = tronBytes(a);
    if (!b) throw new Error(`not a Tron address: ${a}`);
    return b;
  };
  if (c.type === 'trigger') {
    return {
      type: TRIGGER_SMART_CONTRACT,
      value: new Writer()
        .bytes(1, addr(c.owner))
        .bytes(2, addr(c.contract))
        .bytes(4, c.data)
        .done(),
    };
  }
  return {
    type: c.type === 'delegate' ? DELEGATE_RESOURCE : UNDELEGATE_RESOURCE,
    value: new Writer()
      .bytes(1, addr(c.owner))
      .uint(2, RESOURCE_CODE[c.resource])
      .uint(3, c.balance)
      .bytes(4, addr(c.receiver))
      .done(),
  };
}

/** `Transaction.raw` bytes. */
export function encodeRaw(r: TronRaw): Uint8Array {
  const { type, value } = encodeContract(r.contract);
  const any = new Writer().string(1, TYPE_URLS[type]!).bytes(2, value).done();
  const contract = new Writer().uint(1, type).bytes(2, any).done();
  return new Writer()
    .bytes(1, r.ref.bytes)
    .bytes(4, r.ref.hash)
    .uint(8, r.expiration)
    .bytes(11, contract)
    .uint(14, r.timestamp)
    .uint(18, r.feeLimit)
    .done();
}

/**
 * Decodes `Transaction.raw` bytes; throws unless they hold exactly one known contract, none of
 * the fields this code never writes (permissions, memo, scripts, auths, call value, lock), and
 * re-encode to the identical bytes.
 */
export function decodeRaw(bytes: Uint8Array): TronRaw {
  const raw = fieldMap(bytes, {
    1: 'bytes',
    4: 'bytes',
    8: 'varint',
    11: 'bytes',
    14: 'varint',
    18: 'varint',
  });
  const refBytes = raw.get(1)?.bytes;
  const refHash = raw.get(4)?.bytes;
  const contractBytes = raw.get(11)?.bytes;
  if (!refBytes || refBytes.length !== 2 || !refHash || refHash.length !== 8 || !contractBytes) {
    throw new Error('incomplete transaction');
  }
  const c = fieldMap(contractBytes, { 1: 'varint', 2: 'bytes' });
  const type = Number(c.get(1)?.varint ?? 0n);
  const any = fieldMap(c.get(2)?.bytes ?? new Uint8Array(), { 1: 'bytes', 2: 'bytes' });
  const typeUrl = Buffer.from(any.get(1)?.bytes ?? []).toString('utf8');
  if (!TYPE_URLS[type] || TYPE_URLS[type] !== typeUrl) throw new Error('unsupported contract');
  const value = any.get(2)?.bytes ?? new Uint8Array();
  const addr = (b: Uint8Array | undefined) => {
    if (!b || b.length !== 21 || b[0] !== 0x41) throw new Error('bad address');
    return tronAddress(b);
  };
  let contract: TronContract;
  if (type === TRIGGER_SMART_CONTRACT) {
    const t = fieldMap(value, { 1: 'bytes', 2: 'bytes', 4: 'bytes' });
    contract = {
      type: 'trigger',
      owner: addr(t.get(1)?.bytes),
      contract: addr(t.get(2)?.bytes),
      data: Uint8Array.from(t.get(4)?.bytes ?? []),
    };
  } else {
    const d = fieldMap(value, { 1: 'bytes', 2: 'varint', 3: 'varint', 4: 'bytes' });
    const code = Number(d.get(2)?.varint ?? 0n);
    if (code !== 0 && code !== 1) throw new Error('bad resource');
    contract = {
      type: type === DELEGATE_RESOURCE ? 'delegate' : 'undelegate',
      owner: addr(d.get(1)?.bytes),
      resource: code === 1 ? 'energy' : 'bandwidth',
      balance: d.get(3)?.varint ?? 0n,
      receiver: addr(d.get(4)?.bytes),
    };
  }
  const decoded: TronRaw = {
    ref: { bytes: Uint8Array.from(refBytes), hash: Uint8Array.from(refHash) },
    expiration: raw.get(8)?.varint ?? 0n,
    timestamp: raw.get(14)?.varint ?? 0n,
    feeLimit: raw.get(18)?.varint ?? 0n,
    contract,
  };
  if (!eq(encodeRaw(decoded), bytes)) throw new Error('non-canonical transaction');
  return decoded;
}

/**
 * A contract-call `raw` as TronGrid's JSON (`visible: false`: 21-byte hex addresses), which TronWeb
 * re-serialises and checks against `txID` before signing; it encodes to exactly `encodeRaw(r)`.
 */
export function rawDataJson(r: TronRaw) {
  const c = r.contract;
  if (c.type !== 'trigger') throw new Error('only contract calls are handed to wallets');
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  return {
    contract: [
      {
        parameter: {
          value: {
            data: hex(c.data),
            owner_address: hex(tronBytes(c.owner)!),
            contract_address: hex(tronBytes(c.contract)!),
          },
          type_url: TYPE_URLS[TRIGGER_SMART_CONTRACT]!,
        },
        type: 'TriggerSmartContract',
      },
    ],
    ref_block_bytes: hex(r.ref.bytes),
    ref_block_hash: hex(r.ref.hash),
    expiration: Number(r.expiration),
    fee_limit: Number(r.feeLimit),
    timestamp: Number(r.timestamp),
  };
}

/** The transaction id: sha256 of the raw bytes, hex. */
export const txIdOf = (raw: Uint8Array): string => sha256(raw).toString('hex');

/** `Transaction { raw_data = 1; signature = 2 }` bytes, hex (what `broadcasthex` takes). */
export function encodeSignedTx(raw: Uint8Array, signature: Uint8Array): string {
  return Buffer.from(new Writer().bytes(1, raw).bytes(2, signature).done()).toString('hex');
}

/** A signed `Transaction` (hex) → its raw bytes and its one signature; throws on anything else. */
export function decodeSignedTx(hex: string): { raw: Uint8Array; signature: Uint8Array } {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('not hex');
  const bytes = Buffer.from(hex, 'hex');
  const m = fieldMap(bytes, { 1: 'bytes', 2: 'bytes' });
  const raw = m.get(1)?.bytes;
  const signature = m.get(2)?.bytes;
  if (!raw || !signature) throw new Error('incomplete transaction');
  return { raw: Uint8Array.from(raw), signature: Uint8Array.from(signature) };
}

/** The signer's Tron address of a 65-byte r ‖ s ‖ v signature over `txId`; null if invalid. */
export function recoverSigner(txId: string, signature: Uint8Array): string | null {
  if (signature.length !== 65 || !/^[0-9a-f]{64}$/.test(txId)) return null;
  const v = signature[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(signature.subarray(0, 64)).addRecoveryBit(recovery);
    const pub = sig.recoverPublicKey(Buffer.from(txId, 'hex')).toRawBytes(false);
    return tronAddressOfPublicKey(pub);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The shopper's approve and Tendr's own transactions
// ---------------------------------------------------------------------------------------------

const ERC20 = new Interface([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
export const FORWARDER = new Interface(TENDR_FORWARDER_ABI as unknown as string);

/** `approve(spender, value)` calldata, the spender a Tron address. */
export function approveData(spender: string, value: bigint): Uint8Array {
  return Uint8Array.from(
    Buffer.from(ERC20.encodeFunctionData('approve', [tronToEvm(spender), value]).slice(2), 'hex'),
  );
}

/** The `approve` call `data` decodes to, or null when it is anything else. */
export function decodeApprove(data: Uint8Array): { spender: string; value: bigint } | null {
  const hex = `0x${Buffer.from(data).toString('hex')}`;
  try {
    const d = ERC20.decodeFunctionData('approve', hex);
    // Exactly the canonical encoding: no trailing or dirty bytes.
    if (ERC20.encodeFunctionData('approve', [d[0], d[1]]) !== hex) return null;
    return { spender: evmToTron(d[0] as string), value: d[1] as bigint };
  } catch {
    return null;
  }
}

/** `allowance(owner, spender)` / `balanceOf(owner)` parameters (hex, no selector). */
export const allowanceParameter = (owner: string, spender: string) =>
  ERC20.encodeFunctionData('allowance', [tronToEvm(owner), tronToEvm(spender)]).slice(10);
export const balanceOfParameter = (owner: string) =>
  ERC20.encodeFunctionData('balanceOf', [tronToEvm(owner)]).slice(10);
export const nonceUsedParameter = (from: string, nonce: string) =>
  FORWARDER.encodeFunctionData('nonceUsed', [tronToEvm(from), nonce]).slice(10);

/** What `gas-tron` may sign (`signGasTron`). */
export interface GasTronPolicy {
  gasTron: string;
  /** The forwarder (`TRON_FORWARDER_ADDRESS`); `payWithApproval` is the only call allowed. */
  forwarder: string;
  maxFeeLimitSun: bigint;
  /** The most TRX (sun) one delegation may lend. */
  maxDelegationSun: bigint;
}

const PAY_WITH_APPROVAL = FORWARDER.getFunction('payWithApproval')!.selector.slice(2);

/**
 * Throws unless `raw` is something `gas-tron` exists to sign: a `payWithApproval` call to the
 * forwarder (no TRX sent), or a lock-free delegation / undelegation of its own resources, bounded.
 */
export function assertGasTronTransaction(raw: TronRaw, policy: GasTronPolicy): void {
  const c = raw.contract;
  if (c.owner !== policy.gasTron) throw new Error('gas-tron signs only its own transactions');
  if (c.type === 'trigger') {
    if (c.contract !== policy.forwarder) throw new Error('gas-tron calls only the forwarder');
    if (Buffer.from(c.data.subarray(0, 4)).toString('hex') !== PAY_WITH_APPROVAL) {
      throw new Error('gas-tron calls only payWithApproval');
    }
    if (raw.feeLimit <= 0n || raw.feeLimit > policy.maxFeeLimitSun) {
      throw new Error('fee limit out of bounds');
    }
    return;
  }
  if (c.receiver === policy.gasTron) throw new Error('no self-delegation');
  if (c.balance <= 0n || c.balance > policy.maxDelegationSun) {
    throw new Error('delegation out of bounds');
  }
  if (raw.feeLimit !== 0n) throw new Error('no fee limit on a resource contract');
}

/** Signs `raw` with `gas-tron` after the guard; returns the txid, the signature and the hex. */
export async function signGasTron(
  kv: KeyVault,
  raw: TronRaw,
  policy: GasTronPolicy,
): Promise<{ txId: string; rawHex: string; signedHex: string }> {
  assertGasTronTransaction(raw, policy);
  const bytes = encodeRaw(raw);
  const txId = txIdOf(bytes);
  const sig = await kv.sign('gas-tron', Buffer.from(txId, 'hex'));
  if (sig.curve !== 'secp256k1') throw new Error('gas-tron is not a secp256k1 key');
  const signature = Uint8Array.from([...sig.r, ...sig.s, sig.v + 27]);
  return {
    txId,
    rawHex: Buffer.from(bytes).toString('hex'),
    signedHex: encodeSignedTx(bytes, signature),
  };
}
