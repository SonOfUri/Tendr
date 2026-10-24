import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { resetDb } from '../test/helpers.js';
import { clearSecretCache, getSecret, putSecret } from './secrets.js';

const dir = mkdtempSync(join(tmpdir(), 'tendr-secrets-'));

describe('secrets', () => {
  beforeAll(() => {
    // Never touch the real LOCAL_KEYVAULT_PATH from tests.
    process.env.KEYVAULT_DRIVER = 'local';
    process.env.LOCAL_KEYVAULT_PATH = join(dir, 'local.json');
    loadEnv();
  });

  beforeEach(async () => {
    await resetDb();
    clearSecretCache();
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('putSecret stores only ciphertext', async () => {
    const ref = await putSecret('whsec_plain', 'webhook');
    expect(ref).toMatch(/^sec_/);
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: ref } });
    expect(row.purpose).toBe('webhook');
    expect(row.kek).toBe('local');
    expect(row.ciphertext).not.toContain('whsec_plain');
    expect(await getSecret(ref)).toBe('whsec_plain');
  });

  it('binds the ciphertext to its secret id', async () => {
    const a = await putSecret('alpha', 'pimlico');
    const b = await putSecret('beta', 'pimlico');
    const rowA = await prisma.secret.findUniqueOrThrow({ where: { id: a } });
    await prisma.secret.update({ where: { id: b }, data: { ciphertext: rowA.ciphertext } });
    await expect(getSecret(b)).rejects.toThrow();
  });

  it('caches decrypted values for five minutes', async () => {
    const ref = await putSecret('cached', 'webhook');
    expect(await getSecret(ref)).toBe('cached');
    await prisma.secret.delete({ where: { id: ref } });
    expect(await getSecret(ref)).toBe('cached');
    clearSecretCache();
    await expect(getSecret(ref)).rejects.toThrow();
  });

  it('expires cached values after five minutes', async () => {
    const ref = await putSecret('ttl', 'webhook');
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      expect(await getSecret(ref)).toBe('ttl');
      await prisma.secret.delete({ where: { id: ref } });
      now.mockReturnValue(t0 + 5 * 60_000 - 1);
      expect(await getSecret(ref)).toBe('ttl');
      now.mockReturnValue(t0 + 5 * 60_000);
      await expect(getSecret(ref)).rejects.toThrow();
    } finally {
      now.mockRestore();
    }
  });

  it('throws for an unknown ref', async () => {
    await expect(getSecret('sec_missing')).rejects.toThrow();
  });
});
