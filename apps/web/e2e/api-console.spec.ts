import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import routes from '../src/lib/api-console/routes.json';

const API = `http://localhost:${process.env.API_CONSOLE_API_PORT ?? 4300}`;
const MAIL = resolve(__dirname, '../../api/.mail');

const invoiceFixture = {
  id: 'bill_console',
  contractorName: 'Console Contractor',
  email: 'contractor@example.com',
  reference: 'INV-CONSOLE-1',
  description: 'Design services',
  amount: '1000000',
  decimals: 6,
  symbol: 'USDC',
  destination: 'contractor.near',
  destinationChain: 'near',
  destinationAsset: 'nep141:usdc.near',
  status: 'open',
  dueDate: null,
  verifiedAt: '2026-11-09T00:00:00Z',
  createdAt: '2026-11-09T00:00:00Z',
  paidAt: null,
  payout: null,
};
function invoiceQuote() {
  return {
    id: 'npay_console',
    invoiceId: invoiceFixture.id,
    status: 'awaiting_signature',
    asset: 'nep141:usdc.near',
    amount: '1200000',
    destination: invoiceFixture.destination,
    destinationAsset: invoiceFixture.destinationAsset,
    destinationChain: 'near',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    proposalId: null,
    intentHash: null,
    quote: { quote: { amountOut: invoiceFixture.amount } },
  };
}

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

test('invoice API helper preserves the reviewed payout and store without signing or sending it', async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route(`${API}/v1/**`, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 201, json: invoiceQuote() });
  });
  await choose(page, 'POST', '/v1/invoices/:id/payout');
  await page.getByLabel('Path parameter id', { exact: true }).fill(invoiceFixture.id);
  await page.getByLabel('Merchant ID', { exact: true }).fill('mer_invoice');
  await page.getByRole('combobox', { name: /^Mode/ }).selectOption('true');
  await page
    .getByRole('textbox', { name: 'JSON body', exact: true })
    .fill(JSON.stringify({ asset: 'nep141:usdc.near' }));
  const response = await send(page, 'POST', `/v1/invoices/${invoiceFixture.id}/payout`, 201);
  expect((await response.request().allHeaders())['tendr-livemode']).toBe('true');
  // Editing the composer after the response must not change the quote's owner or mode.
  await page.getByLabel('Merchant ID', { exact: true }).fill('mer_other');
  await page.getByRole('combobox', { name: /^Mode/ }).selectOption('false');
  await page.getByRole('button', { name: 'Prepare wallet challenge', exact: true }).click();
  await expect(page.getByLabel('API path', { exact: true })).toHaveValue(
    '/v1/account/native/payouts/:id/challenge',
  );
  await expect(page.getByLabel('Path parameter id', { exact: true })).toHaveValue('npay_console');
  await expect(page.getByLabel('Merchant ID', { exact: true })).toHaveValue('mer_invoice');
  await expect(page.getByRole('combobox', { name: /^Mode/ })).toHaveValue('true');
  await expect(page.getByRole('status')).toContainText('Nothing has been signed or submitted yet');
  expect(requests).toEqual([`${API}/v1/invoices/${invoiceFixture.id}/payout`]);
});

test('invoice dashboard reviews live quotes, shows failures and clears approval when changing mode', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  const requests: { method: string; path: string }[] = [];
  let failQuote = true;
  await page.route(`${API}/v1/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    requests.push({ method: req.method(), path });
    if (path === '/v1/me')
      return route.fulfill({
        json: {
          user: {
            id: 'usr_console',
            email: 'owner@example.com',
            emailVerifiedAt: '2026-11-09T00:00:00Z',
          },
          stores: [
            {
              id: 'mer_invoice',
              name: 'Invoice Business',
              slug: 'invoice-business',
              role: 'owner',
            },
          ],
          passkeys: [{ id: 'pk_console' }],
          csrfToken: 'console-csrf',
        },
      });
    if (path === '/v1/account/recovery') return route.fulfill({ json: { recovery: null } });
    expect((await req.allHeaders())['tendr-merchant']).toBe('mer_invoice');
    expect((await req.allHeaders())['tendr-livemode']).toBe('true');
    if (path === '/v1/invoices/settings')
      return route.fulfill({
        json: { enabled: true, url: 'https://invoice.usetendr.tech/invoice-business' },
      });
    if (path === '/v1/invoices')
      return route.fulfill({ json: { invoices: [invoiceFixture], nextCursor: null } });
    if (path === '/v1/account/balances')
      return route.fulfill({
        json: { balances: [{ asset: 'nep141:usdc.near', amount: '10000000' }] },
      });
    if (path === '/v1/payment_links/settlement-options')
      return route.fulfill({
        json: {
          tokens: [{ asset: 'nep141:usdc.near', decimals: 6, symbol: 'USDC', chain: 'near' }],
        },
      });
    if (path === `/v1/invoices/${invoiceFixture.id}/payout`) {
      expect(req.postDataJSON()).toEqual({ asset: 'nep141:usdc.near' });
      expect((await req.allHeaders())['tendr-csrf']).toBe('console-csrf');
      if (failQuote) {
        failQuote = false;
        return route.fulfill({
          status: 409,
          json: {
            error: { code: 'QUOTE_UNAVAILABLE', message: 'Quote unavailable. Please retry.' },
          },
        });
      }
      return route.fulfill({ status: 201, json: invoiceQuote() });
    }
    throw new Error(`Unexpected invoice request: ${req.method()} ${path}`);
  });
  await page.goto('/dashboard/invoices');
  await expect(page.getByText('Invoices require the live API', { exact: false })).toBeVisible();
  expect(requests.some((r) => r.path.startsWith('/v1/invoices'))).toBe(false);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Open contractor form in this console' }),
  ).toHaveAttribute('href', '/invoice/invoice-business');
  await page.getByRole('button', { name: /INV-CONSOLE-1 · Console Contractor/ }).click();
  await page.getByRole('combobox', { name: /^Pay from/ }).selectOption('nep141:usdc.near');
  await page.getByRole('button', { name: 'Review payment quote', exact: true }).click();
  await expect.poll(() => pageErrors).toEqual([]);
  await expect(page.getByText('Quote unavailable. Please retry.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review payment quote', exact: true }).click();
  await expect(page.getByText('You authorize up to', { exact: false })).toContainText('1.2 USDC');
  await expect(
    page.getByRole('button', { name: 'Settle invoice with wallet passkey' }),
  ).toBeVisible();
  await expect(page.getByText('Receiving wallet:', { exact: false })).toContainText(
    'contractor.near',
  );
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Settle invoice with wallet passkey' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByRole('button', { name: /INV-CONSOLE-1 · Console Contractor/ }).click();
  await expect(
    page.getByRole('button', { name: 'Review payment quote', exact: true }),
  ).toBeDisabled();
  expect(requests.filter((r) => r.method === 'POST')).toEqual([
    { method: 'POST', path: `/v1/invoices/${invoiceFixture.id}/payout` },
    { method: 'POST', path: `/v1/invoices/${invoiceFixture.id}/payout` },
  ]);
});

test('invoice contractor form selects receiving assets and confirms email without a Tendr session', async ({
  page,
  context,
}) => {
  const publicPath = '/v1/invoices/public/invoice-business';
  let submitted = false;
  let verified = false;
  await context.addCookies([{ name: 'console_session_probe', value: 'must-not-send', url: API }]);
  await page.route(`${API}/v1/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    expect(path.startsWith(publicPath)).toBe(true);
    const headers = await req.allHeaders();
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['tendr-merchant']).toBeUndefined();
    if (req.method() === 'GET')
      return route.fulfill({
        json: {
          business: { name: 'Invoice Business', slug: 'invoice-business' },
          tokens: [
            { assetId: 'nep141:usdc.near', symbol: 'USDC', decimals: 6, blockchain: 'near' },
          ],
        },
      });
    if (path === publicPath) {
      expect(req.postDataJSON()).toMatchObject({
        amount: '1.00',
        destinationAsset: 'nep141:usdc.near',
        destination: 'contractor.near',
      });
      submitted = true;
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    expect(req.postDataJSON()).toEqual({ token: 'private-console-token' });
    if (path === `${publicPath}/verify`) verified = true;
    return route.fulfill({
      json: { ...invoiceFixture, status: verified ? 'open' : 'awaiting_verification' },
    });
  });
  await page.goto('/invoice/invoice-business');
  await page.getByLabel('Your name or business', { exact: true }).fill('Console Contractor');
  await page.getByLabel('Email', { exact: true }).fill('contractor@example.com');
  await page.getByLabel('Invoice reference', { exact: true }).fill('INV-CONSOLE-1');
  await page.getByLabel('What is this invoice for?', { exact: true }).fill('Design services');
  await page.getByRole('combobox', { name: /^Receiving network/ }).selectOption('near');
  await page.getByRole('combobox', { name: /^Receiving token/ }).selectOption('nep141:usdc.near');
  await page.getByLabel('Amount to receive (in the selected token)', { exact: true }).fill('1.00');
  await page.getByLabel('Receiving wallet address', { exact: true }).fill('contractor.near');
  await page.getByRole('button', { name: 'Email me a verification link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(submitted).toBe(true);
  await page.goto('/invoice/invoice-business#token=private-console-token');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Verify email & send invoice' })).toBeVisible();
  expect(verified).toBe(false);
  await page.getByRole('button', { name: 'Verify email & send invoice' }).click();
  await expect(page.getByText('Awaiting payment', { exact: true })).toBeVisible();
  expect(verified).toBe(true);
});

test('catalog, real health, auth failures, token isolation, and clearing', async ({ page }) => {
  await expect(
    page.getByRole('navigation', { name: 'API endpoints' }).getByRole('button'),
  ).toHaveCount(routes.length);
  expect(routes.some((r) => r.path === '/v1/account/native/payouts/:id/submit')).toBe(true);
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

test('dashboard creates a usable API key, forgets its secret and revokes access', async ({
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
  await page.goto('/signup');
  await page.getByLabel('Email', { exact: true }).fill(`console-keys-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Send me a link' }).click();
  await page.getByRole('link', { name: 'Open local inbox', exact: true }).click();
  await page.getByRole('link', { name: 'Verify email and continue', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm my email', exact: true }).click();
  await page.getByRole('button', { name: 'Create my passkey', exact: true }).click();
  await page.getByLabel('Store name', { exact: true }).fill(`Key Store ${Date.now()}`);
  await page.getByRole('button', { name: 'Create store', exact: true }).click();
  await expect(page.getByRole('heading', { name: /is set up$/ })).toBeVisible();
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await page.getByLabel('Key name', { exact: true }).fill('Checkout backend');
  await page.getByRole('button', { name: 'Create test key', exact: true }).click();
  const field = page.getByLabel('Secret API key', { exact: true });
  await expect(field).toBeVisible();
  const secret = await field.inputValue();
  const ping = () =>
    page.request.get(`${API}/v1/ping`, { headers: { Authorization: `Bearer ${secret}` } });
  expect((await ping()).status()).toBe(200);
  expect(
    await page.evaluate(
      (value) => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value),
      secret,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(page.getByText('No API keys in live mode yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Checkout backend', { exact: true })).toBeVisible();
  await expect(field).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Checkout backend', { exact: true })).toBeVisible();
  await expect(field).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Revoke Checkout backend', exact: true }).click();
  expect((await ping()).status()).toBe(200);
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await expect(page.getByText(/secret · Revoked/)).toBeVisible();
  expect((await ping()).status()).toBe(401);
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
