/**
 * Manual check that Cloud KMS supports both curves Tendr signs with, through GcpKeyVault.
 * Not run in CI. Usage (needs GCP_PROJECT_ID, GCP_KMS_LOCATION, GCP_CREDENTIALS_JSON):
 *
 *   npm run kms:verify --workspace=@tendr/api
 *
 * Creates, if absent, key ring `tendr-verify` with a symmetric key `tendr-kek`, an
 * EC_SIGN_ED25519 key `verify-ed25519` and an EC_SIGN_SECP256K1_SHA256 key `verify-secp256k1`
 * (HSM, falling back to SOFTWARE with a warning when HSM rejects the algorithm), then runs:
 * envelope encrypt/decrypt, an Ed25519 signature check, and a secp256k1 ecrecover check.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyManagementServiceClient, type protos } from '@google-cloud/kms';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { GcpKeyVault } from '../src/keyvault/gcp.js';
import { nearPublicKey } from '../src/keyvault/keys.js';
import { evmAddress } from '../src/keyvault/secp256k1.js';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';

type Algorithm = keyof typeof protos.google.cloud.kms.v1.CryptoKeyVersion.CryptoKeyVersionAlgorithm;
type Purpose = keyof typeof protos.google.cloud.kms.v1.CryptoKey.CryptoKeyPurpose;

const KEY_RING = 'tendr-verify';
const KEK = 'tendr-kek';
const ED_KEY = 'verify-ed25519';
const K1_KEY = 'verify-secp256k1';
const INVALID_ARGUMENT = 3;
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;
const FAILED_PRECONDITION = 9;

loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FAILED: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

const projectId = requireEnv('GCP_PROJECT_ID');
const location = requireEnv('GCP_KMS_LOCATION');
const credentials = JSON.parse(requireEnv('GCP_CREDENTIALS_JSON')) as Record<string, string>;
const client = new KeyManagementServiceClient({ projectId, credentials });

const codeOf = (err: unknown): number | undefined => (err as { code?: number }).code;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ensureKeyRing(): Promise<string> {
  const name = client.keyRingPath(projectId, location, KEY_RING);
  try {
    await client.getKeyRing({ name });
    console.log(`key ring ${KEY_RING}: exists`);
  } catch (err) {
    if (codeOf(err) !== NOT_FOUND) throw err;
    await client.createKeyRing({
      parent: client.locationPath(projectId, location),
      keyRingId: KEY_RING,
      keyRing: {},
    });
    console.log(`key ring ${KEY_RING}: created`);
  }
  return name;
}

async function createKey(
  parent: string,
  id: string,
  purpose: Purpose,
  algorithm: Algorithm,
  protectionLevel: 'HSM' | 'SOFTWARE',
): Promise<void> {
  await client.createCryptoKey({
    parent,
    cryptoKeyId: id,
    cryptoKey: { purpose, versionTemplate: { algorithm, protectionLevel } },
  });
}

/** Ensures the key exists (HSM first, SOFTWARE fallback) and its version 1 is ENABLED. */
async function ensureKey(
  parent: string,
  id: string,
  purpose: Purpose,
  algorithm: Algorithm,
): Promise<void> {
  const name = `${parent}/cryptoKeys/${id}`;
  try {
    const [key] = await client.getCryptoKey({ name });
    console.log(`key ${id}: exists (${String(key.versionTemplate?.protectionLevel)})`);
  } catch (err) {
    if (codeOf(err) !== NOT_FOUND) throw err;
    try {
      await createKey(parent, id, purpose, algorithm, 'HSM');
      console.log(`key ${id}: created (HSM, ${algorithm})`);
    } catch (hsmErr) {
      const code = codeOf(hsmErr);
      if (code === ALREADY_EXISTS) {
        console.log(`key ${id}: exists`);
      } else if (code === INVALID_ARGUMENT || code === FAILED_PRECONDITION) {
        // Only a request-level rejection (e.g. algorithm unsupported at HSM level) falls back.
        // Quota, permission, location and transient errors are rethrown so a SOFTWARE key is
        // never created by accident.
        console.warn(
          `WARNING: HSM key creation failed for ${id} (code ${code}: ${(hsmErr as Error).message}) — falling back to SOFTWARE`,
        );
        await createKey(parent, id, purpose, algorithm, 'SOFTWARE');
        console.log(`key ${id}: created (SOFTWARE, ${algorithm})`);
      } else {
        throw hsmErr;
      }
    }
  }
  if (purpose !== 'ASYMMETRIC_SIGN') return;
  const version = `${name}/cryptoKeyVersions/1`;
  for (let i = 0; i < 30; i++) {
    const [v] = await client.getCryptoKeyVersion({ name: version });
    if (v.state === 'ENABLED') return;
    if (v.state !== 'PENDING_GENERATION') {
      throw new Error(`${id} version 1 is ${String(v.state)}, expected ENABLED`);
    }
    await sleep(2_000);
  }
  throw new Error(`${id} version 1 did not become ENABLED within 60s`);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

async function run(): Promise<void> {
  await check('setup (key ring and keys)', async () => {
    const ring = await ensureKeyRing();
    await ensureKey(ring, KEK, 'ENCRYPT_DECRYPT', 'GOOGLE_SYMMETRIC_ENCRYPTION');
    await ensureKey(ring, ED_KEY, 'ASYMMETRIC_SIGN', 'EC_SIGN_ED25519');
    await ensureKey(ring, K1_KEY, 'ASYMMETRIC_SIGN', 'EC_SIGN_SECP256K1_SHA256');
  });

  const vault = new GcpKeyVault({
    client,
    projectId,
    location,
    keyRing: KEY_RING,
    kekKey: KEK,
    keyIds: { 'relayer-near': ED_KEY, 'relayer-evm': K1_KEY },
  });

  await check('envelope encrypt/decrypt round trip', async () => {
    const envelope = await vault.encrypt(utf8ToBytes('tendr kms verify'), 'sec_verify');
    const back = Buffer.from(await vault.decrypt(envelope, 'sec_verify')).toString('utf8');
    if (back !== 'tendr kms verify') throw new Error('decrypted plaintext differs');
    const wrongAad = await vault.decrypt(envelope, 'sec_other').then(
      () => true,
      () => false,
    );
    if (wrongAad) throw new Error('decrypt succeeded with the wrong aad');
  });

  await check('Ed25519 signature verifies against the KMS public key', async () => {
    const msg = sha256(utf8ToBytes('tendr near tx'));
    const sig = await vault.sign('relayer-near', msg);
    if (sig.curve !== 'ed25519') throw new Error('expected an ed25519 signature');
    const { raw } = await vault.publicKey('relayer-near');
    if (!ed25519.verify(sig.signature, msg, raw)) throw new Error('ed25519.verify returned false');
    console.log(`  NEAR public key: ${nearPublicKey(raw)}`);
  });

  await check('secp256k1 signature over keccak256 recovers to the KMS EVM address', async () => {
    const digest = keccak_256(utf8ToBytes('tendr evm tx'));
    const sig = await vault.sign('relayer-evm', digest);
    if (sig.curve !== 'secp256k1') throw new Error('expected a secp256k1 signature');
    const recovered = secp256k1.Signature.fromCompact(concatBytes(sig.r, sig.s))
      .addRecoveryBit(sig.v)
      .recoverPublicKey(digest)
      .toRawBytes(false);
    const { raw } = await vault.publicKey('relayer-evm');
    if (evmAddress(recovered) !== evmAddress(raw)) throw new Error('recovered address differs');
    console.log(`  EVM address: ${evmAddress(raw)}`);
  });

  console.log('ALL CHECKS PASSED');
}

/** Runs the checks, always closes the KMS client (its grpc channel keeps the process alive), then exits. */
async function main(): Promise<never> {
  let code = 0;
  try {
    await run();
  } catch (err) {
    console.error(`FAILED: ${(err as Error).message}`);
    code = 1;
  }
  try {
    await client.close();
  } catch (err) {
    console.error(`WARNING: closing the KMS client failed: ${(err as Error).message}`);
  }
  process.exit(code);
}

void main();
