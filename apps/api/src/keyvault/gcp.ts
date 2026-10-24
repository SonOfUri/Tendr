import { createPublicKey } from 'node:crypto';
import type { KeyManagementServiceClient } from '@google-cloud/kms';
import { crc32c } from './crc32c.js';
import { openEnvelope, sealEnvelope } from './envelope.js';
import { curveOf } from './keys.js';
import { derToRsv } from './secp256k1.js';
import type { Curve, KeyName, KeyVault, Signature } from './types.js';

/** The four Cloud KMS calls the vault makes (a real `KeyManagementServiceClient` satisfies it). */
export type KmsClient = Pick<
  KeyManagementServiceClient,
  'asymmetricSign' | 'getPublicKey' | 'encrypt' | 'decrypt'
>;

export interface GcpKeyVaultOptions {
  client: KmsClient;
  projectId: string;
  location: string;
  keyRing: string;
  /** Symmetric ENCRYPT_DECRYPT key that wraps DEKs; also recorded as the envelope `kek`. */
  kekKey: string;
  /** Cloud KMS key id per key name; defaults to the key name itself (verify script overrides). */
  keyIds?: Partial<Record<KeyName, string>>;
}

type Int64 = { value?: number | string | { toString(): string } | null } | null | undefined;

const checksum = (data: Uint8Array): { value: string } => ({ value: String(crc32c(data)) });

function toBytes(b: Uint8Array | string | null | undefined, what: string): Buffer {
  if (b === null || b === undefined) throw new Error(`Cloud KMS response is missing ${what}`);
  return typeof b === 'string' ? Buffer.from(b, 'base64') : Buffer.from(b);
}

function assertCrc(data: Uint8Array, expected: Int64, what: string): void {
  if (expected?.value === null || expected?.value === undefined) {
    throw new Error(`Cloud KMS response is missing the ${what} CRC32C`);
  }
  if (Number(String(expected.value)) !== crc32c(data)) {
    throw new Error(`Cloud KMS ${what} CRC32C mismatch (corrupted in transit)`);
  }
}

function assertVerified(flag: boolean | null | undefined, what: string): void {
  if (flag !== true) throw new Error(`Cloud KMS did not verify the request ${what} CRC32C`);
}

/** Raw public key bytes from a Cloud KMS SPKI PEM: ed25519 → 32 bytes, secp256k1 → 0x04‖x‖y. */
function rawPublicKey(pem: string, curve: Curve): Uint8Array {
  const jwk = createPublicKey(pem).export({ format: 'jwk' });
  if (curve === 'ed25519') {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
      throw new Error('Cloud KMS key is not an Ed25519 key');
    }
    const x = Buffer.from(jwk.x, 'base64url');
    if (x.length !== 32) throw new Error('Unexpected Ed25519 public key length');
    return new Uint8Array(x);
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1' || !jwk.x || !jwk.y) {
    throw new Error('Cloud KMS key is not a secp256k1 key');
  }
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.length !== 32 || y.length !== 32) throw new Error('Unexpected secp256k1 public key length');
  return new Uint8Array(Buffer.concat([Buffer.from([0x04]), x, y]));
}

/**
 * Production key vault on Google Cloud KMS. Each `KeyName` is a Cloud KMS key of the same
 * name in one key ring (version 1): ed25519 keys are `EC_SIGN_ED25519` (raw `data` signed),
 * secp256k1 keys are `EC_SIGN_SECP256K1_SHA256` (any 32-byte pre-hashed digest signed — keccak256
 * for EVM, sha256 for Tron). Secrets are envelope-encrypted locally with AES-256-GCM; only
 * the DEK goes to KMS, wrapped by the symmetric `kekKey`. Every call carries and checks CRC32C.
 */
export class GcpKeyVault implements KeyVault {
  private readonly client: KmsClient;
  private readonly keyRingPath: string;
  private readonly kekKey: string;
  private readonly keyIds: Partial<Record<KeyName, string>>;
  private readonly publicKeys = new Map<KeyName, Promise<Uint8Array>>();

  constructor(opts: GcpKeyVaultOptions) {
    this.client = opts.client;
    this.keyRingPath = `projects/${opts.projectId}/locations/${opts.location}/keyRings/${opts.keyRing}`;
    this.kekKey = opts.kekKey;
    this.keyIds = opts.keyIds ?? {};
  }

  async encrypt(plaintext: Uint8Array, aad: string): Promise<string> {
    return sealEnvelope(this.kekKey, plaintext, aad, async (dek) => {
      const name = this.keyPath(this.kekKey);
      const [res] = await this.client.encrypt({
        name,
        plaintext: dek,
        plaintextCrc32c: checksum(dek),
      });
      assertVerified(res.verifiedPlaintextCrc32c, 'plaintext');
      const ciphertext = toBytes(res.ciphertext, 'ciphertext');
      assertCrc(ciphertext, res.ciphertextCrc32c, 'ciphertext');
      return ciphertext;
    });
  }

  async decrypt(serialized: string, aad: string): Promise<Uint8Array> {
    return openEnvelope(this.kekKey, serialized, aad, async (wrapped) => {
      const [res] = await this.client.decrypt({
        name: this.keyPath(this.kekKey),
        ciphertext: wrapped,
        ciphertextCrc32c: checksum(wrapped),
      });
      const dek = toBytes(res.plaintext, 'plaintext');
      assertCrc(dek, res.plaintextCrc32c, 'plaintext');
      return dek;
    });
  }

  async sign(key: KeyName, payload: Uint8Array): Promise<Signature> {
    const name = this.versionPath(key);
    if (curveOf(key) === 'ed25519') {
      const [res] = await this.client.asymmetricSign({
        name,
        data: payload,
        dataCrc32c: checksum(payload),
      });
      const signature = this.checkSignResponse(res, name, () =>
        assertVerified(res.verifiedDataCrc32c, 'data'),
      );
      if (signature.length !== 64) throw new Error('Unexpected Ed25519 signature length');
      return { curve: 'ed25519', signature: new Uint8Array(signature) };
    }
    if (payload.length !== 32) throw new Error('secp256k1 signing requires a 32-byte digest');
    const [pub, [res]] = await Promise.all([
      this.publicKeyBytes(key),
      this.client.asymmetricSign({
        name,
        digest: { sha256: payload },
        digestCrc32c: checksum(payload),
      }),
    ]);
    const der = this.checkSignResponse(res, name, () =>
      assertVerified(res.verifiedDigestCrc32c, 'digest'),
    );
    const { r, s, v } = derToRsv(der, payload, pub);
    return { curve: 'secp256k1', r, s, v };
  }

  async publicKey(key: KeyName): Promise<{ curve: Curve; raw: Uint8Array }> {
    return { curve: curveOf(key), raw: await this.publicKeyBytes(key) };
  }

  /** Fetches and parses a key's public key once per process; a failed fetch is not cached. */
  private publicKeyBytes(key: KeyName): Promise<Uint8Array> {
    let cached = this.publicKeys.get(key);
    if (!cached) {
      cached = (async () => {
        const [res] = await this.client.getPublicKey({ name: this.versionPath(key) });
        if (!res.pem) throw new Error(`Cloud KMS returned no public key for ${key}`);
        assertCrc(Buffer.from(res.pem, 'utf8'), res.pemCrc32c, 'public key');
        return rawPublicKey(res.pem, curveOf(key));
      })();
      this.publicKeys.set(key, cached);
      cached.catch(() => this.publicKeys.delete(key));
    }
    return cached.then((raw) => new Uint8Array(raw));
  }

  private checkSignResponse(
    res: { name?: string | null; signature?: Uint8Array | string | null; signatureCrc32c?: Int64 },
    name: string,
    verifyRequest: () => void,
  ): Buffer {
    if (res.name !== name) throw new Error(`Cloud KMS signed with an unexpected key name`);
    verifyRequest();
    const signature = toBytes(res.signature, 'signature');
    assertCrc(signature, res.signatureCrc32c, 'signature');
    return signature;
  }

  private keyPath(keyName: string): string {
    return `${this.keyRingPath}/cryptoKeys/${keyName}`;
  }

  private versionPath(key: KeyName): string {
    return `${this.keyPath(this.keyIds[key] ?? key)}/cryptoKeyVersions/1`;
  }
}
