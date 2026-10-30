import { DEFAULT_GAS_POLICY } from '@tendr/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { updateCheckoutSettings } from '../checkout/checkout-settings.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import { currentMonth, gasUsage, getGasPolicy, putGasPolicy } from './policy.js';

const actor = { by: 'api_key' as const, apiKeyId: 'key_x' };

describe('gas policy', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the defaults, disabled, when the merchant has no policy', async () => {
    const m = await createMerchant();
    expect(await getGasPolicy(m.id, false)).toEqual({
      livemode: false,
      ...DEFAULT_GAS_POLICY,
      enabled: false,
      updated_at: null,
    });
  });

  it('put creates the policy, merges partial updates and keeps modes apart', async () => {
    const m = await createMerchant();
    const ctx = { merchantId: m.id, livemode: false, actor };
    const created = await putGasPolicy(ctx, { enabled: true, chains: ['base', 'eth'] });
    expect(created).toMatchObject({
      livemode: false,
      enabled: true,
      per_payment_cap_usd: '1',
      monthly_budget_usd: '50',
      min_order_usd: '0',
      chains: ['base', 'eth'],
      tokens: [],
      first_time_only: false,
    });
    expect(created.updated_at).toEqual(expect.any(String));

    const updated = await putGasPolicy(ctx, { monthly_budget_usd: '75.5', first_time_only: true });
    expect(updated).toMatchObject({
      enabled: true,
      monthly_budget_usd: '75.5',
      chains: ['base', 'eth'],
      first_time_only: true,
    });
    expect(await getGasPolicy(m.id, false)).toEqual(updated);
    expect((await getGasPolicy(m.id, true)).enabled).toBe(false);
    expect(await prisma.gasPolicy.count({ where: { merchantId: m.id } })).toBe(1);
  });

  it('put validates the merged policy (cap above budget, unknown chain)', async () => {
    const m = await createMerchant();
    const ctx = { merchantId: m.id, livemode: false, actor };
    await expect(putGasPolicy(ctx, { per_payment_cap_usd: '60' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(putGasPolicy(ctx, { chains: ['doge'] })).rejects.toMatchObject({ status: 400 });
    expect(await prisma.gasPolicy.count()).toBe(0);
  });

  it('put records an internal audit event in the caller mode', async () => {
    const m = await createMerchant();
    await putGasPolicy({ merchantId: m.id, livemode: true, actor }, { enabled: true });
    const events = await prisma.event.findMany({ where: { merchantId: m.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ livemode: true, type: 'gas_policy.updated' });
    expect(events[0]!.payload).toMatchObject({
      actor,
      before: { enabled: false },
      after: { enabled: true },
    });
  });

  it('usage of an empty month is zero, with the whole budget remaining', async () => {
    const m = await createMerchant();
    expect(await gasUsage(m.id, false, '2026-10')).toEqual({
      month: '2026-10',
      reserved_usd: '0',
      spent_usd: '0',
      remaining_usd: '50',
      count: 0,
    });
  });

  it('usage reads the month row of its own mode; remaining never goes below zero', async () => {
    const m = await createMerchant();
    await putGasPolicy({ merchantId: m.id, livemode: false, actor }, { monthly_budget_usd: '10' });
    await prisma.gasBudgetMonth.create({
      data: {
        id: newId('gbm'),
        merchantId: m.id,
        livemode: false,
        month: '2026-10',
        reservedUsd: '1.25',
        spentUsd: '3.5',
        count: 4,
      },
    });
    await createRow('GasBudgetMonth', m.id, true, { month: '2026-10', spentUsd: '9' });
    expect(await gasUsage(m.id, false, '2026-10')).toEqual({
      month: '2026-10',
      reserved_usd: '1.25',
      spent_usd: '3.5',
      remaining_usd: '5.25',
      count: 4,
    });
    await prisma.gasBudgetMonth.updateMany({
      where: { merchantId: m.id, livemode: false },
      data: { spentUsd: '20' },
    });
    expect((await gasUsage(m.id, false, '2026-10')).remaining_usd).toBe('0');
  });

  it('a merchant has at most one policy per mode', async () => {
    const m = await createMerchant();
    await createRow('GasPolicy', m.id, false);
    await expect(createRow('GasPolicy', m.id, false)).rejects.toThrow();
    await createRow('GasPolicy', m.id, true);
  });

  it('currentMonth is the UTC calendar month', () => {
    expect(currentMonth(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(currentMonth(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
  });
});

describe('switching the default gas payer to the merchant (ruling R1-3)', () => {
  const settingsActor = { by: 'connection' as const, connectionId: 'con_x' };

  beforeEach(async () => {
    await resetDb();
  });

  it('creates the enabled default policy for the mode when it has none, and audits it', async () => {
    const m = await createMerchant({ defaultGasPayer: 'buyer' });
    await updateCheckoutSettings({ merchantId: m.id, livemode: true }, settingsActor, {
      default_gas_payer: 'merchant',
    });
    expect(await getGasPolicy(m.id, true)).toMatchObject({
      ...DEFAULT_GAS_POLICY,
      livemode: true,
      enabled: true,
    });
    expect(await prisma.gasPolicy.count({ where: { merchantId: m.id, livemode: false } })).toBe(0);
    const audit = await prisma.event.findMany({
      where: { merchantId: m.id, type: 'gas_policy.updated' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ livemode: true });
    expect(audit[0]!.payload).toMatchObject({
      actor: settingsActor,
      before: { enabled: false },
      after: { enabled: true },
    });
  });

  it('leaves an existing (disabled) policy untouched', async () => {
    const m = await createMerchant({ defaultGasPayer: 'buyer' });
    const own = await createRow('GasPolicy', m.id, false, { enabled: false });
    await updateCheckoutSettings(
      { merchantId: m.id, livemode: false },
      { by: 'user', userId: 'per_x' },
      { default_gas_payer: 'merchant' },
    );
    const rows = await prisma.gasPolicy.findMany({ where: { merchantId: m.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: own.id, enabled: false, updatedAt: own.updatedAt });
    expect(
      await prisma.event.count({ where: { merchantId: m.id, type: 'gas_policy.updated' } }),
    ).toBe(0);
  });

  it('creates nothing when the shopper pays', async () => {
    const m = await createMerchant({ defaultGasPayer: 'merchant' });
    await updateCheckoutSettings({ merchantId: m.id, livemode: false }, settingsActor, {
      default_gas_payer: 'shopper',
    });
    await updateCheckoutSettings({ merchantId: m.id, livemode: false }, settingsActor, {
      default_fee_payer: 'shopper',
    });
    expect(await prisma.gasPolicy.count()).toBe(0);
  });
});
