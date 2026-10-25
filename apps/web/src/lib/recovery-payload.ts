// The bytes a recovery kit signs to start a recovery: sha256(borsh(RecoveryPayload)), mirrored
// from the contract (onchain/merchant-account/src/recovery.rs) and the API
// (apps/api/src/accounts/encoding.ts). Tied to both by the shared test vectors in
// onchain/merchant-account/test-vectors/recovery-payloads.json (recovery-payload.test.ts).
import { sha256 } from '@noble/hashes/sha256';
import type { SignerKey } from './api';

export const RECOVERY_DOMAIN = 'tendr-merchant-account-recovery-v1';

export interface RecoverySigner {
  id: string;
  keys: SignerKey[];
}

export interface RecoveryPayloadInput {
  contractId: string;
  newSigners: RecoverySigner[];
  newThreshold: number;
  nonce: bigint;
  recoveryKeyEpoch: bigint;
  /** Block time in nanoseconds after which the payload no longer starts a recovery. */
  validUntil: bigint;
}

class Writer {
  private readonly parts: number[] = [];
  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }
  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('u8 out of range');
    this.parts.push(n);
    return this;
  }
  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return this.bytes(b);
  }
  u64(n: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return this.bytes(b);
  }
  string(s: string): this {
    const b = new TextEncoder().encode(s);
    return this.u32(b.length).bytes(b);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function writeKey(w: Writer, key: SignerKey): void {
  if ('p256' in key) {
    const b = fromBase64(key.p256);
    if (b.length !== 33) throw new Error('a p256 signer key is 33 bytes');
    w.u8(0).bytes(b);
  } else {
    const b = fromBase64(key.ed25519);
    if (b.length !== 32) throw new Error('an ed25519 signer key is 32 bytes');
    w.u8(1).bytes(b);
  }
}

/** borsh(RecoveryPayload). */
export function encodeRecoveryPayload(p: RecoveryPayloadInput): Uint8Array {
  const w = new Writer().string(RECOVERY_DOMAIN).string(p.contractId);
  w.u32(p.newSigners.length);
  for (const s of p.newSigners) {
    w.string(s.id).u32(s.keys.length);
    for (const k of s.keys) writeKey(w, k);
  }
  return w.u8(p.newThreshold).u64(p.nonce).u64(p.recoveryKeyEpoch).u64(p.validUntil).done();
}

/** The 32-byte message the recovery kit signs (Ed25519). */
export function recoveryMessage(p: RecoveryPayloadInput): Uint8Array {
  return sha256(encodeRecoveryPayload(p));
}

/** How long a signed recovery request stays usable: 24 hours. */
export const RECOVERY_VALIDITY_MS = 24 * 3_600_000;

/** `Date.now() + 24 h` as block-time nanoseconds. */
export function validUntilNs(nowMs: number = Date.now()): bigint {
  return BigInt(nowMs + RECOVERY_VALIDITY_MS) * 1_000_000n;
}
