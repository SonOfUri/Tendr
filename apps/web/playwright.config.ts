import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

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

// Own ports, so a running `npm run dev` (dev database, real NEAR settings) is never reused by
// mistake. WebAuthn still runs on RP ID `localhost`; the API is told this origin.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const WEB_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;

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
        CORS_ORIGINS: WEB_URL,
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_ORIGINS: WEB_URL,
        NEAR_CLIENT_DRIVER: 'fake',
        NEAR_FAKE_SIMULATE: '1',
        // Any well-formed code hash: the fake client never deploys anything.
        MERCHANT_ACCOUNT_CODE_HASH_TEST: '11111111111111111111111111111111',
        MERCHANT_ACCOUNT_CODE_HASH_LIVE: '11111111111111111111111111111111',
        MAIL_DRIVER: 'log',
        KEYVAULT_DRIVER: 'local',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `npx next dev --port ${WEB_PORT}`,
      cwd: __dirname,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_BASE_URL: API_URL,
        NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
      },
    },
  ],
});
