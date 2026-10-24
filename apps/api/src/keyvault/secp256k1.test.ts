import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import { derToRsv, evmAddress } from './secp256k1.js';

const N = secp256k1.CURVE.n;
const toHex32 = (x: bigint): string => x.toString(16).padStart(64, '0');

/** Minimal DER encoder for test inputs (adds a 0x00 pad when the high bit is set). */
function derInt(x: bigint): number[] {
  let h = x.toString(16);
  if (h.length % 2) h = '0' + h;
  const b = [...hexToBytes(h)];
  if ((b[0] ?? 0) & 0x80) b.unshift(0);
  return [0x02, b.length, ...b];
}
function der(r: bigint, s: bigint): Uint8Array {
  const body = [...derInt(r), ...derInt(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

function recover(digest: Uint8Array, rsv: { r: Uint8Array; s: Uint8Array; v: 0 | 1 }): Uint8Array {
  return new secp256k1.Signature(BigInt('0x' + bytesToHex(rsv.r)), BigInt('0x' + bytesToHex(rsv.s)))
    .addRecoveryBit(rsv.v)
    .recoverPublicKey(digest)
    .toRawBytes(false);
}

describe('derToRsv', () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false);

  it('derToRsv normalises high-s and finds v', () => {
    for (let i = 0; i < 16; i++) {
      const digest = keccak_256(utf8ToBytes(`msg ${i}`));
      const sig = secp256k1.sign(digest, priv, { lowS: true });
      const highS = N - sig.s;
      expect(highS > N / 2n).toBe(true);
      const rsv = derToRsv(der(sig.r, highS), digest, pub);
      expect(rsv.r.length).toBe(32);
      expect(rsv.s.length).toBe(32);
      expect(bytesToHex(rsv.s)).toBe(toHex32(sig.s));
      expect(rsv.v).toBe(sig.recovery);
      expect(evmAddress(recover(digest, rsv))).toBe(evmAddress(pub));
    }
  });

  it('passes a low-s signature through and finds v', () => {
    const digest = keccak_256(utf8ToBytes('low'));
    const sig = secp256k1.sign(digest, priv, { lowS: true });
    const rsv = derToRsv(sig.toDERRawBytes(), digest, pub);
    expect(bytesToHex(rsv.r)).toBe(toHex32(sig.r));
    expect(bytesToHex(rsv.s)).toBe(toHex32(sig.s));
    expect(rsv.v).toBe(sig.recovery);
  });

  it('left-pads a short (minimally encoded) integer to 32 bytes', () => {
    // About 1 in 128 signatures has r or s below 2^248, which DER encodes in fewer than 32 bytes.
    for (let i = 0; i < 5000; i++) {
      const digest = keccak_256(utf8ToBytes(`short ${i}`));
      const sig = secp256k1.sign(digest, priv, { lowS: true });
      if (sig.r >= 1n << 248n && sig.s >= 1n << 248n) continue;
      const rsv = derToRsv(sig.toDERRawBytes(), digest, pub);
      expect(bytesToHex(rsv.r)).toBe(toHex32(sig.r));
      expect(bytesToHex(rsv.s)).toBe(toHex32(sig.s));
      expect(rsv.v).toBe(sig.recovery);
      return;
    }
    throw new Error('no short-integer signature found');
  });

  it('throws when neither recovery id matches the public key', () => {
    const digest = keccak_256(utf8ToBytes('other'));
    const sig = secp256k1.sign(digest, priv, { lowS: true });
    const otherPub = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false);
    expect(() => derToRsv(sig.toDERRawBytes(), digest, otherPub)).toThrow(/recover/);
  });

  it('rejects malformed DER and wrong-length digests', () => {
    const digest = keccak_256(utf8ToBytes('bad'));
    const sig = secp256k1.sign(digest, priv, { lowS: true });
    expect(() => derToRsv(Uint8Array.from([0x31, 0]), digest, pub)).toThrow(/DER/);
    expect(() => derToRsv(sig.toDERRawBytes().slice(0, 10), digest, pub)).toThrow(/DER/);
    expect(() => derToRsv(der(0n, sig.s), digest, pub)).toThrow(/DER/);
    expect(() => derToRsv(sig.toDERRawBytes(), digest.slice(0, 31), pub)).toThrow(/32-byte/);
  });

  it('evmAddress matches a known vector', () => {
    // Private key 1 → G; its Ethereum address is well known.
    const g = secp256k1.getPublicKey(hexToBytes(toHex32(1n)), false);
    expect(evmAddress(g)).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  });
});
