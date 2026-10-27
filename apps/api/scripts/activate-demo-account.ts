/**
 * Local-dev helper: mark Demo Merchant's test-mode account as active so checkout sessions work
 * with NEAR_CLIENT_DRIVER=fake. Not for production.
 */
import { resolve } from 'node:path';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';

loadDotenvFile(resolve(process.cwd(), '../../.env'));

import { loadEnv } from '../src/env.js';
loadEnv(process.env);

import { newId } from '../src/lib/ids.js';
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const merchant = await prisma.merchant.findFirst({ where: { slug: 'demo-merchant' } });
  if (!merchant) throw new Error('Demo Merchant missing — run npm run db:seed');

  const existing = await prisma.merchantAccount.findFirst({
    where: { merchantId: merchant.id, livemode: false },
  });

  const webOrigins = [
    'http://localhost:3000',
    'https://demo.usetendr.tech',
    'https://usetendr.tech',
  ];
  const domains = Array.from(new Set([...(merchant.checkoutDomains ?? []), ...webOrigins]));
  if (domains.length !== (merchant.checkoutDomains?.length ?? 0)) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { checkoutDomains: domains },
    });
    console.log('checkout_domains', domains.join(', '));
  }

  if (existing) {
    const updated = await prisma.merchantAccount.update({
      where: { id: existing.id },
      data: { status: 'active' },
    });
    console.log('updated', updated.id, updated.nearAccountId, updated.status);
    return;
  }

  const created = await prisma.merchantAccount.create({
    data: {
      id: newId('macc'),
      merchantId: merchant.id,
      livemode: false,
      nearAccountId: 'demo-merchant.tendr.testnet',
      threshold: 1,
      status: 'active',
    },
  });
  console.log('created', created.id, created.nearAccountId, created.status);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
