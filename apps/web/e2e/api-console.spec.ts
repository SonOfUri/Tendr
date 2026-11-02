import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const API = `http://localhost:${process.env.API_CONSOLE_API_PORT ?? 4300}`;
const MAIL = resolve(__dirname, '../../api/.mail');

async function choose(page: Page, method: string, path: string) {
  await page.getByLabel('Find an endpoint').fill(path);
  await page
    .getByRole('navigation', { name: 'API endpoints' })
    .getByRole('button', { name: `${method} ${path}`, exact: true })
    .click();
}

async function send(page: Page, method: string, path: string, status: number) {
  const response = page.waitForResponse(
    (r) => r.url().split('?')[0] === `${API}${path}` && r.request().method() === method,
  );
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  const r = await response;
  expect(r.status()).toBe(status);
  await expect(page.getByTestId('console-response')).toBeVisible();
  return r;
}

test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', (route) =>
    ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  await page.goto('/settings/api-console');
  await expect(page.getByRole('heading', { name: 'API console', exact: true })).toBeVisible();
});

test('catalog, real health, auth failures, token isolation, and clearing', async ({ page }) => {
  await expect(
    page.getByRole('navigation', { name: 'API endpoints' }).getByRole('button'),
  ).toHaveCount(119);
  await send(page, 'GET', '/v1/health', 200);
  await choose(page, 'GET', '/v1/me');
  await send(page, 'GET', '/v1/me', 401);
  await expect(page.getByTestId('console-response')).toContainText('UNAUTHENTICATED');
  await choose(page, 'GET', '/v1/ping');
  await page.getByLabel('Bearer token', { exact: true }).fill('intentionally-invalid-test-token');
  const r = await send(page, 'GET', '/v1/ping', 401);
  const headers = await r.request().allHeaders();
  expect(headers.authorization).toBe('Bearer intentionally-invalid-test-token');
  expect(headers.cookie).toBeUndefined();
  expect(headers['tendr-merchant']).toBeUndefined();
  await page.getByRole('button', { name: 'Clear inputs and results' }).click();
  await expect(page.getByLabel('Bearer token', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('console-response')).toHaveCount(0);
});

test('email bootstrap, real passkey registration, scoped writes, uploads and preview', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const email = `console-${Date.now()}@example.com`;
  await choose(page, 'POST', '/v1/auth/email/start');
  await page
    .getByRole('textbox', { name: 'JSON body', exact: true })
    .fill(JSON.stringify({ email }));
  await send(page, 'POST', '/v1/auth/email/start', 202);
  let token = '';
  await expect
    .poll(() => {
      for (const file of readdirSync(MAIL).filter((f) => f.endsWith('.json'))) {
        const mail = JSON.parse(readFileSync(resolve(MAIL, file), 'utf8'));
        if (mail.to === email && mail.template === 'verify_email')
          token = new URL(mail.data.url).searchParams.get('token') ?? '';
      }
      return Boolean(token);
    })
    .toBe(true);
  await choose(page, 'POST', '/v1/auth/email/verify');
  await page
    .getByRole('textbox', { name: 'JSON body', exact: true })
    .fill(JSON.stringify({ token }));
  await send(page, 'POST', '/v1/auth/email/verify', 200);
  // Exercise options -> native browser ceremony -> prepared verify request, not a mocked assertion.
  await choose(page, 'POST', '/v1/auth/passkeys/register/options');
  await send(page, 'POST', '/v1/auth/passkeys/register/options', 200);
  await page.getByRole('button', { name: 'Use passkey and prepare verification' }).click();
  await expect(page.getByLabel('API path', { exact: true })).toHaveValue(
    '/v1/auth/passkeys/register/verify',
  );
  await send(page, 'POST', '/v1/auth/passkeys/register/verify', 200);
  await choose(page, 'POST', '/v1/merchants');
  await page
    .getByRole('textbox', { name: 'JSON body', exact: true })
    .fill(JSON.stringify({ name: `Console ${Date.now()}` }));
  await send(page, 'POST', '/v1/merchants', 201);
  await page.getByRole('button', { name: 'Load session', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(email);
  await choose(page, 'POST', '/v1/themes');
  const created = await send(page, 'POST', '/v1/themes', 201);
  const theme = await created.json();
  const sent = await created.request().allHeaders();
  expect(sent['tendr-merchant']).toMatch(/^mer_/);
  expect(sent['tendr-livemode']).toBe('false');
  expect(sent['tendr-csrf']).toBeTruthy();
  await choose(page, 'POST', '/v1/theme-assets');
  await page
    .getByLabel('File', { exact: true })
    .setInputFiles(resolve(__dirname, '../public/tendr-logo.png'));
  await send(page, 'POST', '/v1/theme-assets', 201);
  await choose(page, 'POST', '/v1/themes/:id/preview');
  await page.getByLabel('Path parameter id', { exact: true }).fill(theme.id);
  await send(page, 'POST', `/v1/themes/${theme.id}/preview`, 201);
  await choose(page, 'POST', '/v1/account/go-live');
  await send(page, 'POST', '/v1/account/go-live', 403);
  await expect(page.getByTestId('console-response')).toContainText('LIVE_MODE_UNAVAILABLE');
});

test('mobile viewport stays within the screen and endpoint selection sends nothing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let sent = 0;
  page.on('request', (r) => {
    if (r.url().startsWith(API)) sent++;
  });
  await choose(page, 'POST', '/v1/payment_links');
  expect(sent).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
