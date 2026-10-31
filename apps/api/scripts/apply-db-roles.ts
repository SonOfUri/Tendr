import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';

const ROLES_SQL = resolve(fileURLToPath(new URL('.', import.meta.url)), '../prisma/roles.sql');

export interface ApplyDbRolesOptions {
  /** Owner connection URL (the one that runs migrations). */
  url: string;
  /** Password for the `tendr_app` login role; when unset the role is created without one. */
  appPassword: string | undefined;
  log?: (message: string) => void;
}

/** Creates the least-privilege `tendr_app` role and grants. Idempotent. Never logs the password. */
export async function applyDbRoles(opts: ApplyDbRolesOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const prisma = new PrismaClient({ datasourceUrl: opts.url });
  try {
    await prisma.$executeRawUnsafe(readFileSync(ROLES_SQL, 'utf8'));
    if (opts.appPassword) {
      // ALTER ROLE takes no bind parameters, so let the server quote the literal (format %L)
      // from a bound value, then run the resulting statement.
      const rows = await prisma.$queryRaw<{ stmt: string }[]>`
        SELECT format('ALTER ROLE tendr_app PASSWORD %L', ${opts.appPassword}::text) AS stmt`;
      const stmt = rows[0]?.stmt;
      if (!stmt) throw new Error('could not build ALTER ROLE statement');
      await prisma.$executeRawUnsafe(stmt);
      log('tendr_app role ready (password set from DATABASE_APP_PASSWORD)');
    } else {
      log('tendr_app role ready; DATABASE_APP_PASSWORD not set, role password left unchanged');
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * What a failure prints. Fixed on purpose: a Postgres error can quote the statement it failed on,
 * and that statement can be `ALTER ROLE tendr_app PASSWORD '…'`.
 */
export const APPLY_ROLES_FAILED = 'applying database roles failed';

/** `applyDbRoles` for the scripts: returns the exit code; on failure prints only the fixed line. */
export async function runApplyDbRoles(
  opts: ApplyDbRolesOptions & {
    error?: (message: string) => void;
    /** Tests replace the step that touches the database. */
    apply?: (opts: ApplyDbRolesOptions) => Promise<void>;
  },
): Promise<number> {
  const error = opts.error ?? ((m: string) => console.error(m));
  try {
    await (opts.apply ?? applyDbRoles)({
      url: opts.url,
      appPassword: opts.appPassword,
      log: opts.log,
    });
    return 0;
  } catch {
    error(APPLY_ROLES_FAILED);
    return 1;
  }
}

export function migrateUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.DATABASE_MIGRATE_URL || env.DATABASE_URL || undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));
  const url = migrateUrlFromEnv(process.env);
  if (!url) {
    console.error('DATABASE_MIGRATE_URL or DATABASE_URL must be set');
    process.exit(1);
  }
  void runApplyDbRoles({ url, appPassword: process.env.DATABASE_APP_PASSWORD || undefined }).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
  );
}
