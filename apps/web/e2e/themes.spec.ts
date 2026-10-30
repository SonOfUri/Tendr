// End to end: checkout themes on a phone (375 × 812). Themes are made through the API with the
// store's test secret key, and a test-mode session (or link) names the theme's DRAFT, which is
// what test mode renders. Everything else is simulated, as in checkout.spec.ts (whose seed script
// this reuses); the API keeps theme uploads in memory (no object store), so these themes use none.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { HOSTILE_CSS, HOSTILE_HTML_ABOVE, HOSTILE_HTML_BELOW } from './fixtures/hostile-theme';
import { blockExternal } from './support/network';
import { API_URL, E2E_CODE_HASH, STORE_URL, WEB_URL } from './support/urls';

const API_DIR = resolve(__dirname, '../../api');
const PHONE = { width: 375, height: 812 };

interface Store {
  merchantId: string;
  secretKey: string;
  dashboardHeaders: Record<string, string>;
}
interface Session {
  id: string;
  client_secret: string;
  url: string;
}
type Doc = {
  settings: Record<string, unknown>;
  blocks: Record<string, unknown>[];
  success_blocks: Record<string, unknown>[];
  custom_css?: string;
} & Record<string, unknown>;
interface Theme {
  id: string;
  draft: Doc;
}

/** A tsx script in apps/api against the test database; returns its last stdout line as JSON. */
function apiScript<T>(script: string, input: unknown): T {
  const out = execFileSync('npx', ['tsx', script, JSON.stringify(input)], {
    cwd: API_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, MERCHANT_ACCOUNT_CODE_HASH_TEST: E2E_CODE_HASH },
  });
  return JSON.parse(out.trim().split('\n').at(-1)!) as T;
}

/** A new checkout-ready test-mode store (apps/api/scripts/e2e-checkout-seed.ts). */
const seedStore = () =>
  apiScript<Store>('scripts/e2e-checkout-seed.ts', { checkoutDomains: [STORE_URL] });

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

const key = (store: Store) => ({ authorization: `Bearer ${store.secretKey}` });

/** A theme from a preset, its draft then changed by `edit` (saved through the validator). */
async function createTheme(
  store: Store,
  preset: string,
  edit: (doc: Doc) => Doc = (d) => d,
): Promise<Theme> {
  const created = await api<Theme>('/v1/themes', {
    method: 'POST',
    headers: key(store),
    body: { name: `${preset} ${Date.now().toString(36)}`, from: { preset } },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const draft = edit(structuredClone(created.body.draft));
  const saved = await api<Theme>(`/v1/themes/${created.body.id}`, {
    method: 'PATCH',
    headers: key(store),
    body: { draft },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return saved.body;
}

async function createSession(
  store: Store,
  extra: Record<string, unknown> = {},
  amount = '25.00',
): Promise<Session> {
  const res = await api<Session>('/v1/checkout/sessions', {
    method: 'POST',
    headers: key(store),
    body: {
      amount,
      amount_currency: 'USD',
      external_ref: `order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      success_url: `${STORE_URL}/thanks`,
      cancel_url: `${STORE_URL}/cancel`,
      ...extra,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** The test-mode panel stands in for the shopper's deposit (as in checkout.spec.ts). */
async function payExactly(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'ETH Base', exact: true }).click();
  await expect(page.getByText('You send')).toBeVisible();
  await page.getByRole('button', { name: 'Pay the exact amount' }).click();
  await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
    timeout: 60_000,
  });
}

const sealed = (page: Page) => page.locator('section.tdr-payment[data-sealed]');

test.describe('checkout themes', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ context }) => {
    await blockExternal(context);
  });

  test('themed checkout renders preset and pays in test mode', async ({ page }) => {
    const store = seedStore();
    const theme = await createTheme(store, 'gaming', (d) => ({
      ...d,
      settings: {
        ...d.settings,
        display_name: 'Kola Kicks',
        success_message: 'GG, order locked in.',
      },
    }));
    const session = await createSession(store, {
      theme_id: theme.id,
      line_items: [
        { name: 'Pixel hoodie', quantity: 1, unit_amount: '20.00' },
        { name: 'Sticker pack', quantity: 2, unit_amount: '2.00' },
      ],
    });
    await page.goto(session.url);

    const root = page.locator('.tdr-theme.tdr-page');
    await expect(root).toHaveAttribute('data-scheme', 'dark');
    // The gaming preset's accent, from the theme variables.
    expect(
      await root.evaluate((el) => getComputedStyle(el).getPropertyValue('--theme-accent').trim()),
    ).toBe('#9b5cff');
    // Brand in the header block; the payee (the account) in the sealed block.
    await expect(page.locator('.tdr-header-name')).toHaveText('Kola Kicks');
    await expect(sealed(page).locator('.pay-payee')).toContainText(
      /You're paying E2E Shop \S+ · trading as Kola Kicks/,
    );
    // The cart in the order summary block, with the difference line (24.00 of 25.00).
    await expect(page.getByText('Pixel hoodie')).toBeVisible();
    await expect(page.getByText('Shipping, tax or discounts')).toBeVisible();
    await expect(page.locator('.tdr-line-adjust .tdr-line-amount')).toHaveText('$1.00');
    await expect(sealed(page).locator('.pay-total')).toHaveText('$25.00');

    await sealed(page).scrollIntoViewIfNeeded();
    await payExactly(page);
    await expect(page.getByText('GG, order locked in.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to store' })).toHaveAttribute(
      'href',
      `${STORE_URL}/thanks`,
    );
    await expect(page.locator('[data-pay-bar]')).toHaveCount(0);
  });

  test('hostile theme cannot cover or move the payment block', async ({ page }) => {
    const store = seedStore();
    const theme = await createTheme(store, 'blank', (d) => ({
      ...d,
      custom_css: HOSTILE_CSS,
      blocks: [
        { id: 'header', type: 'header', show_logo: true, show_name: true },
        { id: 'evil-above', type: 'custom_html', html: HOSTILE_HTML_ABOVE },
        { id: 'payment', type: 'payment' },
        { id: 'evil-below', type: 'custom_html', html: HOSTILE_HTML_BELOW },
      ],
    }));
    const session = await createSession(store, { theme_id: theme.id }, '37.50');
    await page.goto(session.url);
    await expect(page.getByRole('heading', { name: 'Pay with' })).toBeVisible();
    // The validator kept the aggressive rules (scoped), so they really are on the page.
    expect(await page.locator('style[data-tendr-theme-css]').textContent()).toContain(
      'translateY(-500px)',
    );

    const box = await sealed(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const canvas = el.closest('.tdr-canvas')!.getBoundingClientRect();
      return {
        top: r.top + scrollY,
        bottom: r.bottom + scrollY,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        canvasLeft: canvas.left,
        canvasWidth: canvas.width,
      };
    });
    // Not squeezed or shifted: the payment block keeps the card's full width and a real height.
    expect(Math.abs(box.width - box.canvasWidth)).toBeLessThan(1);
    expect(Math.abs(box.left - box.canvasLeft)).toBeLessThan(1);
    expect(box.width).toBeGreaterThan(280);
    expect(box.height).toBeGreaterThan(200);
    const wraps = await page.locator('.tdr-wrap').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right };
      }),
    );
    expect(wraps.length).toBeGreaterThanOrEqual(3);
    for (const w of wraps) {
      const overlaps =
        w.left < box.right && w.right > box.left && w.top < box.bottom && w.bottom > box.top;
      expect(overlaps, `a merchant block overlaps the payment block: ${JSON.stringify(w)}`).toBe(
        false,
      );
    }

    const amount = sealed(page).locator('.pay-total');
    await amount.scrollIntoViewIfNeeded();
    await expect(amount).toHaveText('$37.50');
    const hit = await amount.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inside: !!at?.closest('.tdr-payment[data-sealed]'), html: at?.outerHTML ?? null };
    });
    expect(hit.inside, `elementFromPoint hit ${hit.html}`).toBe(true);
    // The token buttons can still be pressed: nothing a block draws sits on them.
    await page.getByRole('button', { name: 'ETH Base', exact: true }).click();
    await expect(page.getByText('You send')).toBeVisible();
  });

  test('pay bar appears when payment block is off screen', async ({ page }) => {
    const store = seedStore();
    const theme = await createTheme(store, 'blank', (d) => ({
      ...d,
      custom_css: '.tall { height: 3000px; background: #1b2140; }',
      blocks: [
        { id: 'header', type: 'header', show_logo: true, show_name: true },
        { id: 'banner', type: 'custom_html', html: '<div class="tall"></div>' },
        {
          id: 'faq',
          type: 'faq',
          items: [
            { q: 'When does it ship?', a: 'Within two days.' },
            { q: 'Can I return it?', a: 'Yes, within 30 days.' },
          ],
        },
        { id: 'payment', type: 'payment' },
      ],
    }));
    const session = await createSession(store, { theme_id: theme.id }, '19.99');
    await page.goto(session.url);
    await expect(sealed(page).getByRole('heading', { name: 'Pay with' })).toBeAttached();

    const bar = page.locator('[data-pay-bar]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('$19.99');
    await expect(bar).toContainText(/You're paying E2E Shop/);
    const barBox = (await bar.boundingBox())!;
    expect(barBox.y + barBox.height).toBeCloseTo(PHONE.height, 0);

    await bar.getByRole('button').click();
    await expect(bar).toHaveCount(0);
    await expect(sealed(page).locator('.pay-total')).toBeInViewport();
    // Focus moved into the payment block (its first control).
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('.tdr-payment[data-sealed]')),
    ).toBe(true);

    // Scrolling back up to the banner brings the bar back.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).toBeVisible();
  });

  test('invalid stored theme falls back to default and checkout works', async ({ page }) => {
    const store = seedStore();
    const theme = await createTheme(store, 'gaming', (d) => ({
      ...d,
      settings: { ...d.settings, display_name: 'Broken Look' },
    }));
    apiScript('scripts/e2e-theme-corrupt.ts', { themeId: theme.id });
    const session = await createSession(store, { theme_id: theme.id });
    await page.goto(session.url);

    await expect(page.getByRole('heading', { name: 'Pay with' })).toBeVisible();
    // The Tendr default look: dark, Tendr's accent, the account's own name in the header.
    const root = page.locator('.tdr-theme.tdr-page');
    await expect(root).toHaveAttribute('data-scheme', 'dark');
    expect(
      await root.evaluate((el) => getComputedStyle(el).getPropertyValue('--theme-accent').trim()),
    ).toBe('#7a72ff');
    await expect(page.locator('.tdr-header-name')).toHaveText(/^E2E Shop /);
    await expect(page.getByText('Broken Look')).toHaveCount(0);
    await payExactly(page);
  });

  test('preview page renders draft and cannot pay', async ({ page }) => {
    const store = seedStore();
    const theme = await createTheme(store, 'fashion', (d) => ({
      ...d,
      settings: { ...d.settings, display_name: 'Draft Atelier' },
    }));
    const minted = await api<{ url: string }>(`/v1/themes/${theme.id}/preview`, {
      method: 'POST',
      headers: key(store),
      body: { sample: 'checkout', scheme: 'light', viewport: 'phone' },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    expect(minted.body.url).toMatch(new RegExp(`^${WEB_URL}/preview/theme/[A-Za-z0-9_-]+$`));

    const apiCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(API_URL)) apiCalls.push(`${r.method()} ${r.url()}`);
    });
    const res = await page.goto(minted.body.url);
    expect(res!.headers()['content-security-policy']).toMatch(/img-src [^;]*localhost:9100/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.getByText('Preview — payments are off').first()).toBeVisible();
    await expect(page.locator('.tdr-header-name')).toHaveText('Draft Atelier');
    await expect(page.locator('.tdr-theme.tdr-page')).toHaveAttribute('data-scheme', 'light');
    await expect(page.getByText('Linen shirt')).toBeVisible();
    // The fashion preset's button words ("Complete purchase") label the inert Pay button (R22).
    const pay = sealed(page).getByRole('button', { name: 'Complete purchase' });
    await expect(pay).toBeDisabled();
    await pay.click({ force: true });
    // Nothing on the page can pay: no token list, and the browser only ever read the preview
    // (from the shopper's own address, so the read limit counts the viewer).
    await expect(page.getByRole('button', { name: 'ETH Base', exact: true })).toHaveCount(0);
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const call of apiCalls) expect(call).toMatch(/^GET .*\/v1\/themes\/preview\/[\w-]+$/);
  });

  test('link page uses link theme_id', async ({ page }) => {
    const store = seedStore();
    const theme = await createTheme(store, 'fashion', (d) => ({
      ...d,
      settings: { ...d.settings, display_name: 'Link Look', button_label: 'Buy it for {amount}' },
      custom_css: '.tall { height: 2500px; background: #e8dfd4; }',
      blocks: [
        { id: 'header', type: 'header', show_logo: true, show_name: true },
        { id: 'banner', type: 'custom_html', html: '<div class="tall"></div>' },
        { id: 'summary', type: 'order_summary' },
        { id: 'payment', type: 'payment' },
      ],
    }));
    const title = `Gift card ${Date.now().toString(36)}`;
    const created = await api<{ url: string }>('/v1/payment_links', {
      method: 'POST',
      headers: key(store),
      body: {
        title,
        description: 'For a friend.',
        amount_type: 'fixed',
        amount: '15.00',
        currency: 'USD',
        theme_id: theme.id,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    await page.goto(created.body.url);
    await expect(page.locator('.tdr-header-name')).toHaveText('Link Look');
    await expect(page.locator('.tdr-theme.tdr-page')).toHaveAttribute('data-scheme', 'light');
    // Title in the order summary block; amount, payee and Pay in the sealed block.
    await expect(
      page.locator('.tdr-wrap[data-type="order_summary"]').getByRole('heading', { name: title }),
    ).toBeVisible();
    await expect(sealed(page).locator('.pay-payee')).toContainText(
      /You're paying E2E Shop \S+ · trading as Link Look/,
    );
    // The theme's button words, with Tendr's formatted amount (R22).
    const pay = sealed(page).getByRole('button', { name: 'Buy it for $15' });
    await expect(pay).toBeAttached();
    await expect(page.getByText('Buy it for')).toHaveCount(1);

    // The tall banner pushes the payment block off a phone screen: the pay bar stands in for it.
    const bar = page.locator('[data-pay-bar]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('$15');
    await expect(bar).toContainText(/You're paying E2E Shop/);
    await bar.getByRole('button').click();
    await expect(bar).toHaveCount(0);
    await expect(pay).toBeInViewport();
    await expect(sealed(page).locator('.pay-total')).toHaveText('$15');
    // It stays hidden while the block is on screen (no flash after the smooth scroll ends).
    await page.waitForTimeout(1800);
    await expect(bar).toHaveCount(0);
  });
});
