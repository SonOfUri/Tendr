import type { GasPolicyInput } from '@tendr/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import { GAS_LOSS_CAP_REACHED, lossCapReached, recognizeTendrLoss } from './loss-cap.js';
import { putGasPolicy } from './policy.js';
import { decideSponsor, type DecideSponsorInput } from './sponsorship.js';

const actor = { by: 'api_key' as const, apiKeyId: 'key_x' };
const NOW = new Date('2026-10-15T12:00:00Z');

async function merchant(
  policy: GasPolicyInput | null = {},
  defaultGasPayer: 'merchant' | 'buyer' = 'merchant',
) {
  const m = await createMerchant({ defaultGasPayer });
  if (policy) {
    await putGasPolicy({ merchantId: m.id, livemode: false, actor }, { enabled: true, ...policy });
  }
  return m;
}

function input(merchantId: string, o: Partial<DecideSponsorInput> = {}): DecideSponsorInput {
  return {
    merchantId,
    livemode: false,
    sessionId: 'ses_x',
    chain: 'base',
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    orderUsd: '25',
    shopperAddress: '0xAbCdEf0000000000000000000000000000000001',
    feeUsd: '0.05',
    sessionOverride: null,
    linkSetting: null,
    gasMaxUsd: null,
    now: NOW,
    ...o,
  };
}

/**
 * A merchant sponsorship (created at `createdAt`, default `at`) whose `usd` cost Tendr recognised
 * as its own loss at `at`, in `livemode`.
 */
async function loss(usd: string, at: Date, livemode = false, createdAt = at) {
  const m = await createMerchant();
  const row = await createRow('GasSponsorship', m.id, livemode, { createdAt });
  await prisma.$transaction((tx) => recognizeTendrLoss(tx, row.id, usd, at));
  return row.id;
}

describe('decideSponsor', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('merchant pays when every check passes', async () => {
    const m = await merchant();
    expect(await decideSponsor(input(m.id))).toEqual({ paidBy: 'merchant', reason: null });
  });

  it('shopper_choice when the resolved payer is the shopper', async () => {
    const m = await merchant({}, 'buyer');
    expect(await decideSponsor(input(m.id))).toEqual({
      paidBy: 'shopper',
      reason: 'shopper_choice',
    });
  });

  it('resolves the payer session override → link setting → merchant default', async () => {
    const m = await merchant({}, 'buyer');
    expect(await decideSponsor(input(m.id, { linkSetting: 'merchant' }))).toEqual({
      paidBy: 'merchant',
      reason: null,
    });
    expect(
      await decideSponsor(input(m.id, { linkSetting: 'merchant', sessionOverride: 'shopper' })),
    ).toMatchObject({ reason: 'shopper_choice' });
    const n = await merchant({});
    expect(await decideSponsor(input(n.id, { linkSetting: 'shopper' }))).toMatchObject({
      reason: 'shopper_choice',
    });
    expect(
      await decideSponsor(input(n.id, { linkSetting: 'shopper', sessionOverride: 'merchant' })),
    ).toMatchObject({ paidBy: 'merchant' });
  });

  it('policy_disabled when the mode has no policy or it is off', async () => {
    const none = await merchant(null);
    expect(await decideSponsor(input(none.id))).toEqual({
      paidBy: 'shopper',
      reason: 'policy_disabled',
    });
    const off = await merchant({ enabled: false });
    expect(await decideSponsor(input(off.id))).toMatchObject({ reason: 'policy_disabled' });
    // The live mode has no policy even though the test mode does.
    expect(await decideSponsor(input(off.id, { livemode: true }))).toMatchObject({
      reason: 'policy_disabled',
    });
  });

  it('chain: eth is refused under the default policy, allowed once added', async () => {
    const m = await merchant();
    expect(await decideSponsor(input(m.id, { chain: 'eth' }))).toEqual({
      paidBy: 'shopper',
      reason: 'chain',
    });
    const withEth = await merchant({ chains: ['eth'] });
    expect(await decideSponsor(input(withEth.id, { chain: 'eth' }))).toMatchObject({
      paidBy: 'merchant',
    });
  });

  it('token: only listed tokens when the list is not empty', async () => {
    const m = await merchant({ tokens: ['nep141:usdc.test'] });
    expect(await decideSponsor(input(m.id))).toEqual({ paidBy: 'shopper', reason: 'token' });
    expect(await decideSponsor(input(m.id, { assetId: 'nep141:usdc.test' }))).toMatchObject({
      paidBy: 'merchant',
    });
  });

  it('min_order: the order must be at least min_order_usd', async () => {
    const m = await merchant({ min_order_usd: '10' });
    expect(await decideSponsor(input(m.id, { orderUsd: '9.99' }))).toEqual({
      paidBy: 'shopper',
      reason: 'min_order',
    });
    expect(await decideSponsor(input(m.id, { orderUsd: '10' }))).toMatchObject({
      paidBy: 'merchant',
    });
  });

  it('first_time_only refuses a returning shopper address (EVM, any case)', async () => {
    const m = await merchant({ first_time_only: true });
    await createRow('Payment', m.id, false, {
      senderAddress: '0xabcdef0000000000000000000000000000000001',
      status: 'SETTLED',
    });
    expect(await decideSponsor(input(m.id))).toEqual({
      paidBy: 'shopper',
      reason: 'not_first_time',
    });
    // Another address, another merchant's shopper, another mode: first time.
    expect(
      await decideSponsor(
        input(m.id, { shopperAddress: '0x0000000000000000000000000000000000000002' }),
      ),
    ).toMatchObject({ paidBy: 'merchant' });
    const n = await merchant({ first_time_only: true });
    expect(await decideSponsor(input(n.id))).toMatchObject({ paidBy: 'merchant' });
    await putGasPolicy(
      { merchantId: m.id, livemode: true, actor },
      { enabled: true, first_time_only: true },
    );
    expect(await decideSponsor(input(m.id, { livemode: true }))).toMatchObject({
      paidBy: 'merchant',
    });
  });

  it('first_time_only also matches any of a payment’s sender addresses', async () => {
    const m = await merchant({ first_time_only: true });
    await createRow('Payment', m.id, false, {
      senderAddresses: [
        '0x9999999999999999999999999999999999999999',
        '0xABCDEF0000000000000000000000000000000001',
      ],
    });
    expect(await decideSponsor(input(m.id))).toMatchObject({ reason: 'not_first_time' });
  });

  it('first_time_only compares non-EVM addresses exactly', async () => {
    const m = await merchant({ first_time_only: true });
    await createRow('Payment', m.id, false, { senderAddress: 'Shopper.near' });
    expect(
      await decideSponsor(input(m.id, { chain: 'near', shopperAddress: 'shopper.near' })),
    ).toMatchObject({ paidBy: 'merchant' });
    expect(
      await decideSponsor(input(m.id, { chain: 'near', shopperAddress: 'Shopper.near' })),
    ).toMatchObject({ reason: 'not_first_time' });
  });

  it('a returning shopper is fine when first_time_only is off', async () => {
    const m = await merchant();
    await createRow('Payment', m.id, false, {
      senderAddress: '0xabcdef0000000000000000000000000000000001',
    });
    expect(await decideSponsor(input(m.id))).toMatchObject({ paidBy: 'merchant' });
  });

  it('per_payment_cap: the fee must be at most min(cap, gas_max_usd)', async () => {
    const m = await merchant({ per_payment_cap_usd: '1' });
    expect(await decideSponsor(input(m.id, { feeUsd: '1.000001' }))).toEqual({
      paidBy: 'shopper',
      reason: 'per_payment_cap',
    });
    expect(await decideSponsor(input(m.id, { feeUsd: '1' }))).toMatchObject({
      paidBy: 'merchant',
    });
    expect(await decideSponsor(input(m.id, { feeUsd: '0.6', gasMaxUsd: '0.5' }))).toMatchObject({
      reason: 'per_payment_cap',
    });
    expect(await decideSponsor(input(m.id, { feeUsd: '0.5', gasMaxUsd: '0.5' }))).toMatchObject({
      paidBy: 'merchant',
    });
  });

  it('budget: refused when the fee does not fit the month remaining (nothing reserved)', async () => {
    const m = await merchant({ monthly_budget_usd: '1' });
    await createRow('GasBudgetMonth', m.id, false, {
      month: '2026-10',
      reservedUsd: '0.5',
      spentUsd: '0.46',
    });
    expect(await decideSponsor(input(m.id, { feeUsd: '0.05' }))).toEqual({
      paidBy: 'shopper',
      reason: 'budget',
    });
    expect(await decideSponsor(input(m.id, { feeUsd: '0.04' }))).toMatchObject({
      paidBy: 'merchant',
    });
    // Another month is untouched.
    expect(
      await decideSponsor(input(m.id, { feeUsd: '0.05', now: new Date('2026-11-01T00:00:00Z') })),
    ).toMatchObject({ paidBy: 'merchant' });
    const row = await prisma.gasBudgetMonth.findFirstOrThrow({ where: { merchantId: m.id } });
    expect(row.reservedUsd.toFixed()).toBe('0.5');
    expect(await prisma.gasSponsorship.count()).toBe(0);
  });

  it('loss cap reached → shopper, and the operator alert is emitted once per day per mode', async () => {
    const m = await merchant();
    await loss('30', new Date('2026-10-15T01:00:00Z'));
    await loss('20', new Date('2026-10-15T11:59:00Z'));
    expect(await decideSponsor(input(m.id))).toEqual({ paidBy: 'shopper', reason: 'loss_cap' });
    expect(await decideSponsor(input(m.id))).toMatchObject({ reason: 'loss_cap' });
    const alerts = await prisma.event.findMany({ where: { type: GAS_LOSS_CAP_REACHED } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ merchantId: null, livemode: null });
    expect(alerts[0]!.payload).toMatchObject({ livemode: false, day: '2026-10-15', cap_usd: '50' });
    const opsLines = logSpy.mock.calls
      .map((c) => JSON.parse(String(c[0])) as { level: string; msg: string })
      .filter((l) => l.msg === 'OPS ALERT: gas.loss_cap_reached');
    expect(opsLines).toHaveLength(1);
    expect(opsLines[0]!.level).toBe('warn');
    // The next UTC day starts from zero.
    expect(
      await decideSponsor(input(m.id, { now: new Date('2026-10-16T00:00:00Z') })),
    ).toMatchObject({ paidBy: 'merchant' });
  });

  it('the loss cap is checked after the per-payment cap and before the budget', async () => {
    const m = await merchant({ monthly_budget_usd: '1', per_payment_cap_usd: '1' });
    await loss('50', NOW);
    expect(await decideSponsor(input(m.id, { feeUsd: '2' }))).toMatchObject({
      reason: 'per_payment_cap',
    });
    await createRow('GasBudgetMonth', m.id, false, { month: '2026-10', spentUsd: '1' });
    expect(await decideSponsor(input(m.id))).toMatchObject({ reason: 'loss_cap' });
  });
});

describe('lossCapReached', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('sums today’s (UTC) Tendr-borne costs in the mode against TENDR_SPONSOR_LOSS_CAP_USD', async () => {
    await loss('49.99', new Date('2026-10-15T00:00:00Z'));
    await loss('100', new Date('2026-10-14T23:59:59Z')); // yesterday
    await loss('100', NOW, true); // live mode
    const m = await createMerchant();
    // Merchant-sponsored costs are recovered, not losses.
    await createRow('GasSponsorship', m.id, false, { costUsd: '100', createdAt: NOW });
    expect(await lossCapReached(false, NOW)).toBe(false);
    await loss('0.01', NOW);
    expect(await lossCapReached(false, NOW)).toBe(true);
    expect(await lossCapReached(true, NOW)).toBe(true);
    expect(await lossCapReached(true, new Date('2026-10-16T00:00:00Z'))).toBe(false);
  });

  it('counts a loss on the UTC day it was recognised, not the day the sponsorship was made', async () => {
    // Made three days ago, recognised today: counts today.
    await loss('50', NOW, false, new Date('2026-10-12T09:00:00Z'));
    expect(await lossCapReached(false, NOW)).toBe(true);
    expect(await lossCapReached(false, new Date('2026-10-12T12:00:00Z'))).toBe(false);
  });
});

describe('recognizeTendrLoss', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('moves the sponsorship to sponsor = tendr with its cost and recognition time, once', async () => {
    const id = await loss('0.3', NOW, false, new Date('2026-10-10T00:00:00Z'));
    const row = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
    expect(row.sponsor).toBe('tendr');
    expect(row.costUsd?.toFixed()).toBe('0.3');
    expect(row.lossRecognizedAt?.toISOString()).toBe(NOW.toISOString());
    // A second call changes nothing (the loss keeps its first recognition time and cost).
    const later = new Date('2026-10-20T00:00:00Z');
    expect(await prisma.$transaction((tx) => recognizeTendrLoss(tx, id, '9', later))).toBe(false);
    const again = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
    expect(again.lossRecognizedAt?.toISOString()).toBe(NOW.toISOString());
    expect(again.costUsd?.toFixed()).toBe('0.3');
  });

  it('rejects a malformed cost', async () => {
    const m = await createMerchant();
    const row = await createRow('GasSponsorship', m.id, false, {});
    await expect(
      prisma.$transaction((tx) => recognizeTendrLoss(tx, row.id, '-1', NOW)),
    ).rejects.toThrow();
  });
});
