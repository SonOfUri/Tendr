import type { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  GAS_BUDGET_EXHAUSTED,
  GAS_BUDGET_LOW,
  releaseReservation,
  reserveBudget,
  settleReservation,
} from './budget.js';
import { putGasPolicy } from './policy.js';

const actor = { by: 'api_key' as const, apiKeyId: 'key_x' };
const AT = new Date('2026-10-15T12:00:00Z');
const MONTH = '2026-10';

async function setup(budget = '50', cap = budget) {
  const m = await createMerchant({ defaultGasPayer: 'merchant' });
  await putGasPolicy(
    { merchantId: m.id, livemode: false, actor },
    { enabled: true, monthly_budget_usd: budget, per_payment_cap_usd: cap },
  );
  return m;
}

async function session(merchantId: string, livemode = false): Promise<string> {
  return (await createRow('Session', merchantId, livemode)).id;
}

function reserve(merchantId: string, sessionId: string, usd: string, livemode = false) {
  return prisma.$transaction((tx) =>
    reserveBudget(tx, {
      merchantId,
      livemode,
      sessionId,
      usd,
      at: AT,
      chain: 'base',
      method: 'eip3009',
      provider: 'tendr',
    }),
  );
}

async function month(merchantId: string, livemode = false) {
  return prisma.gasBudgetMonth.findFirst({ where: { merchantId, livemode, month: MONTH } });
}

const n = (d: Prisma.Decimal | null | undefined) => d?.toFixed();

describe('gas budget reservations', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('two concurrent reservations of $30 against a $50 budget: exactly one succeeds', async () => {
    const m = await setup('50');
    const [a, b] = [await session(m.id), await session(m.id)];
    // The month row already exists, so only its row lock (not the insert) serialises the two.
    await createRow('GasBudgetMonth', m.id, false, { month: MONTH });
    // Two real Postgres transactions in parallel; each holds its lock a moment after reserving so
    // the other has to wait on the month row.
    const race = (sessionId: string) =>
      prisma.$transaction(
        async (tx) => {
          const r = await reserveBudget(tx, {
            merchantId: m.id,
            livemode: false,
            sessionId,
            usd: '30',
            at: AT,
            chain: 'base',
            method: 'eip3009',
            provider: 'tendr',
          });
          await tx.$queryRaw`SELECT pg_sleep(0.1)::text`;
          return r;
        },
        { timeout: 10_000 },
      );
    const results = await Promise.all([race(a), race(b)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const row = await month(m.id);
    expect(n(row?.reservedUsd)).toBe('30');
    expect(row?.count).toBe(1);
    expect(await prisma.gasSponsorship.count({ where: { reservationState: 'reserved' } })).toBe(1);
  });

  it('eight concurrent reservations of $20 against a $50 budget: exactly two succeed', async () => {
    const m = await setup('50', '20');
    await createRow('GasBudgetMonth', m.id, false, { month: MONTH });
    const sessions = await Promise.all(Array.from({ length: 8 }, () => session(m.id)));
    const results = await Promise.all(sessions.map((s) => reserve(m.id, s, '20')));
    expect(results.filter((r) => r !== null)).toHaveLength(2);
    expect(n((await month(m.id))?.reservedUsd)).toBe('40');
  });

  it('records the reservation as a merchant sponsorship of the session with its estimate', async () => {
    const m = await setup();
    const s = await session(m.id);
    const r = await reserve(m.id, s, '0.42');
    expect(r).not.toBeNull();
    const row = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: r!.sponsorshipId } });
    expect(row).toMatchObject({
      merchantId: m.id,
      livemode: false,
      sessionId: s,
      sponsor: 'merchant',
      reservationState: 'reserved',
      chain: 'base',
      method: 'eip3009',
      provider: 'tendr',
    });
    expect(n(row.estimateUsd)).toBe('0.42');
    expect(row.createdAt.toISOString()).toBe(AT.toISOString());
  });

  it('refuses a reservation that would take reserved + spent above the budget', async () => {
    const m = await setup('1');
    const s = await session(m.id);
    expect(await reserve(m.id, s, '0.6')).not.toBeNull();
    expect(await reserve(m.id, await session(m.id), '0.41')).toBeNull();
    expect(await reserve(m.id, await session(m.id), '0.4')).not.toBeNull();
    expect(n((await month(m.id))?.reservedUsd)).toBe('1');
  });

  it('a mode without a policy reserves against the default $50 budget; modes are separate', async () => {
    const m = await createMerchant();
    expect(await reserve(m.id, await session(m.id, true), '45', true)).not.toBeNull();
    expect(await reserve(m.id, await session(m.id, true), '6', true)).toBeNull();
    expect(await reserve(m.id, await session(m.id), '45')).not.toBeNull();
  });

  it('release then reserve again succeeds', async () => {
    const m = await setup('50');
    const r = await reserve(m.id, await session(m.id), '30');
    expect(await reserve(m.id, await session(m.id), '30')).toBeNull();
    await prisma.$transaction((tx) => releaseReservation(tx, r!.sponsorshipId));
    const row = await month(m.id);
    expect(n(row?.reservedUsd)).toBe('0');
    expect(row?.count).toBe(0);
    expect(await reserve(m.id, await session(m.id), '30')).not.toBeNull();
  });

  it('settle moves the reservation to spent at the given usd', async () => {
    const m = await setup('50');
    const r = await reserve(m.id, await session(m.id), '0.5');
    await prisma.$transaction((tx) => settleReservation(tx, r!.sponsorshipId, '0.4'));
    const row = await month(m.id);
    expect(n(row?.reservedUsd)).toBe('0');
    expect(n(row?.spentUsd)).toBe('0.4');
    expect(row?.count).toBe(1);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: r!.sponsorshipId } });
    expect(sp.reservationState).toBe('settled');
  });

  it('settle and release are idempotent, and neither undoes the other', async () => {
    const m = await setup('50');
    const a = await reserve(m.id, await session(m.id), '0.5');
    const b = await reserve(m.id, await session(m.id), '0.7');
    await prisma.$transaction((tx) => settleReservation(tx, a!.sponsorshipId, '0.5'));
    await prisma.$transaction((tx) => settleReservation(tx, a!.sponsorshipId, '0.5'));
    await prisma.$transaction((tx) => releaseReservation(tx, a!.sponsorshipId));
    await prisma.$transaction((tx) => releaseReservation(tx, b!.sponsorshipId));
    await prisma.$transaction((tx) => releaseReservation(tx, b!.sponsorshipId));
    await prisma.$transaction((tx) => settleReservation(tx, b!.sponsorshipId, '0.7'));
    const row = await month(m.id);
    expect(n(row?.reservedUsd)).toBe('0');
    expect(n(row?.spentUsd)).toBe('0.5');
    expect(row?.count).toBe(1);
    const states = await prisma.gasSponsorship.findMany({ orderBy: { estimateUsd: 'asc' } });
    expect(states.map((s) => s.reservationState)).toEqual(['settled', 'released']);
  });

  it('a new reservation for the same session releases the previous one', async () => {
    const m = await setup('50');
    const s = await session(m.id);
    const first = await reserve(m.id, s, '0.5');
    const second = await reserve(m.id, s, '0.3');
    expect(second!.sponsorshipId).not.toBe(first!.sponsorshipId);
    const old = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: first!.sponsorshipId },
    });
    expect(old.reservationState).toBe('released');
    const row = await month(m.id);
    expect(n(row?.reservedUsd)).toBe('0.3');
    expect(row?.count).toBe(1);
  });

  it('refuses a session of another merchant or mode', async () => {
    const m = await setup();
    const other = await createMerchant();
    await expect(reserve(m.id, await session(other.id), '0.1')).rejects.toThrow();
    await expect(reserve(m.id, await session(m.id, true), '0.1')).rejects.toThrow();
  });

  it('emits gas.budget_low once when reserved + spent crosses 80 %, not again that month', async () => {
    const m = await setup('50');
    await reserve(m.id, await session(m.id), '30'); // 60 %
    const low = () => prisma.event.count({ where: { merchantId: m.id, type: GAS_BUDGET_LOW } });
    expect(await low()).toBe(0);
    await reserve(m.id, await session(m.id), '11'); // 82 %
    expect(await low()).toBe(1);
    const ev = await prisma.event.findFirstOrThrow({ where: { type: GAS_BUDGET_LOW } });
    expect(ev.livemode).toBe(false);
    expect(ev.payload).toMatchObject({ month: MONTH, budget_usd: '50' });
    await reserve(m.id, await session(m.id), '5'); // 92 %
    expect(await low()).toBe(1);
  });

  it('emits gas.budget_exhausted once per month when a reservation is refused for budget', async () => {
    const m = await setup('1');
    await reserve(m.id, await session(m.id), '0.9');
    expect(await reserve(m.id, await session(m.id), '0.5')).toBeNull();
    expect(await reserve(m.id, await session(m.id), '0.2')).toBeNull();
    expect(
      await prisma.event.count({ where: { merchantId: m.id, type: GAS_BUDGET_EXHAUSTED } }),
    ).toBe(1);
  });
});
