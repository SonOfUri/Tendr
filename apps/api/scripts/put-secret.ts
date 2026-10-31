/**
 * Operator script: stores a platform secret (envelope-encrypted with the KMS key-encryption key
 * through `putSecret`). Usage, the value read from stdin only (never argv or env):
 *
 *   railway run --service api npm run secrets:put --workspace=@tendr/api -- chainalysis < key.txt
 *
 * Allowed purposes are the ones the code looks a secret up by. In one transaction the new secret
 * is stored and every older row of that purpose is deleted, so exactly one row per purpose remains.
 * Prints only `stored <purpose> secret <id>`. The running API reads the new value within its
 * 5-minute secret cache TTL (this is a separate process, so there is no cache to clear here).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINALYSIS_PURPOSE } from '../src/checkout/screening.js';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';
import { PIMLICO_SECRET_PURPOSE } from '../src/relayer/evm/pimlico.js';

/** Secrets looked up by purpose (`findFirst where purpose`), not by a stored reference. */
export const ALLOWED_PURPOSES: readonly string[] = [CHAINALYSIS_PURPOSE, PIMLICO_SECRET_PURPOSE];

export interface PutSecretOptions {
  /** Command-line arguments after the script name. */
  args: string[];
  readStdin: () => Promise<string>;
  log: (message: string) => void;
  error: (message: string) => void;
}

/** Returns the process exit code. Never logs the value. */
export async function runPutSecret(opts: PutSecretOptions): Promise<number> {
  const purpose = opts.args[0];
  if (opts.args.length !== 1 || !purpose || !ALLOWED_PURPOSES.includes(purpose)) {
    opts.error(`usage: secrets:put <purpose>  (allowed purposes: ${ALLOWED_PURPOSES.join(', ')})`);
    return 1;
  }
  const value = (await opts.readStdin()).replace(/\r?\n$/, '');
  if (!value) {
    opts.error('no secret value on stdin; nothing stored');
    return 1;
  }
  // Imported lazily so a bad invocation never needs the environment or the database.
  const { prisma } = await import('../src/lib/prisma.js');
  const { putSecret } = await import('../src/secrets/secrets.js');
  const id = await prisma.$transaction(async (tx) => {
    const newId = await putSecret(value, purpose, tx);
    await tx.secret.deleteMany({ where: { purpose, id: { not: newId } } });
    return newId;
  });
  opts.log(`stored ${purpose} secret ${id}`);
  return 0;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));
  runPutSecret({
    args: process.argv.slice(2),
    readStdin: () => readAll(process.stdin),
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  })
    .then(async (code) => {
      const { prisma } = await import('../src/lib/prisma.js');
      await prisma.$disconnect();
      process.exit(code);
    })
    .catch((e: unknown) => {
      console.error('secrets:put failed:', e instanceof Error ? e.message : 'unknown error');
      process.exit(1);
    });
}
