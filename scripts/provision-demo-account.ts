import { resolve } from 'node:path';
import { loadDotenvFile } from '../apps/api/src/lib/load-dotenv.js';

loadDotenvFile(resolve(process.cwd(), '.env'));

import { loadEnv } from '../apps/api/src/env.js';
loadEnv(process.env);

import { provisionMerchantAccount } from '../apps/api/src/accounts/accounts.js';
import { prisma } from '../apps/api/src/lib/prisma.js';

async function main() {
  const m = await prisma.merchant.findFirst({ where: { slug: 'demo-merchant' } });
  if (!m) throw new Error('Demo Merchant not found — run db:seed first');
  console.log('merchant', m.id);
  const existing = await prisma.merchantAccount.findFirst({
    where: { merchantId: m.id, livemode: false },
  });
  console.log('existing account', existing);
  if (existing?.status === 'active') {
    console.log('already active');
    return;
  }
  const acc = await provisionMerchantAccount(m.id, false);
  console.log('provisioned', acc);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
