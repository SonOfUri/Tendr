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
  ).toHaveCount(120);
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

test('signup explains local delivery and opens the verification email in the inbox', async ({
  page,
}) => {
  const email = `console-inbox-${Date.now()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send me a link' }).click();
  await expect(
    page.getByText('Nothing was sent to your email address.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open local inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local inbox', exact: true })).toBeVisible();
  await expect(page.getByLabel('Filter by email')).toHaveValue(email);
  await page.getByRole('link', { name: 'Verify email and continue', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm my email', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Create your passkey', exact: true }),
  ).toBeVisible();
});

test('dashboard creates, shares, edits and archives payment links with safe retries and mode isolation', async ({
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
  const email = `console-links-${Date.now()}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send me a link' }).click();
  await page.getByRole('link', { name: 'Open local inbox', exact: true }).click();
  await page.getByRole('link', { name: 'Verify email and continue', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm my email', exact: true }).click();
  await page.getByRole('button', { name: 'Create my passkey', exact: true }).click();
  await page.getByLabel('Store name', { exact: true }).fill(`Link Store ${Date.now()}`);
  await page.getByRole('button', { name: 'Create store', exact: true }).click();
  await expect(page.getByRole('heading', { name: /is set up$/ })).toBeVisible();
  await page.getByRole('link', { name: 'Payment links', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payment links', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create payment link', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Coffee plan');
  await page.getByLabel('Amount', { exact: true }).fill('0.50');
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(page.getByText(/The amount must be at least USD 1.00/)).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('25.10');
  await page
    .getByRole('combobox', { name: 'Settlement token', exact: true })
    .selectOption('custom');
  await page.getByRole('combobox', { name: 'Asset chain', exact: true }).selectOption('base');
  const baseUsdc = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
  await page
    .getByRole('combobox', { name: 'Token to receive', exact: true })
    .selectOption(baseUsdc);

  // Lose a successful POST response, then retry: the UI must reuse its key, not create twice.
  let firstKey: string | undefined;
  let saved:
    { id: string; url: string; qr_url: string; amount: string; livemode: boolean } | undefined;
  const pattern = `${API}/v1/payment_links`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    firstKey = route.request().headers()['idempotency-key'];
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    saved = await response.json();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(
    page.getByText('We could not reach Tendr. Check your connection.', { exact: true }),
  ).toBeVisible();
  await page.unroute(pattern);
  const retry = page.waitForResponse((r) => r.url() === pattern && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  const created = await retry;
  expect(created.status()).toBe(201);
  expect((await created.json()).settlement_asset).toBe(baseUsdc);
  expect((await created.json()).id).toBe(saved!.id);
  const headers = await created.request().allHeaders();
  expect(headers['idempotency-key']).toBe(firstKey);
  expect(headers['tendr-merchant']).toMatch(/^mer_/);
  expect(headers['tendr-livemode']).toBe('false');
  expect(headers['tendr-csrf']).toBeTruthy();
  expect(saved!.amount).toBe('25.10');
  expect(saved!.livemode).toBe(false);
  expect(new URL(saved!.url).searchParams.get('mode')).toBe('test');
  const card = page.getByRole('article', { name: 'Coffee plan', exact: true });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('USDC · Base into your Tendr account');
  await expect(card.getByRole('link', { name: 'Open checkout', exact: true })).toHaveAttribute(
    'href',
    saved!.url,
  );
  await expect(card.getByRole('link', { name: 'Open QR code', exact: true })).toHaveAttribute(
    'href',
    saved!.qr_url,
  );

  const popup = page.waitForEvent('popup');
  await card.getByRole('link', { name: 'Open checkout', exact: true }).click();
  const checkout = await popup;
  await expect(checkout.getByRole('heading', { name: 'Coffee plan', exact: true })).toBeVisible();
  const shopperRead = checkout.waitForResponse(
    (r) => r.url() === `${API}/v1/checkout/client/session` && r.status() === 200,
  );
  await checkout.locator('form').getByRole('button', { name: /Pay/ }).click();
  expect((await (await shopperRead).json()).settlement_asset).toBe(baseUsdc);
  await checkout.close();
  const qr = await page.request.get(saved!.qr_url);
  expect(qr.status()).toBe(200);
  expect(qr.headers()['content-type']).toContain('image/png');

  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Asset chain', exact: true })).toHaveValue(
    'base',
  );
  await expect(page.getByRole('combobox', { name: 'Token to receive', exact: true })).toHaveValue(
    baseUsdc,
  );
  await page.getByRole('combobox', { name: 'Asset chain', exact: true }).selectOption('btc');
  await expect(page.getByRole('combobox', { name: 'Token to receive', exact: true })).toHaveValue(
    '',
  );
  await page
    .getByRole('combobox', { name: 'Token to receive', exact: true })
    .selectOption('nep141:btc.omft.near');
  await page.getByRole('combobox', { name: 'Amount type', exact: true }).selectOption('open');
  await page.getByLabel('Minimum amount (optional)', { exact: true }).fill('2.50');
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('inactive');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(card).toContainText('Customer chooses amount');
  await expect(card).toContainText('Minimum 2.50 USD');
  await expect(card).toContainText('BTC · Bitcoin into your Tendr account');
  await expect(card).toContainText('Paused');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Settlement token', exact: true })
    .selectOption('default');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(card).toContainText('Settlement: Store default');
  await card.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByLabel('Show archived links', { exact: true }).check();
  await expect(card).toContainText('Archived');
  await card.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
  await expect(card).toContainText('Paused');

  // Form drafts and results never carry from test to live, nor between stores.
  await page.getByRole('button', { name: 'Create payment link', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Unsent test draft');
  await page
    .getByRole('group', { name: 'Mode', exact: true })
    .getByRole('button', { name: 'Live', exact: true })
    .click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await page
    .getByRole('group', { name: 'Mode', exact: true })
    .getByRole('button', { name: 'Test', exact: true })
    .click();
  await expect(card).toBeVisible();
  await page.getByRole('combobox', { name: 'Store', exact: true }).selectOption('__new');
  await page.getByLabel('Store name', { exact: true }).fill(`Other Link Store ${Date.now()}`);
  await page.getByRole('button', { name: 'Create store', exact: true }).click();
  await expect(page.getByRole('heading', { name: /is set up$/ })).toBeVisible();
  await page.getByRole('link', { name: 'Payment links', exact: true }).click();
  await expect(page.getByText('No payment links yet.', { exact: false })).toBeVisible();
  await expect(card).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Store', exact: true })
    .selectOption(headers['tendr-merchant']!);
  await expect(card).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Create payment link', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Settlement token', exact: true })
    .selectOption('custom');
  await page.getByRole('combobox', { name: 'Asset chain', exact: true }).selectOption('base');
  await page
    .getByRole('combobox', { name: 'Token to receive', exact: true })
    .selectOption(baseUsdc);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
