import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

function sha256(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

async function main() {
  const existing = await prisma.merchant.findUnique({ where: { slug: 'demo-merchant' } });
  if (existing) {
    console.log('Demo merchant already seeded:', existing.id);
    console.log('Set DEMO_MERCHANT_API_KEY from a previously printed key, or revoke and re-seed.');
    return;
  }

  const merchant = await prisma.merchant.create({
    data: {
      name: 'Tendr Demo Merchant',
      slug: 'demo-merchant',
    },
  });

  const rawKey = `tdr_test_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: {
      merchantId: merchant.id,
      name: 'Demo key',
      keyPrefix: rawKey.slice(0, 12),
      keyHash: sha256(rawKey),
    },
  });

  console.log('Seeded demo merchant:', merchant.id);
  console.log('DEMO_MERCHANT_API_KEY=' + rawKey);
  console.log('Add this to Tendr/.env (server-side only).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
