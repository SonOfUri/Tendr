import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';
import { EnvironmentKeyVault, validEnvironmentKeyBundle } from './environment.js';
import { KEY_NAMES, curveOf } from './keys.js';

// Deterministic fixture keys, never used outside tests.
const secret = (label: string) => createHash('sha256').update(label).digest('base64');
const bundle = () => ({
  v: 1,
  kek: secret('test-kek'),
  keys: Object.fromEntries(KEY_NAMES.map((name) => [name, secret(name)])),
});

describe('environment key vault', () => {
  it('shares encrypted secrets across instances and restarts, with AAD and tamper protection', async () => {
    const serialized = JSON.stringify(bundle());
    const api = new EnvironmentKeyVault(serialized);
    const worker = new EnvironmentKeyVault(serialized);
    const encrypted = await api.encrypt(Buffer.from('webhook secret'), 'sec_1');
    expect(Buffer.from(await worker.decrypt(encrypted, 'sec_1')).toString()).toBe('webhook secret');
    await expect(worker.decrypt(encrypted, 'sec_2')).rejects.toThrow();
    const altered = JSON.parse(encrypted);
    altered.ct = Buffer.from('wrong ciphertext').toString('base64');
    await expect(worker.decrypt(JSON.stringify(altered), 'sec_1')).rejects.toThrow();
    const wrong = new EnvironmentKeyVault(
      JSON.stringify({ ...bundle(), kek: secret('different-kek') }),
    );
    await expect(wrong.decrypt(encrypted, 'sec_1')).rejects.toThrow();
    expect(await api.encrypt(Buffer.from('webhook secret'), 'sec_1')).not.toBe(encrypted);
  });

  it.each(KEY_NAMES)(
    'signs correctly and preserves the %s public key across services',
    async (name) => {
      const serialized = JSON.stringify(bundle());
      const api = new EnvironmentKeyVault(serialized);
      const worker = new EnvironmentKeyVault(serialized);
      const payload = createHash('sha256').update('transaction').digest();
      const { raw, curve } = await api.publicKey(name);
      expect(await worker.publicKey(name)).toEqual({ raw, curve });
      expect(curve).toBe(curveOf(name));
      const signature = await worker.sign(name, payload);
      if (signature.curve === 'ed25519') {
        expect(ed25519.verify(signature.signature, payload, raw)).toBe(true);
      } else {
        const compact = Buffer.concat([signature.r, signature.s]);
        expect(secp256k1.verify(compact, payload, raw)).toBe(true);
        const recovered = secp256k1.Signature.fromCompact(compact)
          .addRecoveryBit(signature.v)
          .recoverPublicKey(payload)
          .toRawBytes(false);
        expect(recovered).toEqual(raw);
        expect(BigInt('0x' + Buffer.from(signature.s).toString('hex'))).toBeLessThanOrEqual(
          secp256k1.CURVE.n / 2n,
        );
      }
    },
  );

  it('rejects incomplete, reused, malformed and invalid-curve keys without echoing inputs', () => {
    const missing = bundle();
    delete missing.keys['funding-near'];
    const invalidCurve = bundle();
    invalidCurve.keys['relayer-evm'] = Buffer.alloc(32, 255).toString('base64');
    const duplicate = bundle();
    duplicate.keys['funding-near'] = duplicate.kek;
    for (const value of [
      null,
      [],
      {},
      missing,
      invalidCurve,
      duplicate,
      { ...bundle(), kek: 'secret-that-must-not-be-logged' },
      { ...bundle(), kek: Buffer.alloc(32).toString('base64') },
    ]) {
      const serialized = JSON.stringify(value);
      expect(validEnvironmentKeyBundle(serialized)).toBe(false);
      expect(() => new EnvironmentKeyVault(serialized)).toThrow('Invalid ENV_KEYVAULT_JSON');
      try {
        new EnvironmentKeyVault(serialized);
      } catch (error) {
        expect(String(error)).not.toContain('secret-that-must-not-be-logged');
      }
    }
    expect(validEnvironmentKeyBundle('not JSON secret')).toBe(false);
    expect(validEnvironmentKeyBundle(JSON.stringify(bundle()))).toBe(true);
  });

  it('does not expose keys through JSON serialization or normal object inspection', () => {
    const vault = new EnvironmentKeyVault(JSON.stringify(bundle()));
    expect(JSON.stringify(vault)).toBe('{}');
    expect(inspect(vault)).not.toContain(bundle().kek);
  });

  it('refuses invalid secp256k1 payloads and unknown key names', async () => {
    const vault = new EnvironmentKeyVault(JSON.stringify(bundle()));
    await expect(vault.sign('gas-tron', Buffer.from('short'))).rejects.toThrow('32-byte');
    await expect(vault.publicKey('missing' as never)).rejects.toThrow('Unknown key name');
  });
});
