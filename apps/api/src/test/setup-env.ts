import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvFile } from '../lib/load-dotenv.js';

// Load the repo-root .env (never overriding vars already set), then point
// DATABASE_URL at the test database when one is configured.
loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../.env'));
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
