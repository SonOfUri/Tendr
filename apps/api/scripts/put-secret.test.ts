import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAINALYSIS_PURPOSE } from '../src/checkout/screening.js';
import { prisma } from '../src/lib/prisma.js';
import { PIMLICO_SECRET_PURPOSE, pimlicoApiKey } from '../src/relayer/evm/pimlico.js';
import { clearSecretCache, getSecret } from '../src/secrets/secrets.js';
import { runPutSecret } from './put-secret.js';

const VALUE = 'ca-test-key-9f8e7d6c5b4a';
const PURPOSES = ['chainalysis', 'pimlico'];

async function run(args: string[], input: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPutSecret({
    args,
    readStdin: async () => input,
    log: (m) => out.push(m),
    error: (m) => err.push(m),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const rows = (purpose: string) => prisma.secret.findMany({ where: { purpose } });

describe('put-secret', () => {
  beforeEach(async () => {
    clearSecretCache();
    await prisma.secret.deleteMany({ where: { purpose: { in: PURPOSES } } });
  });
  afterEach(async () => {
    await prisma.secret.deleteMany({ where: { purpose: { in: PURPOSES } } });
  });

  it('stores the value so the screening lookup finds it, and prints only the id', async () => {
    const r = await run(['chainalysis'], `${VALUE}\n`);
    expect(r.code).toBe(0);
    const found = await rows(CHAINALYSIS_PURPOSE);
    expect(found).toHaveLength(1);
    expect(r.out).toBe(`stored chainalysis secret ${found[0]!.id}`);
    expect(await getSecret(found[0]!.id)).toBe(VALUE);
    expect(r.out + r.err).not.toContain(VALUE);
    expect(found[0]!.ciphertext).not.toContain(VALUE);
  });

  it('stores a pimlico key readable through pimlicoApiKey', async () => {
    expect((await run(['pimlico'], 'pim-key-123\n')).code).toBe(0);
    expect(await pimlicoApiKey()).toBe('pim-key-123');
    expect(await rows(PIMLICO_SECRET_PURPOSE)).toHaveLength(1);
  });

  it('a second run replaces the first: one row remains', async () => {
    await run(['chainalysis'], 'first-key\n');
    clearSecretCache();
    await run(['chainalysis'], 'second-key\n');
    const found = await rows('chainalysis');
    expect(found).toHaveLength(1);
    expect(await getSecret(found[0]!.id)).toBe('second-key');
  });

  it('strips one trailing newline (CRLF included), nothing else', async () => {
    await run(['chainalysis'], 'k\r\n');
    const found = await rows('chainalysis');
    expect(await getSecret(found[0]!.id)).toBe('k');
  });

  it('rejects an unknown purpose, listing the allowed ones, and stores nothing', async () => {
    const before = await prisma.secret.count();
    const r = await run(['bogus'], `${VALUE}\n`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('chainalysis');
    expect(r.err).toContain('pimlico');
    expect(r.err).not.toContain(VALUE);
    expect(await prisma.secret.count()).toBe(before);
  });

  it('rejects a missing purpose', async () => {
    expect((await run([], VALUE)).code).toBe(1);
  });

  it('rejects empty input and keeps the existing secret', async () => {
    await run(['chainalysis'], 'keep-me\n');
    for (const input of ['', '\n']) {
      const r = await run(['chainalysis'], input);
      expect(r.code).toBe(1);
    }
    const found = await rows('chainalysis');
    expect(found).toHaveLength(1);
    expect(await getSecret(found[0]!.id)).toBe('keep-me');
  });

  it('works end to end as a process reading stdin', async () => {
    const script = resolve(fileURLToPath(new URL('.', import.meta.url)), 'put-secret.ts');
    const res = spawnSync('npx', ['tsx', script, 'chainalysis'], {
      input: `${VALUE}\n`,
      encoding: 'utf8',
      env: process.env,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^stored chainalysis secret sec_/);
    expect(res.stdout + res.stderr).not.toContain(VALUE);
    expect(await rows('chainalysis')).toHaveLength(1);
  }, 60_000);
});
