import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

const web = `http://localhost:${process.env.API_CONSOLE_WEB_PORT ?? 3300}`;
export default defineConfig({
  testDir: './e2e',
  testMatch: 'api-console.spec.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: web,
    headless: true,
    actionTimeout: 15_000,
    channel:
      process.env.E2E_CHANNEL ?? (existsSync(chromium.executablePath()) ? undefined : 'chrome'),
    // Requests/responses can contain temporary credentials: no trace or video recording.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: 'npm run dev:console',
    cwd: resolve(__dirname, '../..'),
    url: `${web}/settings/api-console`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
