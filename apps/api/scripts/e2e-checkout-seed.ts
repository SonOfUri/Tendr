// Seeds one checkout-ready test-mode store for the web end-to-end tests (apps/web/e2e/
// checkout.spec.ts), each test its own: a merchant whose owner (a signer with a passkey) has a
// fresh dashboard session (passkey step-up done), an intents settlement config (USDC), the given
// checkout domains, a test secret key, and a test merchant account. The account is provisioned
// the way a new store's is: the row and its provisioning request are written here, and the
// running e2e server's worker provisions it on its in-memory NEAR; this waits until it is active.
// Prints one JSON line on stdout.
//
//   tsx scripts/e2e-checkout-seed.ts '{"checkoutDomains":["http://localhost:3200"]}'
//
// TEST DATABASE ONLY: DATABASE_URL is replaced by TEST_DATABASE_URL (environment, then the root
// .env), and it refuses to run without one, or in production. Needs the e2e server running.
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';

/** The settlement asset (simulated 1Click fixture token: USDC on NEAR, 6 decimals, $1). */
export const E2E_SETTLEMENT_ASSET = 'nep141:usdc.test';
const PROVISION_TIMEOUT_MS = 60_000;

async function main() {
  loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));
  if (process.env.NODE_ENV === 'production') throw new Error('e2e seed refuses production');
  const testDb = process.env.TEST_DATABASE_URL;
  if (!testDb) throw new Error('TEST_DATABASE_URL is not set');
  process.env.DATABASE_URL = testDb;

  const input = JSON.parse(process.argv[2] ?? '{}') as { checkoutDomains?: string[] };
  const checkoutDomains = input.checkoutDomains ?? [];

  // Imported after DATABASE_URL points at the test database.
  const { prisma } = await import('../src/lib/prisma.js');
  const { createApiKey, createCredential, createMerchant, createRow, createUser } =
    await import('../src/test/helpers.js');
  const { dashHeaders, loginAs } = await import('../src/test/dashboard.js');
  const { tenantTransaction } = await import('../src/db/tenant-transaction.js');
  const { createTestAccount } = await import('../src/accounts/accounts.js');

  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const merchant = await createMerchant({ name: `E2E Shop ${tag}`, checkoutDomains });
  await createRow('SettlementConfig', merchant.id, false, {
    destAssetId: E2E_SETTLEMENT_ASSET,
    destChain: 'near',
    payoutMode: 'intents',
    payoutAddress: null,
    isDefault: true,
  });
  const secretKey = (await createApiKey(merchant.id, { livemode: false })).raw;
  const owner = await createUser({
    email: `owner-${tag}@example.com`,
    emailVerifiedAt: new Date(),
  });
  await createRow('MerchantUser', merchant.id, false, {
    userId: owner.id,
    role: 'owner',
    isSigner: true,
  });
  await createCredential(owner.id);
  const login = await loginAs(owner.id, { stepUp: true });

  const created = await tenantTransaction({ merchantId: merchant.id, livemode: false }, (tx, t) =>
    createTestAccount(tx, t, merchant.slug),
  );
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  for (;;) {
    const a = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: created.id } });
    if (a.status === 'active') break;
    if (Date.now() > deadline) {
      throw new Error(`test account ${a.nearAccountId} not provisioned (status ${a.status})`);
    }
    await sleep(200);
  }
  await prisma.$disconnect();

  process.stdout.write(
    `${JSON.stringify({
      merchantId: merchant.id,
      nearAccountId: created.nearAccountId,
      secretKey,
      dashboardHeaders: dashHeaders(login, { merchantId: merchant.id, livemode: false }),
    })}\n`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
