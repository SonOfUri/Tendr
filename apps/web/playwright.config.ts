import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';
import {
  API_PORT,
  API_URL,
  E2E_CODE_HASH,
  STORE_PORT,
  STORE_URL,
  WEB_PORT,
  WEB_URL,
} from './e2e/support/urls';

/** TEST_DATABASE_URL from the environment or the monorepo root .env. */
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const path = resolve(__dirname, '../../.env');
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*TEST_DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1]!.replace(/^['"]|['"]$/g, '');
    }
  }
  throw new Error('TEST_DATABASE_URL is not set (environment or root .env)');
}

// Own ports (e2e/support/urls.ts), so a running `npm run dev` (dev database, real NEAR settings) is
// never reused by mistake. WebAuthn still runs on RP ID `localhost`; the API is told this origin.
// The fixture store (e2e/fixtures/merchant-server.mjs) is a second origin for the checkout specs.

/**
 * The browser: Playwright's bundled Chromium when it is installed, else the system Google Chrome
 * (`channel: 'chrome'`), so the specs run without downloading browsers. E2E_CHANNEL overrides.
 * In CI (`CI=true`) always the installed Chromium (`npx playwright install chromium`): a missing
 * install fails loudly instead of silently using whatever Chrome the runner has.
 */
function channel(): string | undefined {
  if (process.env.E2E_CHANNEL) return process.env.E2E_CHANNEL;
  if (process.env.CI === 'true' || process.env.CI === '1') return undefined;
  try {
    return existsSync(chromium.executablePath()) ? undefined : 'chrome';
  } catch {
    return 'chrome';
  }
}

export default defineConfig({
  testDir: './e2e',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  // One flow shares one database and server; run the specs one at a time.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: WEB_URL,
    headless: true,
    channel: channel(),
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The API and the worker in one process (scripts/e2e-server.ts) against the TEST database,
      // with the in-memory NEAR client running the merchant-account contract, and mail written to
      // apps/api/.mail/ (the spec reads magic links from there).
      command: 'npm run db:migrate:test && npm run e2e:serve',
      cwd: resolve(__dirname, '../api'),
      url: `${API_URL}/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: testDatabaseUrl(),
        // A Redis DB of its own, so dev workers never pick up these jobs.
        REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://localhost:6380/7',
        API_PORT: String(API_PORT),
        API_HOST: '127.0.0.1',
        API_BASE_URL: API_URL,
        WEB_URL,
        // Session URLs point at this web server, and its origin gets the shopper routes' CORS.
        CHECKOUT_BASE_URL: WEB_URL,
        CORS_ORIGINS: WEB_URL,
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_ORIGINS: WEB_URL,
        NEAR_CLIENT_DRIVER: 'fake',
        NEAR_FAKE_SIMULATE: '1',
        // Any well-formed code hash: the fake client never deploys anything.
        MERCHANT_ACCOUNT_CODE_HASH_TEST: E2E_CODE_HASH,
        MERCHANT_ACCOUNT_CODE_HASH_LIVE: E2E_CODE_HASH,
        MAIL_DRIVER: 'log',
        KEYVAULT_DRIVER: 'local',
        LOG_LEVEL: 'warn',
      },
    },
    {
      // tendr.js is built for this server's origin first (served at /v1/tendr.js).
      command: `node scripts/build-embed.mjs && npx next dev --port ${WEB_PORT}`,
      cwd: __dirname,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_BASE_URL: API_URL,
        // The middleware's frame-origins lookup (else the root .env's dev API would be asked).
        API_BASE_URL: API_URL,
        NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
        TENDR_CHECKOUT_BASE_URL: WEB_URL,
        // No Reown project, whatever the root .env says: no WalletConnect traffic in the e2e (and
        // the checkout spec aborts every non-local request anyway).
        NEXT_PUBLIC_REOWN_PROJECT_ID: '',
      },
    },
    {
      // The fixture store: frames the checkout with tendr.js and receives the signed webhooks.
      command: 'node e2e/fixtures/merchant-server.mjs',
      cwd: __dirname,
      url: `${STORE_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        FIXTURE_PORT: String(STORE_PORT),
        TENDR_JS_URL: `${WEB_URL}/v1/tendr.js`,
      },
    },
  ],
});
