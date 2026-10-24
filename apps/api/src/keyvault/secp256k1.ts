import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

const N = secp256k1.CURVE.n;
const HALF_N = N / 2n;

function bytesToBigInt(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt('0x' + bytesToHex(b));
}

function bigIntTo32(x: bigint): Uint8Array {
  const hex = x.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Reads one DER INTEGER at `at`; returns its value and the offset after it. */
function readDerInt(der: Uint8Array, at: number): { value: bigint; next: number } {
  if (der[at] !== 0x02) throw new Error('Invalid DER signature: expected INTEGER');
  const len = der[at + 1];
  if (len === undefined || len === 0 || len > 33)
    throw new Error('Invalid DER signature: bad INTEGER length');
  const start = at + 2;
  const end = start + len;
  if (end > der.length) throw new Error('Invalid DER signature: truncated INTEGER');
  const bytes = der.subarray(start, end);
  if ((bytes[0] ?? 0) & 0x80) throw new Error('Invalid DER signature: negative INTEGER');
  return { value: bytesToBigInt(bytes), next: end };
}

function parseDer(der: Uint8Array): { r: bigint; s: bigint } {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) {
    throw new Error('Invalid DER signature: bad SEQUENCE');
  }
  const r = readDerInt(der, 2);
  const s = readDerInt(der, r.next);
  if (s.next !== der.length) throw new Error('Invalid DER signature: trailing bytes');
  if (r.value <= 0n || r.value >= N || s.value <= 0n || s.value >= N) {
    throw new Error('Invalid DER signature: r or s out of range');
  }
  return { r: r.value, s: s.value };
}

/**
 * Converts a DER secp256k1 signature (what Cloud KMS returns) into Ethereum-style r, s, v:
 * r/s left-padded to 32 bytes, s normalised to the low half (s → n − s, which flips the
 * recovery parity), and v found by recovering against `pub65` with both candidates.
 */
export function derToRsv(
  der: Uint8Array,
  digest: Uint8Array,
  pub65: Uint8Array,
): { r: Uint8Array; s: Uint8Array; v: 0 | 1 } {
  if (digest.length !== 32) throw new Error('secp256k1 signing requires a 32-byte digest');
  if (pub65.length !== 65 || pub65[0] !== 0x04) {
    throw new Error('Expected a 65-byte uncompressed secp256k1 public key');
  }
  const { r, s: rawS } = parseDer(der);
  let s = rawS;
  // Using n − s instead of s negates the signature's R-point parity; trying both recovery
  // ids below against the low-s value accounts for that flip.
  if (s > HALF_N) s = N - s;
  const sig = new secp256k1.Signature(r, s);
  for (const v of [0, 1] as const) {
    let recovered: Uint8Array;
    try {
      recovered = sig.addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    } catch {
      continue;
    }
    if (equalBytes(recovered, pub65)) return { r: bigIntTo32(r), s: bigIntTo32(s), v };
  }
  throw new Error('secp256k1 signature does not recover to the given public key');
}

/** `0x` + last 20 bytes of keccak256(pub[1:]), lower-case. */
export function evmAddress(pub65: Uint8Array): string {
  if (pub65.length !== 65 || pub65[0] !== 0x04) {
    throw new Error('Expected a 65-byte uncompressed secp256k1 public key');
  }
  return '0x' + bytesToHex(keccak_256(pub65.subarray(1)).subarray(12));
}
