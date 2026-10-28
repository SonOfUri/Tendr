// Base58 (Bitcoin alphabet), the encoding NEAR uses for code hashes and the one the publish script
// prints, so an upgrade's code hash reads the same on every screen and in every email.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** Standard (padded) base64 to bytes, in the browser and in Node. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes to standard (padded) base64, in the browser and in Node. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Base58 (Bitcoin alphabet) to bytes; throws on any other character. */
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...out]);
}
