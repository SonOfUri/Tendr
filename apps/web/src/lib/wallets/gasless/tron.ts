// Tron gasless signing (spec §2.3: two signatures by design). Step 1: TronLink signs (never
// broadcasts) an `approve` of exactly amount + fee to Tendr's forwarder; Tendr broadcasts it after
// lending the energy. Step 2: TronLink signs a TIP-712 `TendrPayment` that the forwarder verifies
// before its two `transferFrom`s. The approve's raw bytes are decoded here (protobuf
// `Transaction.raw`) and must be exactly that one contract call; its id must be their sha256. The
// forwarder is pinned in the page's config (NEXT_PUBLIC_TRON_FORWARDER_ADDRESS); without it Tron
// payments are sent normally.
import { sha256 } from '@noble/hashes/sha2';
import {
  FORWARDER_DOMAIN_NAME,
  FORWARDER_DOMAIN_VERSION,
  TENDR_PAYMENT_TYPES,
} from '@tendr/contracts';
import { base58Decode } from '@/lib/base58';
import { WalletError, toWalletError } from '../errors';
import type { PayTarget } from '../index';
import { checkShape } from './evm';
import {
  deadlineSeconds,
  mismatch,
  uintOf,
  type GaslessExpectation,
  type GaslessMethod,
  type GaslessSigner,
  type PreparePayload,
} from './index';

export const TRON_APPROVE_KIND = 'tron_approve';
export const TRON_PAYMENT_KIND = 'tendr_payment';
export const TRON_CHAIN_IDS = { live: 728126428, test: 3448148188 } as const;
/** The API refuses an approve fee limit above 30 TRX. */
const MAX_APPROVE_FEE_LIMIT_SUN = 30_000_000n;
const TRIGGER_SMART_CONTRACT = 31n;
const TRIGGER_TYPE_URL = 'type.googleapis.com/protocol.TriggerSmartContract';
/** keccak256("approve(address,uint256)")[0..4]. */
const APPROVE_SELECTOR = '095ea7b3';
const HEX = /^([0-9a-fA-F]{2})+$/;
const SIGNATURE = /^(0x)?[0-9a-fA-F]{130}$/;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** A base58check Tron address as its 21-byte hex (`41…`); throws a mismatch on anything else. */
export function tronAddressHex(address: string, field = 'address'): string {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(address);
  } catch {
    throw mismatch(field);
  }
  if (bytes.length !== 25 || bytes[0] !== 0x41) throw mismatch(field);
  const body = bytes.slice(0, 21);
  const check = sha256(sha256(body)).slice(0, 4);
  if (check.some((b, i) => b !== bytes[21 + i])) throw mismatch(field);
  return toHex(body);
}

/** The 0x 20-byte form TIP-712 messages use. */
const tronToEvm = (address: string, field: string) =>
  '0x' + tronAddressHex(address, field).slice(2);

// --- protobuf, just enough for Transaction.raw ----------------------------------------------

type ProtoValue = bigint | Uint8Array;

function readFields(buf: Uint8Array, field: string): { field: number; value: ProtoValue }[] {
  const out: { field: number; value: ProtoValue }[] = [];
  let i = 0;
  const varint = (): bigint => {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length || shift > 63n) throw mismatch(field);
      const b = buf[i++]!;
      n |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return n;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const f = Number(key >> 3n);
    const wt = Number(key & 7n);
    if (wt === 0) out.push({ field: f, value: varint() });
    else if (wt === 2) {
      const len = Number(varint());
      if (i + len > buf.length) throw mismatch(field);
      out.push({ field: f, value: buf.slice(i, i + len) });
      i += len;
    } else throw mismatch(field);
  }
  return out;
}

/** Each field at most once, only the allowed ones, with the expected wire type. */
function fieldMap(
  buf: Uint8Array,
  allowed: Record<number, 'varint' | 'bytes'>,
  field: string,
  repeated: number[] = [],
): Map<number, ProtoValue[]> {
  const m = new Map<number, ProtoValue[]>();
  for (const { field: f, value } of readFields(buf, field)) {
    const want = allowed[f];
    if (!want || (want === 'varint') !== (typeof value === 'bigint')) throw mismatch(field);
    const list = m.get(f) ?? [];
    if (list.length > 0 && !repeated.includes(f)) throw mismatch(field);
    list.push(value);
    m.set(f, list);
  }
  return m;
}

/** The approve transaction's raw bytes must be exactly one `approve(forwarder, amount + fee)`. */
export function checkApproveRaw(
  rawHex: string,
  e: Pick<GaslessExpectation, 'wallet' | 'amount' | 'fee' | 'deadline' | 'target'>,
  forwarder: string,
): void {
  if (typeof rawHex !== 'string' || !HEX.test(rawHex) || rawHex.length > 1000) {
    throw mismatch('approve.raw_data_hex');
  }
  const raw = fieldMap(
    fromHex(rawHex),
    { 1: 'bytes', 4: 'bytes', 8: 'varint', 11: 'bytes', 14: 'varint', 18: 'varint' },
    'approve.raw_data_hex',
    [11],
  );
  const contracts = raw.get(11) ?? [];
  if (contracts.length !== 1) throw mismatch('approve.contract');
  const c = fieldMap(contracts[0] as Uint8Array, { 1: 'varint', 2: 'bytes' }, 'approve.contract');
  if (c.get(1)?.[0] !== TRIGGER_SMART_CONTRACT) throw mismatch('approve.contract');
  const any = fieldMap(c.get(2)?.[0] as Uint8Array, { 1: 'bytes', 2: 'bytes' }, 'approve.contract');
  const typeUrl = new TextDecoder().decode((any.get(1)?.[0] as Uint8Array) ?? new Uint8Array());
  if (typeUrl !== TRIGGER_TYPE_URL) throw mismatch('approve.contract');
  const t = fieldMap(
    any.get(2)?.[0] as Uint8Array,
    { 1: 'bytes', 2: 'bytes', 3: 'varint', 4: 'bytes' },
    'approve.contract',
  );
  const hexOf = (v: ProtoValue | undefined) => (v instanceof Uint8Array ? toHex(v) : '');
  if (hexOf(t.get(1)?.[0]) !== tronAddressHex(e.wallet, 'signer')) throw mismatch('approve.owner');
  if (hexOf(t.get(2)?.[0]) !== tronAddressHex(e.target.contract!, 'token')) {
    throw mismatch('approve.contract');
  }
  if ((t.get(3)?.[0] ?? 0n) !== 0n) throw mismatch('approve.call_value');
  const want =
    APPROVE_SELECTOR +
    tronAddressHex(forwarder, 'forwarder').slice(2).padStart(64, '0') +
    (e.amount + e.fee).toString(16).padStart(64, '0');
  if (hexOf(t.get(4)?.[0]) !== want) throw mismatch('approve.data');
  const expiration = raw.get(8)?.[0];
  if (typeof expiration !== 'bigint' || expiration > BigInt(Date.parse(e.deadline))) {
    throw mismatch('approve.expiration');
  }
  const feeLimit = raw.get(18)?.[0];
  if (typeof feeLimit !== 'bigint' || feeLimit < 1n || feeLimit > MAX_APPROVE_FEE_LIMIT_SUN) {
    throw mismatch('approve.fee_limit');
  }
}

// --- the wallet -----------------------------------------------------------------------------

interface TronTx {
  txID: string;
  raw_data: unknown;
  raw_data_hex: string;
  signature?: string[];
}

interface TronLinkLike {
  defaultAddress?: { base58?: string | false };
  trx: {
    sign(tx: object): Promise<{ txID?: unknown; signature?: unknown }>;
    getBalance?(address: string): Promise<number>;
    signTypedData?(domain: object, types: object, message: object): Promise<string>;
    _signTypedData?(domain: object, types: object, message: object): Promise<string>;
  };
}

export interface TronGaslessDeps {
  win: { tronLink?: { tronWeb?: TronLinkLike | false }; tronWeb?: TronLinkLike | false };
  address(): string | null;
  /** Tendr's Tron forwarder (base58, the page's config), or null when not configured. */
  forwarder: string | null;
}

export function createTronGasless(target: PayTarget, deps: TronGaslessDeps): GaslessSigner {
  if (target.family !== 'tron') throw new WalletError('failed', { detail: 'not a Tron asset' });
  const tronWeb = () => deps.win.tronLink?.tronWeb || deps.win.tronWeb || null;
  const typedSigner = (tw: TronLinkLike) => tw.trx.signTypedData ?? tw.trx._signTypedData;

  async function signApprove(p: PreparePayload, e: GaslessExpectation, forwarder: string) {
    if (p.to_sign.length !== 1 || p.to_sign[0]!.kind !== TRON_APPROVE_KIND)
      throw mismatch('to_sign');
    const td = p.to_sign[0]!.typed_data as { transaction?: TronTx } | null;
    const tx = td?.transaction;
    if (!tx || typeof tx.raw_data_hex !== 'string' || typeof tx.txID !== 'string') {
      throw mismatch('approve.transaction');
    }
    checkApproveRaw(tx.raw_data_hex, e, forwarder);
    // What the wallet signs is this id: it must be the hash of exactly those bytes.
    if (tx.txID.toLowerCase() !== toHex(sha256(fromHex(tx.raw_data_hex)))) {
      throw mismatch('approve.txID');
    }
    const tw = tronWeb()!;
    let signed: { txID?: unknown; signature?: unknown };
    try {
      // Sign only: Tendr lends the energy, then broadcasts it.
      signed = await tw.trx.sign({
        txID: tx.txID,
        raw_data: tx.raw_data,
        raw_data_hex: tx.raw_data_hex,
        visible: false,
      });
    } catch (err) {
      throw toWalletError(err);
    }
    const sig = Array.isArray(signed?.signature) ? signed.signature[0] : undefined;
    if (signed?.txID !== tx.txID || typeof sig !== 'string' || !SIGNATURE.test(sig)) {
      throw new WalletError('failed', { detail: 'bad approve signature' });
    }
    return {
      kind: 'submit' as const,
      body: { tron_approve: { raw_data_hex: tx.raw_data_hex, signature: sig } },
    };
  }

  async function signPayment(p: PreparePayload, e: GaslessExpectation, forwarder: string) {
    if (p.to_sign.length !== 1 || p.to_sign[0]!.kind !== TRON_PAYMENT_KIND)
      throw mismatch('to_sign');
    const kind = TRON_PAYMENT_KIND;
    const td = checkShape(
      kind,
      p.to_sign[0]!.typed_data,
      'TendrPayment',
      TENDR_PAYMENT_TYPES.TendrPayment,
      {
        name: FORWARDER_DOMAIN_NAME,
        version: FORWARDER_DOMAIN_VERSION,
        chainId: e.livemode ? TRON_CHAIN_IDS.live : TRON_CHAIN_IDS.test,
        verifyingContract: tronToEvm(forwarder, 'forwarder'),
      },
    );
    const m = td.message as Record<string, string>;
    const same = (v: string, address: string, field: string) =>
      v.toLowerCase() === tronToEvm(address, field).toLowerCase();
    if (!same(m.token!, e.target.contract!, 'token')) throw mismatch(`${kind}.token`);
    if (!same(m.from!, e.wallet, 'signer')) throw mismatch(`${kind}.from`);
    if (!same(m.to!, e.depositAddress, 'deposit')) throw mismatch(`${kind}.to`);
    if (uintOf(m.amount, `${kind}.amount`) !== e.amount) throw mismatch(`${kind}.amount`);
    if (uintOf(m.fee, `${kind}.fee`) !== e.fee) throw mismatch(`${kind}.fee`);
    if (same(m.feeTo!, e.depositAddress, 'deposit') || same(m.feeTo!, e.wallet, 'signer')) {
      throw mismatch(`${kind}.feeTo`);
    }
    const dl = uintOf(m.deadline, `${kind}.deadline`);
    if (dl === 0n || dl > deadlineSeconds(e.deadline)) throw mismatch(`${kind}.deadline`);

    const tw = tronWeb()!;
    const signTyped = typedSigner(tw)!;
    let sig: unknown;
    try {
      sig = await signTyped.call(tw.trx, td.domain, { TendrPayment: td.types.TendrPayment }, m);
    } catch (err) {
      throw toWalletError(err);
    }
    if (typeof sig !== 'string' || !SIGNATURE.test(sig)) {
      throw new WalletError('failed', { detail: 'bad signature' });
    }
    const signature = sig.startsWith('0x') ? sig : '0x' + sig;
    return {
      kind: 'submit' as const,
      body: { signatures: { [kind]: { message: m, signature } } },
    };
  }

  return {
    async methods(): Promise<GaslessMethod[]> {
      const tw = tronWeb();
      const ok =
        target.kind === 'token' &&
        deps.forwarder !== null &&
        !!tw &&
        typeof tw.trx?.sign === 'function' &&
        typeof typedSigner(tw) === 'function';
      return ok ? ['forwarder'] : [];
    },
    async nativeBalance() {
      const a = deps.address();
      const tw = tronWeb();
      if (!a || !tw?.trx.getBalance) return null;
      try {
        const sun = await tw.trx.getBalance(a);
        return Number.isSafeInteger(sun) && sun >= 0 ? BigInt(sun) : null;
      } catch {
        return null;
      }
    },
    async sign(p, e) {
      const address = deps.address();
      const forwarder = deps.forwarder;
      if (!address || !tronWeb() || !forwarder)
        throw new WalletError('failed', { detail: 'not connected' });
      if (address !== e.wallet) throw new WalletError('account_changed', { address });
      if (p.step === 'approve') return signApprove(p, e, forwarder);
      if (p.step === 'payment') return signPayment(p, e, forwarder);
      throw mismatch('step');
    },
  };
}
