import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvFile } from '../lib/load-dotenv.js';

// Load the repo-root .env (never overriding vars already set), then point DATABASE_URL at the
// test database. Tests empty every table (resetDb), so they refuse to run against DATABASE_URL
// unless TEST_DATABASE_URL is set — except in CI, whose DATABASE_URL is a throwaway database.
// API tests script the fake NEAR client directly; the dev-only contract simulator must never be
// picked up from a developer's root .env.
process.env.NEAR_FAKE_SIMULATE = '0';
loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../.env'));
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else if (!process.env.CI) {
  throw new Error(
    'TEST_DATABASE_URL is not set: tests wipe the database, so they will not run against ' +
      'DATABASE_URL. Set TEST_DATABASE_URL (see .env.example) and run `npm run db:migrate:test`, ' +
      'or set CI=1 when DATABASE_URL is a throwaway database.',
  );
}
