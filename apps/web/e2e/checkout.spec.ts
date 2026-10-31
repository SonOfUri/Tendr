// End to end: the shopper checkout in test mode — the hosted page, the modal and the inline widget
// (tendr.js on the fixture store), and the edge cases. Everything is simulated: the simulated 1Click
// provider (in the e2e server's own Redis DB), the test screening blocklist
// (SCREENING_TEST_BLOCKLIST, default 0x…dead) and the in-memory NEAR client. No network calls.
// Each test seeds its own store (apps/api/scripts/e2e-checkout-seed.ts) and its own session; a
// simulated deposit address hashes the quote request (merchant account included), so tests never
// share simulated deposits either.
//
// The fixture store (e2e/fixtures/merchant-server.mjs) receives the webhooks and verifies their
// signatures with the endpoint's shared secret.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type ConsoleMessage, type FrameLocator, type Page } from '@playwright/test';
import { blockExternal } from './support/network';
import { API_URL, E2E_CODE_HASH, OTHER_STORE_URL, STORE_URL, WEB_URL } from './support/urls';

const API_DIR = resolve(__dirname, '../../api');
/** On the test screening blocklist (the API's SCREENING_TEST_BLOCKLIST default). */
const SANCTIONED = '0x000000000000000000000000000000000000dEaD';
const HOLD_NOTICE =
  'These funds came from a sanctioned address. Tendr cannot freeze them; you are responsible for not using them; get legal advice.';
const FRAME = 'iframe[title="Tendr checkout"]';

interface Store {
  merchantId: string;
  secretKey: string;
  dashboardHeaders: Record<string, string>;
}
interface Session {
  id: string;
  client_secret: string;
  url: string;
  externalRef: string;
}
type Ui = Pick<Page, 'getByRole' | 'getByText'> | FrameLocator;
type WebhookEvent = { id: string; type: string; livemode: boolean; data: Record<string, unknown> };

/** A new test-mode store (its own merchant) whose checkout may be framed by `checkoutDomains`. */
function seedStore(checkoutDomains: string[] = [STORE_URL]): Store {
  const out = execFileSync(
    'npx',
    ['tsx', 'scripts/e2e-checkout-seed.ts', JSON.stringify({ checkoutDomains })],
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

/** A checkout session, created the way a store's server does (secret key). */
async function createSession(store: Store, amount = '25.00'): Promise<Session> {
  const externalRef = `order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await api<Omit<Session, 'externalRef'>>('/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${store.secretKey}` },
    body: {
      amount,
      amount_currency: 'USD',
      external_ref: externalRef,
      success_url: `${STORE_URL}/thanks`,
      cancel_url: `${STORE_URL}/cancel`,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  // The root form (`/<session>`): on localhost in development the middleware rewrites it to /pay.
  expect(res.body.url).toBe(`${WEB_URL}/${res.body.id}#cs=${res.body.client_secret}`);
  return { ...res.body, externalRef };
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

/** The webhooks the fixture store received and verified (and how many it rejected). */
async function received(store: Store): Promise<{ events: WebhookEvent[]; rejected: number }> {
  const res = await fetch(`${STORE_URL}/__webhooks/${store.merchantId}`);
  return (await res.json()) as { events: WebhookEvent[]; rejected: number };
}

/** Waits for a verified webhook of `type` for the session; asserts nothing was rejected. */
async function webhook(store: Store, session: Session, type: string): Promise<WebhookEvent> {
  let found: WebhookEvent | undefined;
  await expect
    .poll(
      async () => {
        const r = await received(store);
        expect(r.rejected).toBe(0);
        found = r.events.find((e) => e.type === type && e.data.session_id === session.id);
        return found ? found.type : null;
      },
      { message: `${type} webhook for ${session.id}`, timeout: 60_000 },
    )
    .toBe(type);
  return found!;
}

/** The token step: pay with ETH on Base, and wait for the price. */
async function chooseEth(ui: Ui): Promise<void> {
  await ui.getByRole('button', { name: 'ETH Base', exact: true }).click();
  await expect(ui.getByText('You send')).toBeVisible();
}

/** The checkout's own test-mode panel stands in for the shopper's deposit. */
async function simulate(ui: Ui, label: string): Promise<void> {
  await ui.getByRole('button', { name: label }).click();
}

/** Neither the URL nor Next's history state may keep the client secret. */
async function expectNoSecretInUrl(page: Page): Promise<void> {
  const where = await page.evaluate(() => `${location.href} ${JSON.stringify(history.state)}`);
  expect(where).not.toContain('cs=');
}

const events = (page: Page) =>
  page.evaluate(() => (window as unknown as { __events: Record<string, unknown>[] }).__events);
const eventTypes = async (page: Page) => (await events(page)).map((e) => e.type as string);

test.describe('checkout', () => {
  test.beforeEach(async ({ context }) => {
    await blockExternal(context);
  });

  test('hosted: choose a token, quote, pay, settled, back to the store; the store verifies the signed webhook', async ({
    page,
  }) => {
    const store = seedStore();
    await registerWebhook(store);
    const session = await createSession(store);

    // The boot script that strips `#cs=` is in the initial HTML's <head>, before the first RSC
    // chunk, as a parser-blocking script (no async/defer) that the server serves.
    const html = await (await fetch(`${WEB_URL}/pay/${session.id}`)).text();
    const tag = /<script src="\/checkout-boot\.js"( [^>]*)?><\/script>/.exec(html);
    expect(tag, 'boot script tag').not.toBeNull();
    expect(tag![0]).not.toMatch(/\b(async|defer|type=)/);
    const firstChunk = html.indexOf('self.__next_f.push([1,"0:');
    expect(firstChunk).toBeGreaterThan(-1);
    expect(tag!.index).toBeLessThan(html.indexOf('</head>'));
    expect(tag!.index).toBeLessThan(firstChunk);
    const bootJs = await fetch(`${WEB_URL}/checkout-boot.js`);
    expect(bootJs.headers.get('content-type')).toMatch(/javascript/);
    expect(await bootJs.text()).toContain('__tendrCheckoutSecret');

    await page.goto(session.url);
    await expect(page.getByRole('heading', { name: 'Pay with' })).toBeVisible();
    await expectNoSecretInUrl(page);
    // A refresh keeps the checkout working (the secret is in sessionStorage), still not in the URL.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Pay with' })).toBeVisible();
    await expectNoSecretInUrl(page);

    await chooseEth(page);
    await expectNoSecretInUrl(page);
    await simulate(page, 'Pay the exact amount');
    await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
      timeout: 60_000,
    });
    await expectNoSecretInUrl(page);

    await page.getByRole('link', { name: 'Return to store' }).click();
    await page.waitForURL(`${STORE_URL}/thanks`);

    const paid = await webhook(store, session, 'payment.succeeded');
    expect(paid.livemode).toBe(false);
    expect(paid.data.external_ref).toBe(session.externalRef);
  });

  test('modal: tendr.js on a registered store opens the checkout, gets tendr:complete, closes on Esc', async ({
    page,
  }) => {
    const store = seedStore([STORE_URL]);
    const session = await createSession(store);
    await page.goto(`${STORE_URL}/?session=${encodeURIComponent(session.url)}`);

    const opener = page.getByRole('button', { name: 'Pay with crypto' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Tendr checkout' });
    await expect(dialog).toBeVisible();
    // The session URL, plus `?embed=modal` ahead of the untouched #cs fragment.
    const [path, fragment] = session.url.split('#');
    await expect(page.locator(FRAME)).toHaveAttribute('src', `${path}?embed=modal#${fragment}`);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await expect.poll(() => eventTypes(page)).toContain('ready');

    const frame = page.frameLocator(FRAME);
    await chooseEth(frame);
    await simulate(frame, 'Pay the exact amount');
    await expect(frame.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
      timeout: 60_000,
    });
    await expect.poll(() => eventTypes(page), { timeout: 30_000 }).toContain('complete');
    expect(await events(page)).toContainEqual({
      type: 'complete',
      sessionId: session.id,
      status: 'settled',
    });

    // Focus is inside the checkout frame; Esc there asks the store page to close the modal.
    await frame.getByRole('heading', { name: /Payment complete/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator(FRAME)).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect((await events(page)).at(-1)).toEqual({ type: 'close' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pay');
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');

    // Reopened, the checkout's own close control closes it too.
    await opener.click();
    await page.frameLocator(FRAME).getByRole('button', { name: 'Close checkout' }).click();
    await expect(page.locator(FRAME)).toHaveCount(0);
    expect((await eventTypes(page)).filter((t) => t === 'close')).toHaveLength(2);
    expect(
      await page.evaluate(() => (window as unknown as { __errors: string[] }).__errors),
    ).toEqual([]);
  });

  test('modal: on a no-referrer store page it still talks to the store, and the overlay closes itself', async ({
    page,
    browser,
  }) => {
    const store = seedStore([STORE_URL]);
    const session = await createSession(store);
    const query = `?policy=no-referrer&session=${encodeURIComponent(session.url)}`;

    // The store page sends `Referrer-Policy: no-referrer`; the frame's own referrerpolicy still
    // tells the checkout which page framed it, so tendr:ready arrives.
    const res = await page.goto(`${STORE_URL}/${query}`);
    expect(res!.headers()['referrer-policy']).toBe('no-referrer');
    await page.getByRole('button', { name: 'Pay with crypto' }).click();
    await expect.poll(() => eventTypes(page)).toContain('ready');
    // The overlay's own close button (outside the checkout frame) closes it.
    await page.getByRole('dialog').getByRole('button', { name: 'Close checkout' }).click();
    await expect(page.locator(FRAME)).toHaveCount(0);
    expect((await events(page)).at(-1)).toEqual({ type: 'close' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pay');
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');

    // On an unregistered origin the checkout can't speak at all (framing refused): the overlay's
    // button still lets the shopper out.
    const other = await browser.newContext();
    await blockExternal(other);
    const otherPage = await other.newPage();
    await otherPage.goto(`${OTHER_STORE_URL}/${query}`);
    await otherPage.getByRole('button', { name: 'Pay with crypto' }).click();
    await expect(otherPage.getByRole('dialog')).toBeVisible();
    expect(await otherPage.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await otherPage.getByRole('dialog').getByRole('button', { name: 'Close checkout' }).click();
    await expect(otherPage.getByRole('dialog')).toHaveCount(0);
    expect(await eventTypes(otherPage)).toEqual(['close']);
    expect(await otherPage.evaluate(() => document.body.style.overflow)).toBe('');
    await other.close();
  });

  test('widget: inline on a registered store it sizes itself; on an unregistered origin framing is refused', async ({
    page,
    browser,
  }) => {
    const store = seedStore([STORE_URL]);
    const session = await createSession(store);
    const query = `?mode=widget&session=${encodeURIComponent(session.url)}`;

    await page.goto(`${STORE_URL}/${query}`);
    await expect.poll(() => eventTypes(page)).toContain('ready');
    const iframe = page.locator(FRAME);
    // tendr:resize: the frame takes the checkout page's height.
    const contentHeight = () =>
      page
        .frame({ url: (u) => u.pathname === `/${session.id}` })!
        .evaluate(() => Math.ceil(document.querySelector('.pay')!.getBoundingClientRect().height));
    await expect
      .poll(async () => {
        const frameHeight = parseFloat(await iframe.evaluate((el) => el.style.height));
        return Math.abs(frameHeight - (await contentHeight()));
      })
      .toBeLessThanOrEqual(1);
    expect(await iframe.evaluate((el) => el.style.height)).not.toBe('640px');
    // Esc inside the widget never closes anything.
    await page.frameLocator(FRAME).getByRole('heading', { name: 'Pay with' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect(await eventTypes(page)).not.toContain('close');
    await expect(iframe).toHaveCount(1);

    // The same store page on an origin that isn't registered: the browser refuses the frame (CSP
    // frame-ancestors), so the checkout never loads and never says it is ready.
    const other = await browser.newContext();
    await blockExternal(other);
    const otherPage = await other.newPage();
    const refusals: string[] = [];
    otherPage.on('console', (m: ConsoleMessage) => {
      if (/frame-ancestors/.test(m.text())) refusals.push(m.text());
    });
    await otherPage.goto(`${OTHER_STORE_URL}/${query}`);
    await expect.poll(() => refusals.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(refusals[0]).toContain(STORE_URL);
    expect(refusals[0]).not.toContain(OTHER_STORE_URL);
    await otherPage.waitForTimeout(3000);
    expect(await eventTypes(otherPage)).toEqual([]);
    const loaded = otherPage.frame({ url: (u) => u.pathname === `/${session.id}` });
    expect(loaded === null || (await loaded.locator('.pay').count()) === 0).toBe(true);
    await other.close();
  });

  test.describe('edge cases', () => {
    test('underpay, then sending the rest completes the order', async ({ page }) => {
      const store = seedStore();
      await registerWebhook(store);
      const session = await createSession(store);
      await page.goto(session.url);
      await chooseEth(page);
      await simulate(page, 'Pay too little');
      await expect(
        page.getByRole('heading', { name: 'You sent less than the full amount' }),
      ).toBeVisible({ timeout: 60_000 });
      await simulate(page, 'Send the rest');
      await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
        timeout: 60_000,
      });
      await webhook(store, session, 'payment.succeeded');
    });

    test('a late payment is never paid: the shopper is told, the store gets payment.late', async ({
      page,
    }) => {
      const store = seedStore();
      await registerWebhook(store);
      const session = await createSession(store);
      await page.goto(session.url);
      await chooseEth(page);
      // The checkout closes before the money arrives (the store cancels it: the same EXPIRED state
      // as a timeout, without waiting 60 s+ for the expiry job).
      const expired = await api(`/v1/checkout/sessions/${session.id}/expire`, {
        method: 'POST',
        headers: { authorization: `Bearer ${store.secretKey}` },
        body: {},
      });
      expect(expired.status, JSON.stringify(expired.body)).toBe(200);
      await expect(page.getByRole('heading', { name: 'This checkout has expired' })).toBeVisible({
        timeout: 30_000,
      });
      // Then the shopper's deposit arrives at the old address (the page no longer offers it).
      const sim = await api('/v1/checkout/client/simulate', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.client_secret}` },
        body: { scenario: 'late' },
      });
      expect(sim.status, JSON.stringify(sim.body)).toBe(200);
      await expect(
        page.getByRole('heading', { name: 'Your payment arrived too late' }),
      ).toBeVisible({ timeout: 60_000 });
      await webhook(store, session, 'payment.late');
      const { events: all } = await received(store);
      expect(all.filter((e) => e.data.session_id === session.id).map((e) => e.type)).not.toContain(
        'payment.succeeded',
      );
    });

    test('an overpayment under $1 is kept by the store', async ({ page }) => {
      const store = seedStore();
      await registerWebhook(store);
      // $5: the simulated overpay sends 10% extra, about $0.50.
      const session = await createSession(store, '5.00');
      await page.goto(session.url);
      await chooseEth(page);
      await expect(page.getByText("Leftovers under $1 aren't returned.")).toBeVisible();
      await simulate(page, 'Pay too much');
      await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByText(/Leftovers under \$1 aren't returned, so it stays with the store/),
      ).toBeVisible();
      const paid = await webhook(store, session, 'payment.succeeded');
      expect(paid.data.kept_small_overpayment).toBe(true);
    });

    test('a sanctioned wallet is refused at quote time; manual send stays on offer', async ({
      page,
    }) => {
      // A connected wallet supplies its address as the quote's refund address; AppKit can't be
      // driven here, so the same server path is exercised directly and through the return-address
      // field (which makes the identical quote call).
      const store = seedStore();
      const session = await createSession(store);
      const shopper = { authorization: `Bearer ${session.client_secret}` };
      const refused = await api<{ error: { code: string } }>('/v1/checkout/client/quote', {
        method: 'POST',
        headers: shopper,
        body: {
          origin_asset: 'nep141:base.omft.near',
          refund_address: SANCTIONED,
          refund_chain: 'base',
        },
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('WALLET_NOT_ALLOWED');

      await page.goto(session.url);
      await chooseEth(page);
      const deposit = page.locator('.pay-section .address').first();
      const addressBefore = await deposit.textContent();
      await page
        .getByLabel(/Your address on Base, in case we need to send money back/)
        .fill(SANCTIONED);
      await page.getByRole('button', { name: 'Save address' }).click();
      await expect(
        page.getByText(
          "This address can't be used for this payment. Use a different one, or leave it empty.",
        ),
      ).toBeVisible();
      // No money moved; the manual send (same deposit address and amount) is still offered.
      await expect(page.getByText('or send it yourself')).toBeVisible();
      await expect(deposit).toHaveText(addressBefore!);
      await expect(page.getByRole('button', { name: 'Pay the exact amount' })).toBeVisible();
      const view = await api<{ status: string; payments: unknown[] }>(
        '/v1/checkout/client/session',
        { headers: shopper },
      );
      expect(view.body.status).toBe('PENDING_DEPOSIT');
      expect(view.body.payments).toEqual([]);
    });

    test('a manual send from a sanctioned address is held: the shopper sees it, the store gets a review item', async ({
      page,
    }) => {
      const store = seedStore();
      await registerWebhook(store);
      const session = await createSession(store);
      await page.goto(session.url);
      await chooseEth(page);
      // The deposit arrives from a sanctioned sender (the test panel has no sender choice).
      const sim = await api('/v1/checkout/client/simulate', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.client_secret}` },
        body: { scenario: 'exact', sender_address: SANCTIONED },
      });
      expect(sim.status, JSON.stringify(sim.body)).toBe(200);
      await expect(
        page.getByRole('heading', { name: "We couldn't complete this payment" }),
      ).toBeVisible({ timeout: 60_000 });

      await webhook(store, session, 'payment.held');
      // The merchant dashboard's review queue lists it, with the hold notice.
      const review = await api<{
        notice: string;
        held: { session_id: string; status: string; held_reason: string; notice: string }[];
      }>('/v1/review', { headers: store.dashboardHeaders });
      expect(review.status).toBe(200);
      const item = review.body.held.find((h) => h.session_id === session.id);
      expect(item).toMatchObject({ status: 'HELD', held_reason: 'sanctions', notice: HOLD_NOTICE });
      const { events: all } = await received(store);
      expect(all.filter((e) => e.data.session_id === session.id).map((e) => e.type)).not.toContain(
        'payment.succeeded',
      );
    });
  });
});
