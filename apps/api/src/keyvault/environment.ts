import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  gcmDecrypt,
  gcmEncrypt,
  IV_BYTES,
  openEnvelope,
  sealEnvelope,
  TAG_BYTES,
} from './envelope.js';
import { curveOf, KEY_NAMES } from './keys.js';
import { derToRsv } from './secp256k1.js';
import type { Curve, KeyName, KeyVault, Signature } from './types.js';

type Bundle = { kek: Buffer; keys: Record<KeyName, Buffer> };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Errors deliberately contain no supplied values: this input contains private keys. */
function parseBundle(text: string): Bundle {
  const invalid = () =>
    new Error('Invalid ENV_KEYVAULT_JSON: supply a v1 bundle with distinct 32-byte base64 keys');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!object(data) || data.v !== 1 || !object(data.keys)) throw invalid();
  const decode = (value: unknown): Buffer => {
    if (typeof value !== 'string') throw invalid();
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== value || bytes.every((b) => b === 0)) {
      throw invalid();
    }
    return bytes;
  };
  if (Object.keys(data.keys).length !== KEY_NAMES.length) throw invalid();
  const kek = decode(data.kek);
  const seen = new Set([kek.toString('base64')]);
  const keys = {} as Record<KeyName, Buffer>;
  for (const name of KEY_NAMES) {
    const key = decode(data.keys[name]);
    if (seen.has(key.toString('base64'))) throw invalid();
    if (curveOf(name) === 'secp256k1' && !secp256k1.utils.isValidPrivateKey(key)) throw invalid();
    seen.add(key.toString('base64'));
    keys[name] = key;
  }
  return { kek, keys };
}

export function validEnvironmentKeyBundle(text: string): boolean {
  try {
    const bundle = parseBundle(text);
    bundle.kek.fill(0);
    for (const key of Object.values(bundle.keys)) key.fill(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit software vault for deployments without Cloud KMS. API and worker receive the same
 * immutable bundle from secret variables. No keys are generated at runtime or written to disk.
 * Unlike KMS, these private keys are present in the application process.
 */
export class EnvironmentKeyVault implements KeyVault {
  readonly #bundle: Bundle;
  readonly #kekId: string;

  constructor(serialized: string) {
    this.#bundle = parseBundle(serialized);
    this.#kekId = `env:${createHash('sha256').update(this.#bundle.kek).digest('hex')}`;
  }

  async encrypt(plaintext: Uint8Array, aad: string): Promise<string> {
    return sealEnvelope(this.#kekId, plaintext, aad, (dek) => {
      const wrapped = gcmEncrypt(this.#bundle.kek, dek);
      return Buffer.concat([wrapped.iv, wrapped.tag, wrapped.ct]);
    });
  }

  async decrypt(serialized: string, aad: string): Promise<Uint8Array> {
    return openEnvelope(this.#kekId, serialized, aad, (wrapped) =>
      gcmDecrypt(
        this.#bundle.kek,
        wrapped.subarray(0, IV_BYTES),
        wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
        wrapped.subarray(IV_BYTES + TAG_BYTES),
      ),
    );
  }

  async sign(name: KeyName, payload: Uint8Array): Promise<Signature> {
    const curve = curveOf(name);
    const key = this.#bundle.keys[name];
    if (curve === 'ed25519') return { curve, signature: ed25519.sign(payload, key) };
    if (payload.length !== 32) throw new Error('secp256k1 signing requires a 32-byte digest');
    const der = secp256k1.sign(payload, key, { lowS: false }).toDERRawBytes();
    return { curve, ...derToRsv(der, payload, secp256k1.getPublicKey(key, false)) };
  }

  async publicKey(name: KeyName): Promise<{ curve: Curve; raw: Uint8Array }> {
    const curve = curveOf(name);
    const key = this.#bundle.keys[name];
    return {
      curve,
      raw: curve === 'ed25519' ? ed25519.getPublicKey(key) : secp256k1.getPublicKey(key, false),
    };
  }
}
