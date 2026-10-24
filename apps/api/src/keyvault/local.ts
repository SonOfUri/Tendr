import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { curveOf } from './keys.js';
import { derToRsv } from './secp256k1.js';
import type { Curve, Envelope, KeyName, KeyVault, Signature } from './types.js';

const KEK_ID = 'local';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LOCK_TIMEOUT_MS = 5_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

interface KeyFile {
  v: 1;
  kek: string; // base64, 32 bytes
  keys: Partial<Record<KeyName, string>>; // base64 private keys
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');

function gcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmDecrypt(key: Uint8Array, iv: Buffer, tag: Buffer, ct: Buffer, aad?: string): Buffer {
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function parseEnvelope(serialized: string): Envelope {
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
 * Dev/test key vault backed by a JSON keyfile (mode 0600) holding a KEK and one private key
 * per key name, each created on first use. Refuses to run in production.
 *
 * Several processes (api + worker) may share one keyfile: it is created once via an atomic
 * link (first creator's KEK wins), every later write is temp-file + rename, key additions
 * merge under a lockfile, and a loaded KEK is never replaced.
 */
export class LocalKeyVault implements KeyVault {
  private file: KeyFile | null = null;

  constructor(private readonly path: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LocalKeyVault must not be used in production');
    }
  }

  async encrypt(plaintext: Uint8Array, aad: string): Promise<string> {
    const dek = randomBytes(32);
    try {
      const data = gcmEncrypt(dek, plaintext, aad);
      const wrapped = gcmEncrypt(this.kek(), dek);
      const envelope: Envelope = {
        v: 1,
        kek: KEK_ID,
        // Local DEK wrap is self-contained: iv || tag || ciphertext.
        wrappedDek: b64(Buffer.concat([wrapped.iv, wrapped.tag, wrapped.ct])),
        iv: b64(data.iv),
        tag: b64(data.tag),
        ct: b64(data.ct),
      };
      return JSON.stringify(envelope);
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(serialized: string, aad: string): Promise<Uint8Array> {
    const e = parseEnvelope(serialized);
    if (e.kek !== KEK_ID) throw new Error(`Envelope KEK "${e.kek}" is not the local KEK`);
    const w = unb64(e.wrappedDek);
    const dek = gcmDecrypt(
      this.kek(),
      w.subarray(0, IV_BYTES),
      w.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
      w.subarray(IV_BYTES + TAG_BYTES),
    );
    try {
      return new Uint8Array(gcmDecrypt(dek, unb64(e.iv), unb64(e.tag), unb64(e.ct), aad));
    } finally {
      dek.fill(0);
    }
  }

  async sign(key: KeyName, payload: Uint8Array): Promise<Signature> {
    const priv = this.privateKey(key);
    if (curveOf(key) === 'ed25519') {
      return { curve: 'ed25519', signature: ed25519.sign(payload, priv) };
    }
    if (payload.length !== 32) throw new Error('secp256k1 signing requires a 32-byte digest');
    // Go through DER → derToRsv, exactly as the Cloud KMS path does.
    const der = secp256k1.sign(payload, priv, { lowS: false }).toDERRawBytes();
    const { r, s, v } = derToRsv(der, payload, secp256k1.getPublicKey(priv, false));
    return { curve: 'secp256k1', r, s, v };
  }

  async publicKey(key: KeyName): Promise<{ curve: Curve; raw: Uint8Array }> {
    const curve = curveOf(key);
    const priv = this.privateKey(key);
    const raw =
      curve === 'ed25519' ? ed25519.getPublicKey(priv) : secp256k1.getPublicKey(priv, false);
    return { curve, raw };
  }

  private kek(): Buffer {
    return unb64(this.load().kek);
  }

  private privateKey(key: KeyName): Uint8Array {
    const cached = this.load().keys[key];
    if (cached) return unb64(cached);
    return this.withLock(() => {
      // Re-read under the lock: another process may have added this (or another) key.
      const file = this.adopt(this.readDisk() ?? this.fail('keyfile disappeared'));
      const existing = file.keys[key];
      if (existing) return unb64(existing);
      const priv =
        curveOf(key) === 'ed25519'
          ? ed25519.utils.randomPrivateKey()
          : secp256k1.utils.randomPrivateKey();
      const next: KeyFile = { ...file, keys: { ...file.keys, [key]: b64(priv) } };
      this.replaceFile(next);
      this.file = next;
      return priv;
    });
  }

  /** Loads the keyfile, creating it exactly once across processes (first creator's KEK wins). */
  private load(): KeyFile {
    if (this.file) return this.file;
    const onDisk = this.readDisk();
    if (onDisk) return this.adopt(onDisk);
    const fresh: KeyFile = { v: 1, kek: b64(randomBytes(32)), keys: {} };
    if (this.createExclusive(fresh)) return this.adopt(fresh);
    // Lost the creation race: use the winner's file, never our own KEK.
    return this.adopt(this.readDisk() ?? this.fail('keyfile missing after EEXIST'));
  }

  /** Accepts a freshly read file, refusing to switch KEK under an already-loaded one. */
  private adopt(file: KeyFile): KeyFile {
    if (this.file && this.file.kek !== file.kek) {
      throw new Error(`Local keyvault KEK at ${this.path} changed underneath this process`);
    }
    this.file = file;
    return file;
  }

  private readDisk(): KeyFile | null {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const parsed = JSON.parse(text) as KeyFile;
    if (parsed.v !== 1 || typeof parsed.kek !== 'string' || typeof parsed.keys !== 'object') {
      throw new Error(`Invalid local keyvault file at ${this.path}`);
    }
    return parsed;
  }

  /** Writes a complete temp file (0600) next to the keyfile and returns its path. */
  private writeTemp(file: KeyFile): string {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600, flag: 'wx' });
    return tmp;
  }

  /** Atomic create-if-absent: hard-link a complete temp file into place (fails on EEXIST). */
  private createExclusive(file: KeyFile): boolean {
    const tmp = this.writeTemp(file);
    try {
      linkSync(tmp, this.path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Atomic replace: readers see the old or the new file, never a partial one. */
  private replaceFile(file: KeyFile): void {
    const tmp = this.writeTemp(file);
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** Serialises key additions across processes with an O_EXCL lockfile. */
  private withLock<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${lock}; remove it if no process holds it`);
        }
        Atomics.wait(SLEEP, 0, 0, 10);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  private fail(reason: string): never {
    throw new Error(`Local keyvault at ${this.path}: ${reason}`);
  }
}
