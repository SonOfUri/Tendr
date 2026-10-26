// End to end: the WooCommerce plugin, in test mode, with no network beyond this machine.
//
// Two WordPress + WooCommerce sites run in wp-env (Docker): A on :8892 and B on :8893
// (apps/woocommerce/.wp-env.e2e*.json; global setup builds the plugin zip and resets both). The
// plugin is installed from the zip through each site's "Upload Plugin" page and connects to the
// same local API (:4100, in-memory NEAR running the merchant-account contract, simulated 1Click,
// fixed test FX rates) and web app (:3100) the other specs use (playwright.woocommerce.config.ts).
// WordPress calls the API at host.docker.internal; the API delivers webhooks to localhost:8892/3.
//
// The steps run in order on one store:
//  1. Connect A through the popup: sign up → store → passkey → recovery kit → approve. No `tdr_` /
//     `whsec_` string ever appears in any WP admin HTML (checked on every admin response).
//     Connect B to the same store.
//  2. Admin purchase in the Blocks checkout → simulate exact → Processing; "You got paid" mailed.
//  3. An NGN store converts at checkout; the order note has the rate.
//  4. Refund 0.50 → not refunded → approve in the dashboard → refund.sent → partially refunded.
//  5. B gets only its own events, none of A's.
//  6. Re-connect A → the old key gets 401; then a logged-out guest does not see the method in the
//     Blocks checkout (test mode); then Disconnect → that key gets 401 too.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type Page,
  type Response,
} from '@playwright/test';
import { blockExternal } from './support/network';
import { API_URL, WEB_URL } from './support/urls';
import { PRODUCT_NGN, PRODUCT_USD } from './woocommerce/global-setup';
import { SITES, WP_ADMIN, wp, wpPhp, wpSql, type SiteId } from './woocommerce/wp';

const MAIL_DIR = resolve(__dirname, '../../api/.mail');
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const OWNER = `woo-owner-${run}@example.com`;
const STORE = `Woo E2E ${run}`;
const FRAME = 'iframe[title="Tendr checkout"]';
/** Secret-shaped strings that must never reach a WP admin page. */
const SECRET = /tdr_(test|live|pk)_|whsec_/;
const REFUND_ALERT =
  'Refund of $0.50 sent to your Tendr signers for approval. WooCommerce will record it once it is sent.';
/** The settlement asset in test mode (the simulated 1Click fixture USDC on NEAR). */
const SETTLEMENT_ASSET = 'nep141:usdc.test';

type Credential = Record<string, unknown>;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** A virtual platform authenticator on `page`, optionally holding existing passkeys. */
async function authenticator(
  page: Page,
  credentials: Credential[] = [],
): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  for (const credential of credentials) {
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: credential as never,
    });
  }
  return { cdp, id: authenticatorId };
}

/** The link in the newest mail of `template` to `to` (the API's log mailer). */
async function mail(
  to: string,
  template: string,
  after: number,
): Promise<{ data: Record<string, unknown>; subject?: string }> {
  let found: { data: Record<string, unknown>; subject?: string } | null = null;
  await expect
    .poll(
      () => {
        let files: string[] = [];
        try {
          files = readdirSync(MAIL_DIR).filter((f) => f.endsWith('.json'));
        } catch {
          return null;
        }
        const matches = files
          .map((f) => resolve(MAIL_DIR, f))
          .filter((f) => statSync(f).mtimeMs >= after)
          .map(
            (f) =>
              JSON.parse(readFileSync(f, 'utf8')) as {
                to: string;
                template: string;
                subject?: string;
                data: Record<string, unknown>;
              },
          )
          .filter((m) => m.to === to && m.template === template);
        found = matches.at(-1) ?? null;
        return found ? template : null;
      },
      { message: `${template} mail to ${to}`, timeout: 60_000 },
    )
    .toBe(template);
  return found!;
}

/** The API answer to `GET path` with `key`. */
async function apiStatus(path: string, key: string): Promise<number> {
  const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return res.status;
}

/** Calls the API from a dashboard page, as the dashboard does (cookie session, CSRF, store). */
async function dashboardApi<T>(
  page: Page,
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ api, path, init }) => {
      const csrf = document.cookie
        .split(';')
        .map((c) => c.trim().split('='))
        .find(([k]) => k === 'tendr_csrf')?.[1];
      const me = (await (await fetch(`${api}/v1/me`, { credentials: 'include' })).json()) as {
        stores: { id: string }[];
      };
      const headers: Record<string, string> = {
        accept: 'application/json',
        'tendr-merchant': me.stores[0]!.id,
        'tendr-livemode': 'false',
      };
      if (csrf) headers['tendr-csrf'] = decodeURIComponent(csrf);
      if (init.json !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${api}${path}`, {
        method: init.method ?? 'GET',
        credentials: 'include',
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { api: API_URL, path, init },
  );
}

/** Watches every WP admin HTML response in `context` for secret-shaped strings. */
function watchAdminHtml(context: BrowserContext): { seen: string[]; leaks: string[] } {
  const seen: string[] = [];
  const leaks: string[] = [];
  const sites = Object.values(SITES).map((s) => s.url);
  context.on('response', (res: Response) => {
    const url = res.url();
    if (!sites.some((s) => url.startsWith(`${s}/wp-admin`))) return;
    if (!(res.headers()['content-type'] ?? '').includes('text/html')) return;
    void res
      .text()
      .then((html) => {
        seen.push(url);
        if (SECRET.test(html)) leaks.push(url);
      })
      .catch(() => undefined);
  });
  return { seen, leaks };
}

async function login(page: Page, site: SiteId): Promise<void> {
  await page.goto(`${SITES[site].url}/wp-login.php`);
  await page.locator('#user_login').fill(WP_ADMIN.user);
  await page.locator('#user_pass').fill(WP_ADMIN.password);
  await page.locator('#wp-submit').click();
  await page.waitForURL(/wp-admin/);
}

/** Installs the built zip through Plugins → Add New → Upload Plugin, and activates it. */
async function installZip(page: Page, site: SiteId): Promise<void> {
  const zip = process.env.TENDR_E2E_ZIP;
  expect(zip, 'global setup builds the zip').toBeTruthy();
  await page.goto(`${SITES[site].url}/wp-admin/plugin-install.php?tab=upload`);
  await page.locator('#pluginzip').setInputFiles(zip!);
  await page.locator('#install-plugin-submit').click();
  await expect(page.getByText('Plugin installed successfully.')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Activate Plugin' }).click();
  await expect(page.getByText('Plugin activated.')).toBeVisible();
}

const settingsUrl = (site: SiteId) =>
  `${SITES[site].url}/wp-admin/admin.php?page=wc-settings&tab=checkout&section=tendr`;

/**
 * Clicks a Connect button on the settings page and returns the popup, with an authenticator that
 * holds `credentials`. Also returns the `/connect` document response (for its headers).
 */
async function openConnect(
  page: Page,
  button: string,
  credentials: Credential[],
): Promise<{
  popup: Page;
  auth: { cdp: CDPSession; id: string };
  connectDoc: Promise<Response | null>;
}> {
  // Listen before the click: the popup reaches /connect (through a redirect) at once.
  const connectDoc = page
    .context()
    .waitForEvent('response', {
      predicate: (r) =>
        r.url().startsWith(`${WEB_URL}/connect?`) && r.request().resourceType() === 'document',
      timeout: 60_000,
    })
    .catch(() => null);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: button }).click();
  const popup = await popupPromise;
  const auth = await authenticator(popup, credentials);
  return { popup, auth, connectDoc };
}

/** Approve in the popup, then the settings page (the opener) reloads by itself. */
async function approve(popup: Page, opener: Page, site: SiteId): Promise<void> {
  const host = new URL(SITES[site].url).host;
  await expect(popup.getByRole('heading', { name: `Connect ${host} to ${STORE}?` })).toBeVisible();
  const closed = popup.waitForEvent('close', { timeout: 60_000 });
  await popup.getByRole('button', { name: 'Approve' }).click();
  await closed;
  // No manual reload: the popup reported back through window.opener and the page reloaded.
  await expect(opener.getByText(`Connected to ${STORE}`).first()).toBeVisible({ timeout: 30_000 });
}

/** The site's stored test secret key (read inside WordPress, never shown in the admin). */
const testKey = (site: SiteId) =>
  wpPhp(site, "$c = Tendr_Credentials::get('test'); echo $c ? $c['secret_key'] : '';");

/** The order's status, through the plugin's public status route (the order key is the credential). */
async function orderStatus(site: SiteId, key: string): Promise<string> {
  const res = await fetch(`${SITES[site].url}/wp-json/tendr/v1/order-status/${key}`);
  return ((await res.json()) as { status: string }).status;
}

const orderNotes = (site: SiteId, id: number) =>
  wpPhp(
    site,
    `foreach (wc_get_order_notes(array('order_id' => ${id})) as $n) { echo wp_strip_all_tags($n->content), "\\n"; }`,
  );

/**
 * Pays an order-pay page's modal with a NEAR token through the checkout's test panel ("Pay the
 * exact amount"), then lands on the thank-you page. A NEAR sender means a refund can go straight
 * back (no swap route needed).
 */
async function payInModal(page: Page): Promise<void> {
  await expect(page.getByRole('dialog', { name: 'Tendr checkout' })).toBeVisible({
    timeout: 60_000,
  });
  const frame = page.frameLocator(FRAME);
  await frame.getByPlaceholder('Search tokens or networks').fill('wNEAR');
  await frame
    .getByRole('button', { name: /wNEAR\s*NEAR/ })
    .first()
    .click();
  await expect(frame.getByText('You send')).toBeVisible({ timeout: 60_000 });
  await frame.getByRole('button', { name: 'Pay the exact amount' }).click();
  // On `tendr:complete` the plugin's script takes the shopper to the order's thank-you page.
  await page.waitForURL(/order-received/, { timeout: 90_000 });
}

/** The Blocks checkout's billing address (WooCommerce keeps it for the next order). */
async function fillBilling(page: Page): Promise<void> {
  const billing = page.getByRole('group', { name: 'Billing address' });
  const first = billing.getByLabel('First name');
  if ((await first.inputValue()) !== '') return;
  await billing.getByLabel('Country/Region').selectOption('US');
  await first.fill('Ada');
  await billing.getByLabel('Last name').fill('Owner');
  await billing.getByLabel('Address', { exact: true }).fill('1 Market St');
  await billing.getByLabel('City').fill('San Francisco');
  await billing.getByLabel('State').selectOption('CA');
  await billing.getByLabel('ZIP Code').fill('94105');
}

/** Blocks checkout as the logged-in admin: one product, "Pay with crypto". Returns the order. */
async function buyInBlocksCheckout(
  page: Page,
  site: SiteId,
  productId: string,
): Promise<{ id: number; key: string }> {
  const url = SITES[site].url;
  await page.goto(`${url}/?add-to-cart=${productId}`);
  await page.goto(`${url}/checkout/`);
  await expect(page.locator('.wp-block-woocommerce-checkout')).toBeVisible();
  await fillBilling(page);
  await page.getByLabel('Pay with crypto').check();
  await page.locator('.wc-block-components-checkout-place-order-button').click();
  await page.waitForURL(/order-pay\/\d+/, { timeout: 60_000 });
  const u = new URL(page.url());
  const id = Number(/order-pay\/(\d+)/.exec(u.pathname)![1]);
  const key = u.searchParams.get('key')!;
  expect(key).toMatch(/^wc_order_/);
  await payInModal(page);
  return { id, key };
}

const productId = (site: SiteId, name: string) =>
  wpPhp(
    site,
    `$p = get_posts(array('post_type' => 'product', 'title' => '${name}', 'fields' => 'ids')); echo $p[0];`,
  );

// ─── the flow ────────────────────────────────────────────────────────────────

test.describe.serial('WooCommerce plugin', () => {
  let context: BrowserContext;
  let admin: Page;
  let adminB: Page;
  let dash: Page;
  let html: { seen: string[]; leaks: string[] };
  let passkeys: Credential[] = [];
  let keyA = '';
  let paid: { id: number; key: string };

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    await blockExternal(context);
    html = watchAdminHtml(context);
    admin = await context.newPage();
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('1. install the zip and connect through the popup: sign up, store, passkey, kit, approve', async () => {
    await login(admin, 'a');
    await installZip(admin, 'a');
    await admin.goto(settingsUrl('a'));
    await expect(admin.getByRole('button', { name: 'Connect to tendr' })).toBeEnabled();

    const { popup, auth, connectDoc } = await openConnect(admin, 'Connect to tendr', []);
    // The popup must keep window.opener: no COOP that would sever it on the way back.
    const doc = await connectDoc;
    expect(doc, 'the /connect document response').not.toBeNull();
    const coop = doc!.headers()['cross-origin-opener-policy'];
    expect(coop === undefined || coop === 'unsafe-none', `COOP: ${coop}`).toBe(true);
    await expect(popup.getByText('Site asking to connect')).toBeVisible();
    await expect(popup.locator('.connect-origin .address')).toHaveText(SITES.a.url);

    // Sign up by email link, opened in the popup itself (its sessionStorage keeps the params).
    const since = Date.now() - 1000;
    await popup.getByLabel('Email').fill(OWNER);
    await popup.getByRole('button', { name: 'Create an account' }).click();
    await expect(popup.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    const verify = await mail(OWNER, 'verify_email', since);
    await popup.goto(String(verify.data.url));
    await popup.getByRole('button', { name: 'Confirm my email' }).click();
    await popup.getByRole('button', { name: 'Create my passkey' }).click();

    // Back on /connect: the store, then its recovery kit.
    await expect(popup.getByRole('heading', { name: 'Name your store' })).toBeVisible();
    await popup.getByLabel('Store name').fill(STORE);
    await popup.getByRole('button', { name: 'Create store' }).click();
    await expect(popup.getByRole('heading', { name: 'Save your recovery kit' })).toBeVisible();
    await popup.getByRole('button', { name: 'Create recovery kit' }).click();
    const groups = await popup.locator('.kit-code .kit-group').allTextContents();
    expect(groups).toHaveLength(14);
    await popup.getByRole('button', { name: 'I’ve saved it' }).click();
    await popup.getByLabel(/second group of your kit/).fill(groups[1]!);
    await popup.getByRole('button', { name: 'Confirm and turn on' }).click();
    await expect(popup.getByRole('heading', { name: 'Where your payments go' })).toBeVisible();
    await popup.getByRole('button', { name: 'Continue' }).click();

    // The passkey is reused by the dashboard and the other popups.
    passkeys = (await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.id }))
      .credentials as unknown as Credential[];
    expect(passkeys.length).toBeGreaterThan(0);
    // Approve: the real code exchange (PKCE, server to server) happens on the way back.
    await approve(popup, admin, 'a');
    await expect(admin.getByText('Test mode', { exact: true })).toBeVisible();
    keyA = testKey('a');
    expect(keyA).toMatch(/^tdr_test_/);
    expect(await apiStatus('/v1/connect/status', keyA)).toBe(200);

    // Go live reports what is missing, and the site stays in test mode.
    await admin.getByRole('button', { name: 'Switch to live mode' }).click();
    await expect(
      admin.getByText('This site stays in test mode until your store is ready to go live:'),
    ).toBeVisible();
    await expect(admin.getByText('Test mode', { exact: true })).toBeVisible();

    // The store's payout: settle in test USDC into its own account. The dashboard has no settlement
    // screen yet, so the proposal is drafted through the API and approved in the dashboard.
    dash = await context.newPage();
    await authenticator(dash, passkeys);
    await dash.goto(`${WEB_URL}/dashboard`);
    await expect(
      dash
        .locator('section.card', { has: dash.getByRole('heading', { name: 'Test account' }) })
        .getByText('Ready'),
    ).toBeVisible({ timeout: 60_000 });
    const draft = await dashboardApi<{ id: string }>(dash, '/v1/account/proposals', {
      method: 'POST',
      json: {
        action: {
          set_settlement: {
            dest_asset: SETTLEMENT_ASSET,
            payout_mode: 'intents',
            saved_address_id: null,
          },
        },
      },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    await dash.goto(`${WEB_URL}/dashboard/approvals/${draft.body.id}`);
    await dash.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(dash.locator('.card-head .status')).toHaveText('executed');

    // Site B connects to the same store: signed in already, so it only picks the store.
    adminB = await context.newPage();
    await login(adminB, 'b');
    await installZip(adminB, 'b');
    await adminB.goto(settingsUrl('b'));
    const b = await openConnect(adminB, 'Connect to tendr', passkeys);
    await expect(b.popup.getByRole('heading', { name: 'Choose a store' })).toBeVisible();
    await b.popup.getByRole('button', { name: 'Continue' }).click();
    await approve(b.popup, adminB, 'b');
    expect(testKey('b')).toMatch(/^tdr_test_/);
    expect(testKey('b')).not.toBe(keyA);
  });

  test('2. an admin purchase in the Blocks checkout: simulate exact → Processing, and "You got paid"', async () => {
    const since = Date.now() - 1000;
    paid = await buyInBlocksCheckout(admin, 'a', productId('a', PRODUCT_USD.name));
    await expect.poll(() => orderStatus('a', paid.key), { timeout: 60_000 }).toBe('processing');
    // The thank-you page stops waiting by itself.
    await expect(admin.getByText('Waiting for payment confirmation…')).toHaveCount(0, {
      timeout: 30_000,
    });
    const notes = orderNotes('a', paid.id);
    expect(notes).toContain('[Test] Crypto payment received.');
    expect(notes).toContain('$10.00');

    const got = await mail(OWNER, 'payment_received', since);
    expect(got.subject ?? '').toContain('[Test]');

    // The order screen shows it, still with no secret anywhere.
    await admin.goto(`${SITES.a.url}/wp-admin/admin.php?page=wc-orders&action=edit&id=${paid.id}`);
    await expect(admin.locator('#order_status')).toHaveValue('wc-processing');
    await expect(admin.getByText('Paid with a tendr TEST payment')).toBeVisible();
  });

  test('3. an NGN store converts at checkout, and the note has the rate', async () => {
    wpPhp('a', "update_option('woocommerce_currency', 'NGN');");
    try {
      const order = await buyInBlocksCheckout(admin, 'a', productId('a', PRODUCT_NGN.name));
      await expect.poll(() => orderStatus('a', order.key), { timeout: 60_000 }).toBe('processing');
      const notes = orderNotes('a', order.id);
      expect(notes).toMatch(/Converted ₦16,000(\.00)? → \$10\.00 at 1 USD = 1,600(\.00)? NGN/);
    } finally {
      wpPhp('a', "update_option('woocommerce_currency', 'USD');");
    }
  });

  test('4. refund 0.50: not refunded until the signers approve, then refund.sent → partially refunded', async () => {
    await admin.goto(`${SITES.a.url}/wp-admin/admin.php?page=wc-orders&action=edit&id=${paid.id}`);
    const dialogs: string[] = [];
    const onDialog = (d: Dialog) => {
      dialogs.push(d.message());
      void d.accept();
    };
    admin.on('dialog', onDialog);
    await admin.locator('button.refund-items').click();
    await admin.locator('#refund_amount').fill('0.50');
    await admin.locator('#refund_reason').fill('E2E partial refund');
    await admin.locator('button.do-api-refund').click();
    // WooCommerce's own confirm, then the plugin's message (shown as WooCommerce's error alert).
    await expect.poll(() => dialogs.at(-1), { timeout: 60_000 }).toBe(REFUND_ALERT);
    admin.off('dialog', onDialog);

    await admin.reload();
    expect(wpPhp('a', `echo wc_get_order(${paid.id})->get_total_refunded();`)).toBe('0');
    await expect(admin.locator('#order_status')).toHaveValue('wc-processing');
    await expect(admin.getByText('Refunds not yet sent')).toBeVisible();
    expect(orderNotes('a', paid.id)).toContain('awaiting approval in tendr');

    // The signers approve the refund proposal on the dashboard.
    let proposalId = '';
    await expect
      .poll(
        async () => {
          const list = await dashboardApi<{
            proposals: { id: string; kind: string; status: string }[];
          }>(dash, '/v1/account/proposals');
          proposalId =
            list.body.proposals.find((p) => p.kind === 'refund' && p.status !== 'executed')?.id ??
            '';
          return proposalId;
        },
        { message: 'refund proposal', timeout: 60_000 },
      )
      .not.toBe('');
    await dash.goto(`${WEB_URL}/dashboard/approvals/${proposalId}`);
    await dash.getByRole('button', { name: 'Approve with passkey' }).click();
    // Above the refund cap a refund is timelocked (5 s in this run, 24 h on chain); the worker
    // then executes it.
    await expect(dash.locator('.card-head .status')).toHaveText(/timelocked|executed/);
    expect(wpPhp('a', `echo wc_get_order(${paid.id})->get_total_refunded();`)).toBe('0');

    // refund.sent reaches WordPress, which records the refund now.
    await expect
      .poll(() => wpPhp('a', `echo wc_get_order(${paid.id})->get_total_refunded();`), {
        timeout: 150_000,
        intervals: [5_000],
      })
      .toBe('0.5');
    expect(await orderStatus('a', paid.key)).toBe('processing');
    expect(orderNotes('a', paid.id)).toContain('Refund of $0.50 sent by tendr');
  });

  test('5. site B receives none of site A’s events', async () => {
    // B takes a payment of its own (the test purchase), so its webhook does work.
    await adminB.goto(settingsUrl('b'));
    await adminB.getByRole('button', { name: 'Make a test purchase' }).click();
    await adminB.waitForURL(/order-pay\/\d+/);
    const keyB = new URL(adminB.url()).searchParams.get('key')!;
    // WooCommerce's pay page preselects its first gateway (Cash on delivery here).
    await adminB.getByRole('radio', { name: 'Pay with crypto' }).check();
    // The button takes the method's label ("Pay with crypto").
    await adminB.locator('#place_order').click();
    await payInModal(adminB);
    await expect
      .poll(() => orderStatus('b', keyB), { timeout: 60_000 })
      .toMatch(/^(processing|completed)$/);

    const idsA = wpSql('a', 'SELECT event_id FROM wp_tendr_events').map((r) => r[0]);
    const idsB = wpSql('b', 'SELECT event_id FROM wp_tendr_events').map((r) => r[0]);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    expect(idsB.filter((id) => idsA.includes(id))).toEqual([]);
  });

  test('6. re-connect revokes the old key; a guest never sees the method; disconnect revokes', async ({
    browser,
  }) => {
    // The stored keys become unreadable (as after a salts change): the page asks to reconnect.
    wp('a', ['option', 'update', 'tendr_credentials', 'v1:not-a-valid-secretbox']);
    await admin.goto(settingsUrl('a'));
    const re = await openConnect(admin, 'Reconnect to tendr', passkeys);
    await expect(re.popup.getByRole('heading', { name: 'Choose a store' })).toBeVisible();
    await re.popup.getByRole('button', { name: 'Continue' }).click();
    await approve(re.popup, admin, 'a');
    const keyA2 = testKey('a');
    expect(keyA2).toMatch(/^tdr_test_/);
    expect(keyA2).not.toBe(keyA);
    expect(await apiStatus('/v1/connect/status', keyA)).toBe(401);
    expect(await apiStatus('/v1/connect/status', keyA2)).toBe(200);

    // Test mode: a logged-out guest's Blocks checkout offers Cash on delivery, never tendr.
    const guestContext = await browser.newContext();
    await blockExternal(guestContext);
    const guest = await guestContext.newPage();
    await guest.goto(`${SITES.a.url}/?add-to-cart=${productId('a', PRODUCT_USD.name)}`);
    await guest.goto(`${SITES.a.url}/checkout/`);
    await expect(guest.locator('.wp-block-woocommerce-checkout')).toBeVisible();
    await expect(guest.getByText('Cash on delivery').first()).toBeVisible({ timeout: 30_000 });
    await expect(guest.getByText('Pay with crypto')).toHaveCount(0);
    await guestContext.close();

    // Disconnect: the key it held is revoked at once.
    // The link asks to confirm first.
    admin.once('dialog', (d) => void d.accept());
    await admin.goto(settingsUrl('a'));
    await admin.getByRole('link', { name: 'Disconnect' }).click();
    await expect(
      admin.getByText("Disconnected from tendr. This site's keys are revoked."),
    ).toBeVisible();
    expect(await apiStatus('/v1/connect/status', keyA2)).toBe(401);
    expect(testKey('a')).toBe('');

    // Every WP admin page this run loaded was free of secret-shaped strings.
    expect(html.seen.length).toBeGreaterThan(10);
    expect(html.leaks).toEqual([]);
  });
});
