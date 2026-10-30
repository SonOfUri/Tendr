// The gasless migration's policy backfill (spec §8.4): merchants whose default gas payer is the
// merchant get an ENABLED policy with the default limits, in both modes; the others get none.
// The test re-runs the migration's backfill statement (between its BEGIN/END markers) on rows
// created after the migration was applied.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GAS_POLICY } from '@tendr/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';

const MIGRATION = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../prisma/migrations/20261027100000_gasless/migration.sql',
);

function backfillSql(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const m = /-- BEGIN gas policy backfill\n([\s\S]*?)-- END gas policy backfill/.exec(sql);
  if (!m) throw new Error('backfill markers not found in the gasless migration');
  return m[1]!;
}

describe('gasless migration: gas policy backfill', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates enabled default policies (both modes) only for merchant-pays-gas stores', async () => {
    const sponsor = await createMerchant({ defaultGasPayer: 'merchant' });
    const shopper = await createMerchant({ defaultGasPayer: 'buyer' });
    await prisma.$executeRawUnsafe(backfillSql());

    const rows = await prisma.gasPolicy.findMany({ orderBy: { livemode: 'asc' } });
    expect(rows.map((r) => [r.merchantId, r.livemode])).toEqual([
      [sponsor.id, false],
      [sponsor.id, true],
    ]);
    for (const r of rows) {
      expect(r.id).toMatch(/^gpol_[0-9A-Z]{26}$/);
      expect(r.enabled).toBe(true);
      expect(r.perPaymentCapUsd.toFixed()).toBe(DEFAULT_GAS_POLICY.per_payment_cap_usd);
      expect(r.monthlyBudgetUsd.toFixed()).toBe(DEFAULT_GAS_POLICY.monthly_budget_usd);
      expect(r.minOrderUsd.toFixed()).toBe(DEFAULT_GAS_POLICY.min_order_usd);
      expect(r.chains).toEqual([...DEFAULT_GAS_POLICY.chains]);
      expect(r.tokens).toEqual([]);
      expect(r.firstTimeOnly).toBe(false);
    }
    expect(await prisma.gasPolicy.count({ where: { merchantId: shopper.id } })).toBe(0);
  });

  it('keeps an existing policy and fills only the missing mode', async () => {
    const m = await createMerchant({ defaultGasPayer: 'merchant' });
    const own = await createRow('GasPolicy', m.id, true, { enabled: false });
    await prisma.$executeRawUnsafe(backfillSql());
    const rows = await prisma.gasPolicy.findMany({ where: { merchantId: m.id } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.livemode)).toMatchObject({ id: own.id, enabled: false });
    expect(rows.find((r) => !r.livemode)).toMatchObject({ enabled: true });
  });
});
