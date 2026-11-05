// End to end: signup with a passkey (CDP virtual authenticator), store and recovery kit, a saved
// address that waits 24 h, a finance invitee whose withdrawal is refused until then, and an owner
// approving the invitee's AddSavedAddress draft. The API runs against the test database with the
// in-memory NEAR client simulating the merchant-account contract (playwright.config.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { blockExternal } from './support/network';

const MAIL_DIR = resolve(__dirname, '../../api/.mail');
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const OWNER = `owner-${run}@example.com`;
const FINANCE = `finance-${run}@example.com`;

/** A platform authenticator with user verification, as Face ID / Touch ID would be. */
async function withAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
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
}

/** The link in the newest mail of `template` to `to`, written by the API's log mailer. */
async function mailLink(to: string, template: string, after: number): Promise<string> {
  let found: string | null = null;
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
                data: { url?: string };
              },
          )
          .filter((m) => m.to === to && m.template === template && m.data.url);
        found = matches.at(-1)?.data.url ?? null;
        return found;
      },
      { message: `${template} mail to ${to}`, timeout: 30_000 },
    )
    .not.toBeNull();
  return found!;
}

/** Signup by email link, then the first passkey. Ends wherever the app sends a new person. */
async function signUp(page: Page, email: string): Promise<void> {
  const since = Date.now() - 1000;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send me a link' }).click();
  await page.goto(await mailLink(email, 'verify_email', since));
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await page.getByRole('button', { name: 'Create my passkey' }).click();
}

test.describe.serial('merchant accounts', () => {
  let owner: Page;
  let ownerContext: BrowserContext;
  const savedAddress = `payout${run}.near`;

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext();
    await blockExternal(ownerContext);
    owner = await ownerContext.newPage();
    await withAuthenticator(owner);
  });
  test.afterAll(async () => {
    await ownerContext.close();
  });

  test('signup, passkey, store, recovery kit → account home with go-live ok', async () => {
    await signUp(owner, OWNER);
    await expect(owner.getByRole('heading', { name: 'Name your store' })).toBeVisible();
    await owner.getByLabel('Store name').fill(`E2E ${run}`);
    await owner.getByRole('button', { name: 'Create store' }).click();
    await expect(owner.getByRole('heading', { name: /is set up/ })).toBeVisible();
    await owner.getByRole('button', { name: 'Add a second key' }).click();

    await owner.getByRole('button', { name: 'Create recovery kit' }).click();
    const groups = await owner.locator('.kit-code .kit-group').allTextContents();
    expect(groups).toHaveLength(14);
    await owner.getByRole('button', { name: 'I’ve saved it' }).click();
    await owner.getByLabel(/second group of your kit/).fill(groups[1]!);
    await owner.getByRole('button', { name: 'Confirm and turn on' }).click();
    await expect(owner.getByText('Your recovery kit is on.')).toBeVisible();

    await owner.goto('/dashboard');
    // The test account is provisioned by the worker (in-memory NEAR), then shows as ready.
    const testCard = owner.locator('section.card', {
      has: owner.getByRole('heading', { name: 'Test account' }),
    });
    await expect(testCard.getByText('Ready')).toBeVisible({ timeout: 60_000 });
    await expect(owner.locator('.checklist li.todo')).toHaveCount(0);
    await expect(owner.getByRole('button', { name: 'Go live' })).toBeEnabled();
  });

  test('the payout page sets where test payments settle (USDC by default), with the passkey', async () => {
    await owner.goto('/dashboard/settings/payout');
    await expect(owner.getByRole('radio', { name: /USDC/ })).toBeChecked();
    await owner.getByRole('button', { name: 'Approve payout' }).click();
    await expect(owner.getByText(/Payout set: .* test payments settle in USDC/)).toBeVisible();
    // Once mirrored from the account, the page shows it as set.
    await expect(async () => {
      await owner.reload();
      await expect(
        owner.locator('p', { hasText: /test payments settle in USDC into its tendr account/ }),
      ).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
  });

  test('a saved address is approved and shows usable in 24h', async () => {
    await owner.goto('/dashboard/addresses');
    await owner.getByLabel('Network').selectOption('near');
    await owner.getByLabel('Address', { exact: true }).fill(savedAddress);
    await owner.getByRole('button', { name: 'Ask to add this address' }).click();
    await owner.waitForURL(/\/dashboard\/approvals\/prop_/);
    // The summary shows the full address and its chain.
    await expect(owner.getByTestId('destination')).toContainText(savedAddress);
    await expect(owner.getByTestId('destination')).toContainText('NEAR');
    await owner.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(owner.locator('.card-head .status')).toHaveText('executed');

    await owner.goto('/dashboard/addresses');
    const row = owner.getByTestId(`saved-${savedAddress}`);
    await expect(row).toContainText('usable in 24h');
    await expect(row.locator('.status')).toHaveText('pending');
  });

  test('the security page says which changes wait 24 h and that sweeps bypass limits', async () => {
    await owner.goto('/dashboard/security');
    await expect(owner.getByText(/adding a signer or a passkey/)).toContainText(
      'take effect 24 hours after approval',
    );
    await expect(owner.getByTestId('sweep-limits-note')).toContainText(
      'not counted against the per-withdrawal or per-day limits',
    );
  });

  test('a finance invitee cannot withdraw to it yet; their saved-address draft is approved by the owner', async ({
    browser,
  }) => {
    // The owner invites a finance person.
    const since = Date.now() - 1000;
    await owner.goto('/dashboard/team');
    await owner.getByLabel('Email', { exact: true }).fill(FINANCE);
    await owner.getByRole('button', { name: 'Role', exact: true }).click();
    await owner.getByRole('option', { name: /^Finance/ }).click();
    await owner.getByRole('button', { name: 'Send invite' }).click();
    await expect(owner.getByText(`Invite sent to ${FINANCE}`)).toBeVisible();
    const inviteUrl = await mailLink(FINANCE, 'invite', since);

    // They accept it in their own browser.
    const financeContext = await browser.newContext();
    await blockExternal(financeContext);
    const finance = await financeContext.newPage();
    await withAuthenticator(finance);
    await finance.goto(inviteUrl);
    await finance.getByRole('button', { name: 'Sign up' }).click();
    await signUp(finance, FINANCE);
    await finance.getByRole('button', { name: 'Accept invite' }).click();
    await finance.waitForURL(/\/dashboard$/);

    // A withdrawal to the saved address is refused: it is not usable for 24 hours. (The fake
    // NEAR client cannot move time forward, so this asserts the API's documented 400.)
    await finance.goto('/dashboard/withdraw');
    const option = finance.locator('select[name="saved-address"] option', {
      hasText: savedAddress,
    });
    await finance
      .locator('select[name="saved-address"]')
      .selectOption((await option.getAttribute('value'))!);
    await finance.locator('input[name="asset"]').fill('nep141:usdc.fakes.testnet');
    await finance.locator('input[name="amount"]').fill('1');
    await finance.getByRole('button', { name: 'Ask to withdraw' }).click();
    await expect(finance.getByText(/saved address is unknown or not yet active/)).toBeVisible();

    // A finance member holding the kit is told who can start a recovery.
    await finance.goto('/dashboard/recovery');
    await expect(finance.getByTestId('recovery-start-restricted')).toContainText(
      'owner or an admin',
    );

    // They ask for another saved address: a draft only a signer can approve.
    const second = `second${run}.near`;
    await finance.goto('/dashboard/addresses');
    await finance.getByLabel('Address', { exact: true }).fill(second);
    await finance.getByRole('button', { name: 'Ask to add this address' }).click();
    await finance.waitForURL(/\/dashboard\/approvals\/prop_/);
    const detailPath = new URL(finance.url()).pathname;
    await expect(finance.locator('.card-head .status')).toHaveText('draft');
    await expect(finance.getByRole('button', { name: 'Approve with passkey' })).toHaveCount(0);

    // The owner sees it waiting, approves it, and it executes (threshold 1).
    await owner.goto('/dashboard/approvals');
    await expect(
      owner.locator(`[data-testid="proposal-${detailPath.split('/').pop()}"] .status`),
    ).toHaveText('draft');
    await owner.goto(detailPath);
    await expect(owner.getByTestId('destination')).toContainText(second);
    await owner.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(owner.locator('.card-head .status')).toHaveText('executed');

    // The requester sees the result too.
    await finance.reload();
    await expect(finance.locator('.card-head .status')).toHaveText('executed');
    await financeContext.close();
  });
});
