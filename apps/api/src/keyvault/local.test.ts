import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { afterAll, describe, expect, it } from 'vitest';
import { KEY_NAMES, curveOf, nearPublicKey } from './keys.js';
import { LocalKeyVault } from './local.js';
import { evmAddress } from './secp256k1.js';

const dir = mkdtempSync(join(tmpdir(), 'tendr-kv-'));
let n = 0;
const tmpPath = (): string => join(dir, `nested-${n++}`, 'local.json');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('LocalKeyVault', () => {
  const kv = new LocalKeyVault(tmpPath());

  it('encrypt/decrypt round trip, aad bound', async () => {
    const env = await kv.encrypt(Buffer.from('whsec_abc'), 'sec_1');
    expect(env).not.toContain('whsec_abc');
    expect(JSON.parse(env)).toMatchObject({ v: 1, kek: 'local' });
    expect(Buffer.from(await kv.decrypt(env, 'sec_1')).toString()).toBe('whsec_abc');
    await expect(kv.decrypt(env, 'sec_2')).rejects.toThrow();
  });

  it('rejects a tampered envelope', async () => {
    const env = JSON.parse(await kv.encrypt(Buffer.from('payload'), 'sec_1'));
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    await expect(
      kv.decrypt(JSON.stringify({ ...env, ct: ct.toString('base64') }), 'sec_1'),
    ).rejects.toThrow();
  });

  it('decrypts with a second instance over the same file, not with another file', async () => {
    const path = tmpPath();
    const env = await new LocalKeyVault(path).encrypt(Buffer.from('x'), 'sec_1');
    expect(Buffer.from(await new LocalKeyVault(path).decrypt(env, 'sec_1')).toString()).toBe('x');
    await expect(new LocalKeyVault(tmpPath()).decrypt(env, 'sec_1')).rejects.toThrow();
  });

  it('keeps signing keys stable across instances over the same file', async () => {
    const path = tmpPath();
    const a = await new LocalKeyVault(path).publicKey('relayer-evm');
    const b = await new LocalKeyVault(path).publicKey('relayer-evm');
    expect(bytesToHex(b.raw)).toBe(bytesToHex(a.raw));
  });

  it('writes the keyfile with mode 0600', async () => {
    const path = tmpPath();
    await new LocalKeyVault(path).publicKey('funding-near');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('ed25519 signature verifies as NEAR', async () => {
    const msg = sha256(utf8ToBytes('near tx bytes'));
    const sig = await kv.sign('funding-near', msg);
    const { curve, raw } = await kv.publicKey('funding-near');
    expect(curve).toBe('ed25519');
    expect(raw.length).toBe(32);
    if (sig.curve !== 'ed25519') throw new Error('expected ed25519');
    expect(sig.signature.length).toBe(64);
    expect(ed25519.verify(sig.signature, msg, raw)).toBe(true);
    expect(nearPublicKey(raw)).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it('secp256k1 signature recovers to the key EVM address', async () => {
    const { curve, raw } = await kv.publicKey('relayer-evm');
    expect(curve).toBe('secp256k1');
    expect(raw.length).toBe(65);
    for (let i = 0; i < 8; i++) {
      const digest = keccak_256(utf8ToBytes(`evm tx ${i}`));
      const sig = await kv.sign('relayer-evm', digest);
      if (sig.curve !== 'secp256k1') throw new Error('expected secp256k1');
      const recovered = secp256k1.Signature.fromCompact(concatBytes(sig.r, sig.s))
        .addRecoveryBit(sig.v)
        .recoverPublicKey(digest)
        .toRawBytes(false);
      expect(evmAddress(recovered)).toBe(evmAddress(raw));
      expect(BigInt('0x' + bytesToHex(sig.s)) <= secp256k1.CURVE.n / 2n).toBe(true);
    }
  });

  it('secp256k1 rejects a payload that is not a 32-byte digest', async () => {
    await expect(kv.sign('gas-tron', utf8ToBytes('not a digest'))).rejects.toThrow(/32-byte/);
  });

  it('keeps distinct keys per name', async () => {
    const a = await kv.publicKey('relayer-near');
    const b = await kv.publicKey('funding-near');
    expect(bytesToHex(a.raw)).not.toBe(bytesToHex(b.raw));
  });

  it('refuses to construct in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new LocalKeyVault(tmpPath())).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('curveOf: relayer-evm and gas-tron are secp256k1, the other three are ed25519', () => {
    expect(KEY_NAMES).toHaveLength(5);
    expect(curveOf('relayer-evm')).toBe('secp256k1');
    expect(curveOf('gas-tron')).toBe('secp256k1');
    expect(curveOf('relayer-near')).toBe('ed25519');
    expect(curveOf('funding-near')).toBe('ed25519');
    expect(curveOf('solver-hot')).toBe('ed25519');
  });
});

describe('LocalKeyVault shared keyfile', () => {
  const kekOf = (path: string): string => JSON.parse(readFileSync(path, 'utf8')).kek;

  it('two instances on a fresh path used concurrently share one KEK and the same keys', async () => {
    const path = tmpPath();
    const a = new LocalKeyVault(path);
    const b = new LocalKeyVault(path);
    const [envA, sigB, envB] = await Promise.all([
      a.encrypt(Buffer.from('from-a'), 'sec_a'),
      b.sign('gas-tron', keccak_256(utf8ToBytes('tron'))),
      b.encrypt(Buffer.from('from-b'), 'sec_b'),
    ]);
    expect(sigB.curve).toBe('secp256k1');
    const fresh = new LocalKeyVault(path);
    expect(Buffer.from(await fresh.decrypt(envA, 'sec_a')).toString()).toBe('from-a');
    expect(Buffer.from(await fresh.decrypt(envB, 'sec_b')).toString()).toBe('from-b');
    const [pa, pb] = await Promise.all([a.publicKey('gas-tron'), b.publicKey('gas-tron')]);
    expect(bytesToHex(pa.raw)).toBe(bytesToHex(pb.raw));
    // Keys added by either instance are merged, never dropped.
    await a.publicKey('relayer-near');
    await b.publicKey('solver-hot');
    const onDisk = Object.keys(JSON.parse(readFileSync(path, 'utf8')).keys).sort();
    expect(onDisk).toEqual(['gas-tron', 'relayer-near', 'solver-hot']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(path))).toEqual(['local.json']); // no temp or lock files left
  });

  it('separate processes racing on a fresh keyfile agree on one KEK and one key per name', async () => {
    const path = tmpPath();
    const script = join(dir, `race-${n++}.mts`);
    const localTs = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'local.ts')).href;
    writeFileSync(
      script,
      `import { LocalKeyVault } from ${JSON.stringify(localTs)};
const kv = new LocalKeyVault(process.argv[2]);
const aad = 'sec_' + process.pid;
const env = await kv.encrypt(Buffer.from('p' + process.pid), aad);
const evm = Buffer.from((await kv.publicKey('relayer-evm')).raw).toString('hex');
const near = Buffer.from((await kv.publicKey('funding-near')).raw).toString('hex');
console.log(JSON.stringify({ aad, env, evm, near, pid: process.pid }));
`,
    );
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const tsx = join(repoRoot, 'node_modules/.bin/tsx');
    const run = promisify(execFile);
    const outs = await Promise.all(
      Array.from({ length: 6 }, () => run(tsx, [script, path], { cwd: repoRoot })),
    );
    const results = outs.map((o) => JSON.parse(o.stdout.trim()) as Record<string, string>);
    const kv = new LocalKeyVault(path);
    for (const r of results) {
      expect(Buffer.from(await kv.decrypt(r.env!, r.aad!)).toString()).toBe(`p${r.pid}`);
    }
    expect(new Set(results.map((r) => r.evm)).size).toBe(1);
    expect(new Set(results.map((r) => r.near)).size).toBe(1);
    expect(bytesToHex((await kv.publicKey('relayer-evm')).raw)).toBe(results[0]!.evm);
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 60_000);

  it('refuses to adopt a different KEK after one is loaded', async () => {
    const path = tmpPath();
    const a = new LocalKeyVault(path);
    await a.encrypt(Buffer.from('x'), 'sec_1');
    const kek = kekOf(path);
    rmSync(path);
    await new LocalKeyVault(path).publicKey('funding-near'); // recreates with a new KEK
    expect(kekOf(path)).not.toBe(kek);
    await expect(a.publicKey('relayer-evm')).rejects.toThrow(/KEK/);
  });
});
