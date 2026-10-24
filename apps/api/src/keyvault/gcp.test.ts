import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it, vi } from 'vitest';
import { crc32c } from './crc32c.js';
import { GcpKeyVault, type KmsClient } from './gcp.js';
import { evmAddress } from './secp256k1.js';

const PREFIX = 'projects/p1/locations/global/keyRings/ring1/cryptoKeys';
const versionPath = (key: string): string => `${PREFIX}/${key}/cryptoKeyVersions/1`;
const KEK_PATH = `${PREFIX}/tendr-kek`;

const crc = (b: Uint8Array | string): { value: string } => ({
  value: String(crc32c(typeof b === 'string' ? Buffer.from(b, 'utf8') : b)),
});

interface Keys {
  ed: { priv: KeyObject; pem: string };
  k1: { priv: Uint8Array; pem: string };
}

function makeKeys(): Keys {
  const ed = generateKeyPairSync('ed25519');
  const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const d = k1.privateKey.export({ format: 'jwk' }).d!;
  return {
    ed: {
      priv: ed.privateKey,
      pem: ed.publicKey.export({ format: 'pem', type: 'spki' }) as string,
    },
    k1: {
      priv: Uint8Array.from(Buffer.from(d, 'base64url')),
      pem: k1.publicKey.export({ format: 'pem', type: 'spki' }) as string,
    },
  };
}

/** The request fields the stub reads (each call sets only the ones it needs). */
interface Req {
  name: string;
  data: Uint8Array;
  digest: { sha256: Uint8Array };
  plaintext: Uint8Array;
  ciphertext: Uint8Array;
  dataCrc32c?: { value: string };
  digestCrc32c?: { value: string };
  plaintextCrc32c?: { value: string };
  ciphertextCrc32c?: { value: string };
}

const ED_KEYS = new Set(['relayer-near', 'funding-near', 'solver-hot', 'verify-ed25519']);

/** In-memory stand-in for Cloud KMS with correct CRC32C behaviour; `tamper` corrupts responses. */
function stubClient(keys: Keys, tamper: Partial<Record<string, boolean>> = {}) {
  const kmsKey = randomBytes(32);
  const keyOf = (name: string): string => name.split('/')[7]!;
  const client = {
    asymmetricSign: vi.fn(async (req: Req) => {
      const key = keyOf(req.name);
      let signature: Buffer;
      if (ED_KEYS.has(key)) {
        signature = nodeSign(null, Buffer.from(req.data), keys.ed.priv);
      } else {
        const digest = req.digest.sha256;
        // KMS returns DER and does not normalise s.
        signature = Buffer.from(
          secp256k1.sign(digest, keys.k1.priv, { lowS: false }).toDERRawBytes(),
        );
      }
      if (tamper.signBytes) signature[signature.length - 1]! ^= 1;
      const verifiedDigest = req.digestCrc32c
        ? Number(req.digestCrc32c.value) === crc32c(req.digest.sha256)
        : false;
      const verifiedData = req.dataCrc32c
        ? Number(req.dataCrc32c.value) === crc32c(req.data)
        : false;
      return [
        {
          name: tamper.signName ? versionPath('other') : req.name,
          signature,
          signatureCrc32c: tamper.signNoCrc
            ? undefined
            : crc(tamper.signBytes ? Buffer.from('x') : signature),
          verifiedDigestCrc32c: tamper.signVerified ? false : verifiedDigest,
          verifiedDataCrc32c: tamper.signVerified ? false : verifiedData,
        },
      ];
    }),
    getPublicKey: vi.fn(async (req: { name: string }) => {
      const pem = ED_KEYS.has(keyOf(req.name)) ? keys.ed.pem : keys.k1.pem;
      return [{ name: req.name, pem, pemCrc32c: crc(tamper.pem ? pem + 'x' : pem) }];
    }),
    encrypt: vi.fn(async (req: Req) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', kmsKey, iv);
      const ct = Buffer.concat([c.update(req.plaintext), c.final(), c.getAuthTag(), iv]);
      return [
        {
          name: `${req.name}/cryptoKeyVersions/1`,
          ciphertext: ct,
          ciphertextCrc32c: crc(tamper.encryptCrc ? Buffer.from('x') : ct),
          verifiedPlaintextCrc32c:
            !tamper.encryptVerified && Number(req.plaintextCrc32c?.value) === crc32c(req.plaintext),
        },
      ];
    }),
    decrypt: vi.fn(async (req: Req) => {
      if (Number(req.ciphertextCrc32c?.value) !== crc32c(req.ciphertext)) {
        throw new Error('ciphertext crc mismatch');
      }
      const buf = Buffer.from(req.ciphertext);
      const iv = buf.subarray(buf.length - 12);
      const tag = buf.subarray(buf.length - 28, buf.length - 12);
      const d = createDecipheriv('aes-256-gcm', kmsKey, iv);
      d.setAuthTag(tag);
      const plaintext = Buffer.concat([d.update(buf.subarray(0, buf.length - 28)), d.final()]);
      return [
        { plaintext, plaintextCrc32c: crc(tamper.decryptCrc ? Buffer.from('x') : plaintext) },
      ];
    }),
  };
  return client;
}

function vault(client: ReturnType<typeof stubClient>): GcpKeyVault {
  return new GcpKeyVault({
    client: client as unknown as KmsClient,
    projectId: 'p1',
    location: 'global',
    keyRing: 'ring1',
    kekKey: 'tendr-kek',
  });
}

describe('crc32c', () => {
  it('matches the RFC 3720 check value', () => {
    expect(crc32c(utf8ToBytes('123456789'))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
  });
});

describe('GcpKeyVault', () => {
  const keys = makeKeys();

  it('signs a secp256k1 digest via asymmetricSign and returns derToRsv output', async () => {
    const client = stubClient(keys);
    const kv = vault(client);
    const digest = keccak_256(utf8ToBytes('evm tx'));
    const sig = await kv.sign('relayer-evm', digest);
    expect(client.asymmetricSign).toHaveBeenCalledWith({
      name: versionPath('relayer-evm'),
      digest: { sha256: digest },
      digestCrc32c: { value: String(crc32c(digest)) },
    });
    if (sig.curve !== 'secp256k1') throw new Error('expected secp256k1');
    expect(sig.r.length).toBe(32);
    expect(BigInt('0x' + Buffer.from(sig.s).toString('hex')) <= secp256k1.CURVE.n / 2n).toBe(true);
    const recovered = secp256k1.Signature.fromCompact(concatBytes(sig.r, sig.s))
      .addRecoveryBit(sig.v)
      .recoverPublicKey(digest)
      .toRawBytes(false);
    const { raw } = await kv.publicKey('relayer-evm');
    expect(evmAddress(recovered)).toBe(evmAddress(raw));
  });

  it('rejects a secp256k1 payload that is not a 32-byte digest', async () => {
    const kv = vault(stubClient(keys));
    await expect(kv.sign('gas-tron', utf8ToBytes('not a digest'))).rejects.toThrow(/32-byte/);
  });

  it('signs ed25519 raw data via asymmetricSign', async () => {
    const client = stubClient(keys);
    const kv = vault(client);
    const msg = sha256(utf8ToBytes('near tx'));
    const sig = await kv.sign('funding-near', msg);
    expect(client.asymmetricSign).toHaveBeenCalledWith({
      name: versionPath('funding-near'),
      data: msg,
      dataCrc32c: { value: String(crc32c(msg)) },
    });
    if (sig.curve !== 'ed25519') throw new Error('expected ed25519');
    expect(sig.signature.length).toBe(64);
    const { raw } = await kv.publicKey('funding-near');
    expect(ed25519.verify(sig.signature, msg, raw)).toBe(true);
  });

  it('parses PEM public keys into raw bytes and caches them per key', async () => {
    const client = stubClient(keys);
    const kv = vault(client);
    const ed = await kv.publicKey('relayer-near');
    expect(ed.curve).toBe('ed25519');
    expect(ed.raw.length).toBe(32);
    const k1 = await kv.publicKey('relayer-evm');
    expect(k1.curve).toBe('secp256k1');
    expect(k1.raw.length).toBe(65);
    expect(k1.raw[0]).toBe(0x04);
    await kv.publicKey('relayer-evm');
    expect(client.getPublicKey).toHaveBeenCalledTimes(2);
    expect(client.getPublicKey).toHaveBeenCalledWith({ name: versionPath('relayer-near') });
  });

  it('wraps the DEK with the KEK and round-trips with aad bound', async () => {
    const client = stubClient(keys);
    const kv = vault(client);
    const env = await kv.encrypt(Buffer.from('whsec_abc'), 'sec_1');
    expect(client.encrypt).toHaveBeenCalledWith({
      name: KEK_PATH,
      plaintext: expect.any(Uint8Array),
      plaintextCrc32c: { value: expect.any(String) },
    });
    const dek = client.encrypt.mock.calls[0]![0].plaintext as Uint8Array;
    expect(dek.length).toBe(32);
    expect(env).not.toContain('whsec_abc');
    expect(JSON.parse(env)).toMatchObject({ v: 1, kek: 'tendr-kek' });
    expect(Buffer.from(await kv.decrypt(env, 'sec_1')).toString()).toBe('whsec_abc');
    expect(client.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({ name: KEK_PATH, ciphertextCrc32c: expect.any(Object) }),
    );
    await expect(kv.decrypt(env, 'sec_2')).rejects.toThrow();
  });

  it('maps key names to custom Cloud KMS key ids', async () => {
    const client = stubClient(keys);
    const kv = new GcpKeyVault({
      client: client as unknown as KmsClient,
      projectId: 'p1',
      location: 'global',
      keyRing: 'ring1',
      kekKey: 'tendr-kek',
      keyIds: { 'relayer-near': 'verify-ed25519' },
    });
    await kv.sign('relayer-near', utf8ToBytes('m'));
    expect(client.asymmetricSign.mock.calls[0]![0].name).toBe(versionPath('verify-ed25519'));
  });

  it('rejects an envelope from another KEK', async () => {
    const kv = vault(stubClient(keys));
    const env = { ...JSON.parse(await kv.encrypt(Buffer.from('x'), 'sec_1')), kek: 'local' };
    await expect(kv.decrypt(JSON.stringify(env), 'sec_1')).rejects.toThrow(/KEK/);
  });

  describe('CRC32C integrity', () => {
    const digest = keccak_256(utf8ToBytes('d'));
    const cases: [string, RegExp, (kv: GcpKeyVault) => Promise<unknown>][] = [
      ['signBytes', /signature CRC32C mismatch/, (kv) => kv.sign('relayer-evm', digest)],
      ['signNoCrc', /missing the signature CRC32C/, (kv) => kv.sign('relayer-evm', digest)],
      ['signVerified', /verify the request digest CRC32C/, (kv) => kv.sign('relayer-evm', digest)],
      ['signVerified', /verify the request data CRC32C/, (kv) => kv.sign('relayer-near', digest)],
      ['signName', /unexpected key name/, (kv) => kv.sign('relayer-near', digest)],
      ['pem', /public key CRC32C mismatch/, (kv) => kv.publicKey('relayer-near')],
      ['encryptCrc', /ciphertext CRC32C mismatch/, (kv) => kv.encrypt(Buffer.from('x'), 'a')],
      [
        'encryptVerified',
        /verify the request plaintext CRC32C/,
        (kv) => kv.encrypt(Buffer.from('x'), 'a'),
      ],
    ];
    for (const [flag, message, call] of cases) {
      it(`throws when ${flag} is corrupted (${message.source})`, async () => {
        await expect(call(vault(stubClient(keys, { [flag]: true })))).rejects.toThrow(message);
      });
    }

    it('throws when the decrypt plaintext checksum mismatches', async () => {
      const kv = vault(stubClient(keys, { decryptCrc: true }));
      const env = await kv.encrypt(Buffer.from('x'), 'a');
      await expect(kv.decrypt(env, 'a')).rejects.toThrow(/plaintext CRC32C mismatch/);
    });
  });
});
