// The bytes merchant-account signers sign, mirrored from the Rust contract
// (onchain/merchant-account/src/{action,approval,recovery,webauthn}.rs). Rust and TypeScript are
// tied together by the shared vectors in onchain/merchant-account/test-vectors/; encoding.test.ts
// checks every one byte for byte.
//
// - `Action` JSON is the contract's serde shape (`rename_all = "snake_case"`, externally tagged):
//   u128 amounts are decimal strings, byte arrays are standard padded base64.
// - borsh: enums are a u8 variant index then the fields in declaration order; `String` and `Vec`
//   are a u32 LE length then the items; `Option` is 0 | 1 + value; integers are little-endian;
//   `[u8; N]` is the raw bytes. `AccountId` encodes as its string.
// - proposal id = sha256(borsh(action) ‖ salt); WebAuthn challenge =
//   sha256(borsh(ApprovalPayload { domain, contract_id, proposal_id, signer_epoch, intent })),
//   sent to the authenticator as base64url without padding.
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { ProposalKindValues, SignerKeySchema, type ProposalKind } from '@tendr/contracts';
import { z } from 'zod';

export const APPROVAL_DOMAIN = 'tendr-merchant-account-v1';
export const RECOVERY_DOMAIN = 'tendr-merchant-account-recovery-v1';
export const RECOVERY_ID_DOMAIN = 'tendr-merchant-account-recovery-id-v1';

// ─── Action JSON schema ──────────────────────────────────────────────────────

const U128_MAX = (1n << 128n) - 1n;
/** A `U128` JSON value: a decimal string in [0, 2^128). */
const U128 = z
  .string()
  .regex(/^(0|[1-9]\d{0,38})$/, 'must be a decimal integer string')
  .refine((s) => BigInt(s) <= U128_MAX, 'must fit in u128');

/** Generous structural cap; the contract's own per-field bounds are checked by `validateLocally`. */
const Str = z.string().max(1024);

/** A NEAR account id, as `near_sdk::AccountId` deserialisation accepts it. */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const AccountIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(ACCOUNT_ID, 'must be a valid NEAR account id');

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const Bytes32 = z.string().refine((s) => BASE64.test(s) && Buffer.from(s, 'base64').length === 32, {
  message: 'must be standard padded base64 of 32 bytes',
});

const WithdrawRouteSchema = z.union([
  z.object({ poa: z.object({ token_contract: AccountIdSchema }).strict() }).strict(),
  z.object({ swap: z.object({ deposit_account: AccountIdSchema }).strict() }).strict(),
]);
export type WithdrawRoute = z.infer<typeof WithdrawRouteSchema>;

const SignerSchema = z.object({ id: Str, keys: z.array(SignerKeySchema).max(64) }).strict();
export type SignerJson = z.infer<typeof SignerSchema>;

const variant = <K extends string, T extends z.ZodTypeAny>(key: K, value: T) =>
  z.object({ [key]: value } as { [P in K]: T }).strict();

/** The contract's `Action` enum as JSON, one variant per object key, in Borsh order. */
export const ActionSchema = z.union([
  variant('add_signer', SignerSchema),
  variant('remove_signer', z.object({ id: Str }).strict()),
  variant('add_signer_key', z.object({ id: Str, key: SignerKeySchema }).strict()),
  variant('remove_signer_key', z.object({ id: Str, key: SignerKeySchema }).strict()),
  variant('set_threshold', z.number().int().min(0).max(255)),
  variant('set_origins', z.array(Str).max(64)),
  variant('rotate_recovery_key', Bytes32.nullable()),
  variant('add_saved_address', z.object({ id: Str, chain: Str, address: Str }).strict()),
  variant('remove_saved_address', z.object({ id: Str }).strict()),
  variant(
    'set_limits',
    z.object({ asset: Str, per_tx: U128.nullable(), per_day: U128.nullable() }).strict(),
  ),
  variant('set_refund_cap', z.object({ asset: Str, daily: U128 }).strict()),
  variant(
    'set_auto_sweep',
    z.object({ asset: Str, trigger_above: U128, keep: U128, saved_address_id: Str }).strict(),
  ),
  variant('clear_auto_sweep', z.object({ asset: Str }).strict()),
  variant(
    'withdraw',
    z
      .object({ asset: Str, amount: U128, saved_address_id: Str, route: WithdrawRouteSchema })
      .strict(),
  ),
  variant(
    'refund',
    z
      .object({
        asset: Str,
        amount: U128,
        destination_chain: Str,
        destination: Str,
        payment_id: Str,
        route: WithdrawRouteSchema,
      })
      .strict(),
  ),
  variant('upgrade', z.object({ code_hash: Bytes32 }).strict()),
  variant(
    'set_settlement',
    z
      .object({
        dest_asset: Str,
        payout_mode: z.enum(['intents', 'wallet']),
        saved_address_id: Str.nullable(),
      })
      .strict(),
  ),
]);
export type ActionJson = z.infer<typeof ActionSchema>;

/** Narrows an action to one variant's payload. */
export type ActionOf<K extends ProposalKind> = Extract<ActionJson, Record<K, unknown>>[K];

/** The variant name of an action (its single key), e.g. `withdraw`. */
export function kindOf(action: ActionJson): ProposalKind {
  const [k] = Object.keys(action);
  return k as ProposalKind;
}

// ─── borsh writer ────────────────────────────────────────────────────────────

class Writer {
  private readonly parts: Uint8Array[] = [];

  bytes(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  u8(n: number): this {
    return this.bytes(Uint8Array.of(n));
  }
  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return this.bytes(b);
  }
  u64(n: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return this.bytes(b);
  }
  u128(n: bigint): this {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(n & ((1n << 64n) - 1n));
    b.writeBigUInt64LE(n >> 64n, 8);
    return this.bytes(b);
  }
  string(s: string): this {
    const b = Buffer.from(s, 'utf8');
    return this.u32(b.length).bytes(b);
  }
  fixed(b: Uint8Array, len: number): this {
    if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
    return this.bytes(b);
  }
  option<T>(v: T | null | undefined, write: (v: T) => void): this {
    if (v === null || v === undefined) return this.u8(0);
    this.u8(1);
    write(v);
    return this;
  }
  vec<T>(items: readonly T[], write: (v: T) => void): this {
    this.u32(items.length);
    items.forEach(write);
    return this;
  }
  done(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.parts));
  }
}

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

function writeSignerKey(w: Writer, key: z.infer<typeof SignerKeySchema>): void {
  if ('p256' in key) w.u8(0).fixed(b64(key.p256), 33);
  else w.u8(1).fixed(b64(key.ed25519), 32);
}

function writeSigner(w: Writer, s: SignerJson): void {
  w.string(s.id).vec(s.keys, (k) => writeSignerKey(w, k));
}

function writeRoute(w: Writer, r: WithdrawRoute): void {
  if ('poa' in r) w.u8(0).string(r.poa.token_contract);
  else w.u8(1).string(r.swap.deposit_account);
}

/** borsh(Action), exactly as the contract encodes it. */
export function encodeAction(action: ActionJson): Uint8Array {
  const kind = kindOf(action);
  const index = ProposalKindValues.indexOf(kind);
  if (index < 0) throw new Error(`unknown action ${kind}`);
  const w = new Writer().u8(index);
  const a = action as Record<string, unknown>;
  switch (kind) {
    case 'add_signer':
      writeSigner(w, a.add_signer as SignerJson);
      break;
    case 'remove_signer':
    case 'remove_saved_address':
      w.string((a[kind] as { id: string }).id);
      break;
    case 'add_signer_key':
    case 'remove_signer_key': {
      const v = a[kind] as ActionOf<'add_signer_key'>;
      w.string(v.id);
      writeSignerKey(w, v.key);
      break;
    }
    case 'set_threshold':
      w.u8(a.set_threshold as number);
      break;
    case 'set_origins':
      w.vec(a.set_origins as string[], (o) => w.string(o));
      break;
    case 'rotate_recovery_key':
      w.option(a.rotate_recovery_key as string | null, (k) => w.fixed(b64(k), 32));
      break;
    case 'add_saved_address': {
      const v = a.add_saved_address as ActionOf<'add_saved_address'>;
      w.string(v.id).string(v.chain).string(v.address);
      break;
    }
    case 'set_limits': {
      const v = a.set_limits as ActionOf<'set_limits'>;
      w.string(v.asset)
        .option(v.per_tx, (x) => w.u128(BigInt(x)))
        .option(v.per_day, (x) => w.u128(BigInt(x)));
      break;
    }
    case 'set_refund_cap': {
      const v = a.set_refund_cap as ActionOf<'set_refund_cap'>;
      w.string(v.asset).u128(BigInt(v.daily));
      break;
    }
    case 'set_auto_sweep': {
      const v = a.set_auto_sweep as ActionOf<'set_auto_sweep'>;
      w.string(v.asset)
        .u128(BigInt(v.trigger_above))
        .u128(BigInt(v.keep))
        .string(v.saved_address_id);
      break;
    }
    case 'clear_auto_sweep':
      w.string((a.clear_auto_sweep as ActionOf<'clear_auto_sweep'>).asset);
      break;
    case 'withdraw': {
      const v = a.withdraw as ActionOf<'withdraw'>;
      w.string(v.asset).u128(BigInt(v.amount)).string(v.saved_address_id);
      writeRoute(w, v.route);
      break;
    }
    case 'refund': {
      const v = a.refund as ActionOf<'refund'>;
      w.string(v.asset)
        .u128(BigInt(v.amount))
        .string(v.destination_chain)
        .string(v.destination)
        .string(v.payment_id);
      writeRoute(w, v.route);
      break;
    }
    case 'upgrade':
      w.fixed(b64((a.upgrade as ActionOf<'upgrade'>).code_hash), 32);
      break;
    case 'set_settlement': {
      const v = a.set_settlement as ActionOf<'set_settlement'>;
      w.string(v.dest_asset)
        .u8(v.payout_mode === 'intents' ? 0 : 1)
        .option(v.saved_address_id, (id) => w.string(id));
      break;
    }
  }
  return w.done();
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function hex32(h: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('expected 32 bytes of lower-case hex');
  return new Uint8Array(Buffer.from(h, 'hex'));
}

/** `sha256(borsh(action) ‖ salt)` as lower-case hex — the on-chain `ProposalId`. */
export function proposalId(action: ActionJson, salt: Uint8Array): string {
  if (salt.length !== 32) throw new Error('salt must be 32 bytes');
  return toHex(sha256(Buffer.concat([encodeAction(action), salt])));
}

export type ApprovalIntent = 'approve' | 'cancel';

export interface ApprovalInput {
  contractId: string;
  /** Lower-case hex of the 32-byte proposal (or recovery) id. */
  proposalId: string;
  signerEpoch: bigint;
  intent: ApprovalIntent;
}

/** borsh(ApprovalPayload). */
export function approvalPayload(p: ApprovalInput): Uint8Array {
  return new Writer()
    .string(APPROVAL_DOMAIN)
    .string(p.contractId)
    .fixed(hex32(p.proposalId), 32)
    .u64(p.signerEpoch)
    .u8(p.intent === 'approve' ? 0 : 1)
    .done();
}

/** The 32-byte WebAuthn challenge: `sha256(borsh(ApprovalPayload))`. */
export function approvalChallenge(p: ApprovalInput): Uint8Array {
  return sha256(approvalPayload(p));
}

/** The challenge as `clientDataJSON.challenge` carries it: base64url, no padding. */
export function challengeB64u(p: ApprovalInput): string {
  return Buffer.from(approvalChallenge(p)).toString('base64url');
}

/**
 * The id of the recovery started with `nonce` under `recoveryKeyEpoch`, as lower-case hex:
 * `sha256(borsh((RECOVERY_ID_DOMAIN, contract_id, recovery_key_epoch, nonce)))`. A signer cancels
 * a recovery with a `cancel` approval over this id.
 */
export function recoveryId(contractId: string, recoveryKeyEpoch: bigint, nonce: bigint): string {
  const bytes = new Writer()
    .string(RECOVERY_ID_DOMAIN)
    .string(contractId)
    .u64(recoveryKeyEpoch)
    .u64(nonce)
    .done();
  return toHex(sha256(bytes));
}

export interface RecoveryPayloadInput {
  contractId: string;
  newSigners: SignerJson[];
  newThreshold: number;
  nonce: bigint;
  recoveryKeyEpoch: bigint;
  /** Block time (ns) after which the payload can no longer start a recovery. */
  validUntil: bigint;
}

/** borsh(RecoveryPayload). */
export function encodeRecoveryPayload(p: RecoveryPayloadInput): Uint8Array {
  const w = new Writer().string(RECOVERY_DOMAIN).string(p.contractId);
  w.vec(p.newSigners, (s) => writeSigner(w, SignerSchema.parse(s)));
  return w.u8(p.newThreshold).u64(p.nonce).u64(p.recoveryKeyEpoch).u64(p.validUntil).done();
}

/** The 32-byte message the recovery key signs (Ed25519): `sha256(borsh(RecoveryPayload))`. */
export function recoveryMessage(p: RecoveryPayloadInput): Uint8Array {
  return sha256(encodeRecoveryPayload(p));
}

/**
 * A WebAuthn ES256 signature (DER) → the raw 64-byte `r‖s` the contract takes, with low s.
 * Authenticators may return a high-s signature; the contract rejects those (malleability), so the
 * relay flips `s = n − s`, which is an equally valid signature over the same message.
 */
export function normalizeP256Signature(der: Uint8Array): Uint8Array {
  const sig = p256.Signature.fromDER(der);
  return sig.normalizeS().toCompactRawBytes();
}
