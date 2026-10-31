// End to end: a payment link in test mode. The merchant creates an open-amount NGN link with its
// secret key; the payer opens `/<merchant>/<link>?mode=test`, types an amount and a note,
// presses "Pay with crypto", lands in the existing checkout at `/<session>`, pays with the
// checkout's test controls, and sees the success screen with "Back to <title>". The fixture store
// receives the signed `payment.succeeded` webhook carrying the payer's note. Everything is
// simulated, as in checkout.spec.ts (whose seed script this reuses).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { blockExternal } from './support/network';
import { API_URL, E2E_CODE_HASH, STORE_URL, WEB_URL } from './support/urls';

const API_DIR = resolve(__dirname, '../../api');

interface Store {
  merchantId: string;
  secretKey: string;
  dashboardHeaders: Record<string, string>;
}
type WebhookEvent = { id: string; type: string; livemode: boolean; data: Record<string, unknown> };

/** A new checkout-ready test-mode store (apps/api/scripts/e2e-checkout-seed.ts). */
function seedStore(): Store {
  const out = execFileSync(
    'npx',
    ['tsx', 'scripts/e2e-checkout-seed.ts', JSON.stringify({ checkoutDomains: [STORE_URL] })],
    {
      cwd: API_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, MERCHANT_ACCOUNT_CODE_HASH_TEST: E2E_CODE_HASH },
    },
  );
  return JSON.parse(out.trim().split('\n').at(-1)!) as Store;
}

async function api<T>(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Registers the fixture store's webhook endpoint for `store` and hands it the signing secret. */
async function registerWebhook(store: Store): Promise<void> {
  const res = await api<{ secret: string }>('/v1/webhooks/endpoints', {
    method: 'POST',
    headers: store.dashboardHeaders,
    body: { url: `${STORE_URL}/webhooks/${store.merchantId}` },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const set = await fetch(`${STORE_URL}/__secret/${store.merchantId}`, {
    method: 'POST',
    body: JSON.stringify({ secret: res.body.secret }),
  });
  expect(set.status).toBe(200);
}

/** Waits for a verified webhook of `type` for the session; asserts nothing was rejected. */
async function webhook(store: Store, sessionId: string, type: string): Promise<WebhookEvent> {
  let found: WebhookEvent | undefined;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${STORE_URL}/__webhooks/${store.merchantId}`);
        const r = (await res.json()) as { events: WebhookEvent[]; rejected: number };
        expect(r.rejected).toBe(0);
        found = r.events.find((e) => e.type === type && e.data.session_id === sessionId);
        return found ? found.type : null;
      },
      { message: `${type} webhook for ${sessionId}`, timeout: 60_000 },
    )
    .toBe(type);
  return found!;
}

test.describe('payment links', () => {
  test.beforeEach(async ({ context }) => {
    await blockExternal(context);
  });

  test('open NGN link: amount and note, pay, checkout, success with "Back to <title>"; the webhook carries the note', async ({
    page,
  }) => {
    const store = seedStore();
    await registerWebhook(store);
    const title = `Tip jar ${Date.now().toString(36)}`;
    const created = await api<{ id: string; url: string }>('/v1/payment_links', {
      method: 'POST',
      headers: { authorization: `Bearer ${store.secretKey}` },
      body: {
        title,
        description: 'Thanks for the coffee.\nEvery bit helps.',
        amount_type: 'open',
        currency: 'NGN',
        note: 'optional',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const linkUrl = created.body.url;
    expect(linkUrl).toMatch(new RegExp(`^${WEB_URL}/[a-z0-9-]+/[a-z0-9-]+\\?mode=test$`));

    // Server-rendered: the title is in the first HTML (chat-app previews), and no session exists
    // until "Pay".
    const html = await (await fetch(linkUrl)).text();
    expect(html).toContain(title);

    await page.goto(linkUrl);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('Test mode — no real money moves')).toBeVisible();
    await expect(page.getByText(/^Minimum ₦/)).toBeVisible();

    await page.getByLabel('Amount (NGN)').fill('5,000');
    await page.getByRole('button', { name: 'Pay with crypto' }).click();
    await expect(page.getByText('Enter an amount like 2500.50.')).toBeVisible();

    await page.getByLabel('Amount (NGN)').fill('5000');
    await expect(page.getByText(/^≈ \$/)).toBeVisible();
    const note = 'For table 4 <thanks>';
    await page.getByLabel(/^Note to .* \(optional\)$/).fill(note);
    await page.getByRole('button', { name: 'Pay with crypto' }).click();

    await page.waitForURL(/\/ses_[0-9A-HJKMNP-TV-Z]{26}$/);
    const sessionId = /\/(ses_[0-9A-HJKMNP-TV-Z]{26})$/.exec(page.url())![1]!;
    await expect(page.getByRole('heading', { name: 'Pay with' })).toBeVisible();

    await page.getByRole('button', { name: 'ETH Base', exact: true }).click();
    await expect(page.getByText('You send')).toBeVisible();
    await page.getByRole('button', { name: 'Pay the exact amount' }).click();
    await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
      timeout: 60_000,
    });

    const back = page.getByRole('link', { name: `Back to ${title}` });
    await expect(back).toHaveAttribute('href', linkUrl);
    await expect(page.getByRole('link', { name: 'Return to store' })).toHaveCount(0);

    const paid = await webhook(store, sessionId, 'payment.succeeded');
    expect(paid.livemode).toBe(false);
    expect(paid.data.payment_link_id).toBe(created.body.id);
    expect(paid.data.payer_note).toBe(note);

    await back.click();
    await page.waitForURL(linkUrl);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  });

  test('an unknown link 404s and is never cached', async ({ page }) => {
    // The root loading.tsx streams the page, so the status is already sent: Next renders the
    // not-found page (and marks it noindex) instead of a 404 status.
    await page.goto(`${WEB_URL}/pay/no-such-merchant-x/no-such-link?mode=test`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    const raw = await fetch(`${WEB_URL}/pay/no-such-merchant-x/no-such-link`);
    expect(raw.headers.get('cache-control')).toContain('no-store');
  });
});
