// The WooCommerce plugin end to end (e2e/woocommerce.spec.ts): two WordPress + WooCommerce sites
// in wp-env (Docker, apps/woocommerce/.wp-env.e2e*.json, ports 8892 and 8893) install the freshly
// built plugin zip and connect to the same local API and web app the other specs use, in test
// mode. Global setup builds the zip and resets both sites; the API and web servers are the main
// config's (the fixture store is not needed).
//
//   npm run test:e2e:woocommerce --workspace=@tendr/web
//
// WordPress calls the API at host.docker.internal:4100 and the API calls the sites' webhooks at
// localhost:8892 / :8893, so everything stays on this machine.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { API_URL, WEB_URL } from './e2e/support/urls';

const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ['woocommerce.spec.ts'],
  timeout: 420_000,
  globalSetup: './e2e/woocommerce/global-setup.ts',
  webServer: servers
    .filter((s) => s.url === `${API_URL}/v1/health` || s.url === WEB_URL)
    .map((s) =>
      s.url === `${API_URL}/v1/health`
        ? // A store refund above the account's refund cap is timelocked (24 h on chain); the
          // simulated contract's timelock is 5 s here so the approved refund executes in the run.
          { ...s, env: { ...s.env, NEAR_FAKE_TIMELOCK_SECONDS: '5' } }
        : s,
    ),
});
