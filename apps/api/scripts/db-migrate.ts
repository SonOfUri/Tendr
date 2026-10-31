import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';
import { applyDbRoles, migrateUrlFromEnv } from './apply-db-roles.js';

// `prisma migrate deploy` then the tendr_app role/grants, both as the owner:
// DATABASE_MIGRATE_URL when set, else DATABASE_URL (the runtime services use DATABASE_URL).
loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));
const url = migrateUrlFromEnv(process.env);
if (!url) {
  console.error('DATABASE_MIGRATE_URL or DATABASE_URL must be set');
  process.exit(1);
}
const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
if (result.status !== 0) process.exit(result.status ?? 1);
applyDbRoles({ url, appPassword: process.env.DATABASE_APP_PASSWORD || undefined }).catch(
  (e: unknown) => {
    console.error('apply-db-roles failed:', e instanceof Error ? e.message : 'unknown error');
    process.exit(1);
  },
);
