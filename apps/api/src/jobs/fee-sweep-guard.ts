// The signing guard of the gas-fee sweep (project 5a, Task 12, ruling R12-c). This is the only
// place a `gas-fees-*` key signs anything.
//
// A gas-fee key may sign exactly one thing: one transfer of the planned token, for the planned
// amount, from its own account to the 1Click quote's deposit address, on the planned chain. No
// approve, no arbitrary calldata, no other recipient, no second action. The guard decodes the
// exact bytes that are about to be signed (never a description of them) and refuses anything
// else:
//
//   EVM     one EIP-1559 transaction on the plan's chain id, no access list, bounded gas:
//           token  `to` = the token, value 0, data = canonical `transfer(deposit, amount)`
//           native `to` = the deposit address, value = amount, empty data
//   NEAR    signer = the gas-fee account (its own key), receiver = the token contract, one
//           `ft_transfer { receiver_id: deposit, amount }` with exactly 1 yoctoNEAR attached and
//           bounded gas (the deposit address is registered on the token by `relayer-near`)
//   Tron    one TriggerSmartContract owned by the gas-fee address, on the token, no TRX sent,
//           data = canonical `transfer(deposit, amount)`, bounded fee limit
//   Solana  fee payer and only signer = the gas-fee owner, no lookup tables, optionally one
//           idempotent create of the deposit address's token account for the plan's mint (the
//           transfer cannot land without it; it moves no tokens), then exactly one
//           TransferChecked(gas-fee ATA → deposit ATA, amount, decimals, authority = owner)
//
// The transports (fee-sweep-chains.ts) build the bytes; they never call the key vault.
import {
  Signature as NearSignature,
  SignedTransaction,
  decodeTransaction,
} from '@near-js/transactions';
import { KeyType } from '@near-js/crypto';
import { sha256 } from '@noble/hashes/sha2';
import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import bs58 from 'bs58';
import { Interface, Signature, Transaction, getBytes, hexlify } from 'ethers';
import { evmAddress } from '../keyvault/secp256k1.js';
import type { KeyName, KeyVault } from '../keyvault/types.js';
import { implicitAccountId } from '../near/tx.js';
import { EVM_CHAIN_IDS } from '../relayer/evm/tokens.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  associatedTokenAccount,
} from '../relayer/solana-tx.js';
import {
  decodeRaw,
  encodeSignedTx,
  tronAddressOfPublicKey,
  tronToEvm,
  txIdOf,
} from '../relayer/tron-tx.js';

export type SweepFamily = 'evm' | 'solana' | 'near' | 'tron';

/** The one transfer a sweep plan allows (from the plan and its 1Click quote, never a request). */
export interface SweepIntent {
  family: SweepFamily;
  /** 1Click blockchain id. */
  chain: string;
  /** The gas-fee account (must be the signing key's own address). */
  from: string;
  /** null: the chain's native coin; otherwise the token contract (EVM / Tron / NEAR) or mint. */
  token: string | null;
  /** Token decimals (Solana TransferChecked). */
  decimals: number;
  /** Base units. */
  amount: bigint;
  /** The 1Click quote's deposit address. */
  depositAddress: string;
}

/** The exact bytes a transport wants signed. */
export type SweepTx =
  /** `Transaction.unsignedSerialized` (0x hex). */
  | { family: 'evm'; unsigned: string }
  /** borsh(Transaction). */
  | { family: 'near'; transaction: Uint8Array }
  /** `Transaction.raw` bytes. */
  | { family: 'tron'; raw: Uint8Array }
  /** The compiled v0 message bytes. */
  | { family: 'solana'; message: Uint8Array };

export interface SignedSweep {
  family: SweepFamily;
  /** The transaction hash / id / signature the chain reports. */
  txHash: string;
  /** EVM: 0x raw; NEAR: base64 borsh(SignedTransaction); Tron: signed hex; Solana: base64 wire. */
  signed: string;
}

export class SweepRefused extends Error {
  constructor(readonly field: string) {
    super(`gas-fee key refuses to sign: ${field}`);
    this.name = 'SweepRefused';
  }
}

const refuse = (field: string): never => {
  throw new SweepRefused(field);
};

/** The gas-fee key of each family. */
export const SWEEP_KEYS: Readonly<Record<SweepFamily, KeyName>> = {
  evm: 'gas-fees-evm',
  solana: 'gas-fees-solana',
  near: 'gas-fees-near',
  tron: 'gas-fees-tron',
};

/** Upper bounds on what a sweep transfer may spend in gas (it only ever wastes its own gas). */
export const SWEEP_MAX_EVM_GAS = 300_000n;
export const SWEEP_MAX_NEAR_GAS = 30_000_000_000_000n;
export const SWEEP_MAX_TRON_FEE_LIMIT_SUN = 100_000_000n;

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

/** Canonical `transfer(to, amount)` calldata (0x hex, `to` a 0x address). */
export function transferCalldata(to: string, amount: bigint): string {
  return ERC20.encodeFunctionData('transfer', [to, amount]);
}

const lower = (s: string) => s.toLowerCase();

function checkEvm(intent: SweepIntent, unsigned: string): void {
  let t: Transaction;
  try {
    t = Transaction.from(unsigned);
  } catch {
    return refuse('transaction');
  }
  if (t.signature) refuse('transaction.signature');
  if (t.type !== 2) refuse('transaction.type');
  const chainId = EVM_CHAIN_IDS[intent.chain];
  if (chainId === undefined || t.chainId !== BigInt(chainId)) refuse('transaction.chain_id');
  if (t.accessList && t.accessList.length > 0) refuse('transaction.access_list');
  if (t.gasLimit <= 0n || t.gasLimit > SWEEP_MAX_EVM_GAS) refuse('transaction.gas_limit');
  if (!t.to) refuse('transaction.to');
  if (intent.token === null) {
    if (lower(t.to!) !== lower(intent.depositAddress)) refuse('transaction.to');
    if (t.value !== intent.amount) refuse('transaction.value');
    if (t.data !== '0x') refuse('transaction.data');
    return;
  }
  if (lower(t.to!) !== lower(intent.token)) refuse('transaction.to');
  if (t.value !== 0n) refuse('transaction.value');
  if (lower(t.data) !== lower(transferCalldata(intent.depositAddress, intent.amount))) {
    refuse('transaction.data');
  }
}

/** The plain fields of a decoded NEAR transaction. */
interface NearView {
  signerId: string;
  receiverId: string;
  publicKey: Uint8Array;
  actions: { kind: string; fields: Record<string, unknown> }[];
}

function nearView(bytes: Uint8Array): NearView {
  let tx: Transaction | ReturnType<typeof decodeTransaction>;
  try {
    tx = decodeTransaction(bytes);
  } catch {
    return refuse('transaction');
  }
  const t = tx as unknown as {
    signerId: string;
    receiverId: string;
    publicKey: Record<string, { data?: ArrayLike<number> } | undefined>;
    actions: Record<string, unknown>[];
    encode?: () => Uint8Array;
  };
  const pkObj = t.publicKey as unknown as { data?: ArrayLike<number> } & Record<string, unknown>;
  const pk =
    pkObj?.data !== undefined
      ? pkObj
      : (Object.values(pkObj ?? {}).find((v) => v !== undefined && v !== null) as
          { data?: ArrayLike<number> } | undefined);
  return {
    signerId: t.signerId,
    receiverId: t.receiverId,
    publicKey: Uint8Array.from(pk?.data ?? []),
    actions: t.actions.map((a) => {
      const [kind, fields] = Object.entries(a).find(
        ([k, v]) => k !== 'enum' && v !== undefined && v !== null,
      ) ?? ['?', {}];
      return { kind, fields: (fields ?? {}) as Record<string, unknown> };
    }),
  };
}

function checkNear(intent: SweepIntent, bytes: Uint8Array): void {
  const t = nearView(bytes);
  if (t.signerId !== intent.from) refuse('transaction.signer');
  if (implicitAccountId(t.publicKey) !== intent.from) refuse('transaction.public_key');
  if (intent.token === null) refuse('transaction.native');
  if (t.receiverId !== intent.token) refuse('transaction.receiver');
  if (t.actions.length !== 1) refuse('transaction.actions');
  const a = t.actions[0]!;
  if (a.kind !== 'functionCall') refuse('transaction.actions[0]');
  const fc = a.fields as {
    methodName?: string;
    args?: ArrayLike<number>;
    gas?: unknown;
    deposit?: unknown;
  };
  if (fc.methodName !== 'ft_transfer') refuse('transaction.method');
  if (BigInt(String(fc.deposit)) !== 1n) refuse('transaction.deposit');
  const gas = BigInt(String(fc.gas));
  if (gas <= 0n || gas > SWEEP_MAX_NEAR_GAS) refuse('transaction.gas');
  let args: unknown;
  try {
    args = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(fc.args ?? [])),
    );
  } catch {
    return refuse('transaction.args');
  }
  const x = args as Record<string, unknown> | null;
  if (
    !x ||
    typeof x !== 'object' ||
    Array.isArray(x) ||
    Object.keys(x).sort().join(',') !== 'amount,receiver_id'
  ) {
    refuse('transaction.args');
  }
  if (x!.receiver_id !== intent.depositAddress) refuse('transaction.args.receiver_id');
  if (x!.amount !== intent.amount.toString()) refuse('transaction.args.amount');
}

function checkTron(intent: SweepIntent, raw: Uint8Array): void {
  let r: ReturnType<typeof decodeRaw>;
  try {
    r = decodeRaw(raw);
  } catch {
    return refuse('transaction');
  }
  const c = r.contract;
  if (c.type !== 'trigger') refuse('transaction.contract');
  if (intent.token === null) refuse('transaction.native');
  const call = c as Extract<typeof c, { type: 'trigger' }>;
  if (call.owner !== intent.from) refuse('transaction.owner');
  if (call.contract !== intent.token) refuse('transaction.contract_address');
  if (r.feeLimit <= 0n || r.feeLimit > SWEEP_MAX_TRON_FEE_LIMIT_SUN)
    refuse('transaction.fee_limit');
  const expected = transferCalldata(tronToEvm(intent.depositAddress), intent.amount);
  if (`0x${Buffer.from(call.data).toString('hex')}` !== lower(expected)) refuse('transaction.data');
}

const u64le = (d: Uint8Array, at: number) =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

async function checkSolana(intent: SweepIntent, message: Uint8Array): Promise<void> {
  let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  try {
    msg = getCompiledTransactionMessageDecoder().decode(message);
    const again = getCompiledTransactionMessageEncoder().encode(msg);
    if (Buffer.compare(Buffer.from(again), Buffer.from(message)) !== 0) throw new Error();
  } catch {
    return refuse('transaction');
  }
  if (intent.token === null) refuse('transaction.native');
  if (msg.version !== 0) throw new SweepRefused('transaction.version');
  if ('addressTableLookups' in msg && (msg.addressTableLookups?.length ?? 0) > 0) {
    refuse('transaction.address_table_lookups');
  }
  const keys = msg.staticAccounts as readonly string[];
  if (new Set(keys).size !== keys.length) refuse('transaction.accounts');
  if (msg.header.numSignerAccounts !== 1) refuse('transaction.signers');
  if (keys[0] !== intent.from) refuse('transaction.fee_payer');
  const mint = intent.token!;
  const source = await associatedTokenAccount(intent.from, mint);
  const deposit = await associatedTokenAccount(intent.depositAddress, mint);
  const ixs = msg.instructions;
  const used = new Set<number>([0]);
  const accountsOf = (i: number, n: number): string[] => {
    const idx = ixs[i]!.accountIndices ?? [];
    if (idx.length !== n) refuse(`transaction.instructions[${i}]`);
    return idx.map((k) => {
      const key = keys[k];
      if (key === undefined) refuse(`transaction.instructions[${i}]`);
      used.add(k);
      return key!;
    });
  };
  const programOf = (i: number) => {
    const k = ixs[i]!.programAddressIndex;
    used.add(k);
    return keys[k];
  };
  const dataOf = (i: number) => (ixs[i]!.data ?? new Uint8Array()) as Uint8Array;
  let i = 0;
  if (ixs.length === 2) {
    if (programOf(0) !== ASSOCIATED_TOKEN_PROGRAM) refuse('transaction.instructions[0]');
    const d = dataOf(0);
    const [payer, ata, owner, m, system, token] = accountsOf(0, 6);
    if (
      d.length !== 1 ||
      d[0] !== 1 ||
      payer !== intent.from ||
      ata !== deposit ||
      owner !== intent.depositAddress ||
      m !== mint ||
      system !== SYSTEM_PROGRAM ||
      token !== TOKEN_PROGRAM
    ) {
      refuse('transaction.instructions[0]');
    }
    i = 1;
  } else if (ixs.length !== 1) {
    refuse('transaction.instructions');
  }
  if (programOf(i) !== TOKEN_PROGRAM) refuse('transaction.transfer.program');
  const d = dataOf(i);
  if (d.length !== 10 || d[0] !== 12) refuse('transaction.transfer');
  const [src, m, dest, authority] = accountsOf(i, 4);
  if (src !== source) refuse('transaction.transfer.source');
  if (m !== mint) refuse('transaction.transfer.mint');
  if (dest !== deposit) refuse('transaction.transfer.destination');
  if (authority !== intent.from) refuse('transaction.transfer.authority');
  if (u64le(d, 1) !== intent.amount) refuse('transaction.transfer.amount');
  if (d[9] !== intent.decimals) refuse('transaction.transfer.decimals');
  if (used.size !== keys.length) refuse('transaction.accounts');
}

/**
 * Throws SweepRefused unless `tx` is exactly the one transfer `intent` allows (see the header).
 */
export async function assertSweepTransaction(intent: SweepIntent, tx: SweepTx): Promise<void> {
  if (tx.family !== intent.family) refuse('family');
  if (intent.amount <= 0n) refuse('amount');
  switch (tx.family) {
    case 'evm':
      return checkEvm(intent, tx.unsigned);
    case 'near':
      return checkNear(intent, tx.transaction);
    case 'tron':
      return checkTron(intent, tx.raw);
    case 'solana':
      return checkSolana(intent, tx.message);
  }
}

/** The address of a family's gas-fee key (EVM 0x, NEAR implicit id, Tron T…, Solana base58). */
export async function sweepKeyAddress(kv: KeyVault, family: SweepFamily): Promise<string> {
  const { raw } = await kv.publicKey(SWEEP_KEYS[family]);
  switch (family) {
    case 'evm':
      return evmAddress(raw);
    case 'near':
      return implicitAccountId(raw);
    case 'tron':
      return tronAddressOfPublicKey(raw);
    case 'solana':
      return bs58.encode(raw);
  }
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

/**
 * Signs a sweep transfer with the family's gas-fee key, only after `assertSweepTransaction`, and
 * only when `intent.from` is the key's own address. The only signing path of a `gas-fees-*` key.
 */
export async function signSweep(
  kv: KeyVault,
  intent: SweepIntent,
  tx: SweepTx,
): Promise<SignedSweep> {
  const own = await sweepKeyAddress(kv, intent.family);
  const same = intent.family === 'evm' ? lower(own) === lower(intent.from) : own === intent.from;
  if (!same) refuse('from');
  await assertSweepTransaction(intent, tx);
  const key = SWEEP_KEYS[intent.family];
  switch (tx.family) {
    case 'evm': {
      const t = Transaction.from(tx.unsigned);
      const sig = await kv.sign(key, getBytes(t.unsignedHash));
      if (sig.curve !== 'secp256k1') throw new Error(`${key} is not a secp256k1 key`);
      t.signature = Signature.from({ r: hexlify(sig.r), s: hexlify(sig.s), v: 27 + sig.v });
      if (lower(t.from ?? '') !== lower(intent.from)) {
        throw new Error(`${key} signature does not recover to the gas-fee address`);
      }
      return { family: 'evm', txHash: t.hash!, signed: t.serialized };
    }
    case 'near': {
      const hash = sha256(tx.transaction);
      const sig = await kv.sign(key, hash);
      if (sig.curve !== 'ed25519') throw new Error(`${key} is not an ed25519 key`);
      const signed = new SignedTransaction({
        transaction: decodeTransaction(tx.transaction),
        signature: new NearSignature({ keyType: KeyType.ED25519, data: sig.signature }),
      });
      return {
        family: 'near',
        txHash: bs58.encode(hash),
        signed: Buffer.from(signed.encode()).toString('base64'),
      };
    }
    case 'tron': {
      const txId = txIdOf(tx.raw);
      const sig = await kv.sign(key, Buffer.from(txId, 'hex'));
      if (sig.curve !== 'secp256k1') throw new Error(`${key} is not a secp256k1 key`);
      const signature = Uint8Array.from([...sig.r, ...sig.s, sig.v + 27]);
      return { family: 'tron', txHash: txId, signed: encodeSignedTx(tx.raw, signature) };
    }
    case 'solana': {
      const sig = await kv.sign(key, tx.message);
      if (sig.curve !== 'ed25519') throw new Error(`${key} is not an ed25519 key`);
      const wire = Uint8Array.from([...compactU16(1), ...sig.signature, ...tx.message]);
      return {
        family: 'solana',
        txHash: bs58.encode(sig.signature),
        signed: Buffer.from(wire).toString('base64'),
      };
    }
  }
}
