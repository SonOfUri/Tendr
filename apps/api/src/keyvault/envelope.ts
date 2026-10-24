import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Envelope } from './types.js';

/**
 * The AES-256-GCM data layer shared by every key vault. A fresh 32-byte DEK encrypts the
 * plaintext with `aad` bound; each vault wraps the DEK with its own KEK.
 */

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const DEK_BYTES = 32;

export const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
export const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');

export function gcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: string,
): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

export function gcmDecrypt(
  key: Uint8Array,
  iv: Buffer,
  tag: Buffer,
  ct: Buffer,
  aad?: string,
): Buffer {
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function parseEnvelope(serialized: string): Envelope {
  const e = JSON.parse(serialized) as Partial<Envelope>;
  if (
    e.v !== 1 ||
    typeof e.kek !== 'string' ||
    typeof e.wrappedDek !== 'string' ||
    typeof e.iv !== 'string' ||
    typeof e.tag !== 'string' ||
    typeof e.ct !== 'string'
  ) {
    throw new Error('Invalid envelope');
  }
  return e as Envelope;
}

/**
 * Encrypts `plaintext` under a fresh DEK (aad bound), wraps the DEK with `wrapDek`, and
 * returns the serialized envelope. The DEK is zeroed afterwards.
 */
export async function sealEnvelope(
  kek: string,
  plaintext: Uint8Array,
  aad: string,
  wrapDek: (dek: Buffer) => Promise<Uint8Array> | Uint8Array,
): Promise<string> {
  const dek = randomBytes(DEK_BYTES);
  try {
    const data = gcmEncrypt(dek, plaintext, aad);
    const envelope: Envelope = {
      v: 1,
      kek,
      wrappedDek: b64(await wrapDek(dek)),
      iv: b64(data.iv),
      tag: b64(data.tag),
      ct: b64(data.ct),
    };
    return JSON.stringify(envelope);
  } finally {
    dek.fill(0);
  }
}

/**
 * Parses an envelope, checks it belongs to `kek`, unwraps the DEK with `unwrapDek`, and
 * decrypts the data (aad bound). The DEK is zeroed afterwards.
 */
export async function openEnvelope(
  kek: string,
  serialized: string,
  aad: string,
  unwrapDek: (wrapped: Buffer) => Promise<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  const e = parseEnvelope(serialized);
  if (e.kek !== kek) throw new Error(`Envelope KEK "${e.kek}" is not this vault's KEK "${kek}"`);
  const dek = Buffer.from(await unwrapDek(unb64(e.wrappedDek)));
  try {
    if (dek.length !== DEK_BYTES) throw new Error('Invalid envelope: bad DEK length');
    return new Uint8Array(gcmDecrypt(dek, unb64(e.iv), unb64(e.tag), unb64(e.ct), aad));
  } finally {
    dek.fill(0);
  }
}
