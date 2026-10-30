// Gas balance alerts (Task 12): relayer keys and the Pimlico balance below GAS_LOW_BALANCE_USD
// alert operators once per 6 h per account; the daily loss-cap alert is reused. Fake readers only.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lossCap from '../gas/loss-cap.js';
import { loadEnv } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { resetDb } from '../test/helpers.js';
import {
  GAS_BALANCE_LOW,
  PIMLICO_BALANCE_LOW,
  checkGasBalances,
  setGasAlertDeps,
  type GasAccount,
} from './gas-alerts.js';

const NOW = new Date('2026-10-28T12:00:00Z');
const H = 60 * 60_000;
const ACCOUNTS: GasAccount[] = [
  { key: 'relayer-evm', chain: 'base', address: '0xrelayer' },
  { key: 'relayer-evm', chain: 'arb', address: '0xrelayer' },
  { key: 'gas-tron', chain: 'tron', address: 'Tgas' },
  { key: 'relayer-near', chain: 'near', address: 'relayer.near' },
];

let usd: Record<string, string>;
let pimlico: string | null;
const events = (type: string) =>
  prisma.event.findMany({ where: { type }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await resetDb();
  delete process.env.GAS_LOW_BALANCE_USD;
  loadEnv();
  usd = { base: '120', arb: '12.5', tron: '49.99', near: '50' };
  pimlico = '500';
  setGasAlertDeps({
    accounts: async () => ACCOUNTS,
    nativeBalance: async (a) => BigInt(a.chain.length),
    usd: async (chain) => usd[chain]!,
    pimlicoBalanceUsd: async () => pimlico,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  setGasAlertDeps(null);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('checkGasBalances', () => {
  it('alerts for each account below GAS_LOW_BALANCE_USD (default 50), not at or above it', async () => {
    const r = await checkGasBalances(NOW);
    expect(r.filter((x) => x.low).map((x) => `${x.key}:${x.chain}`)).toEqual([
      'relayer-evm:arb',
      'gas-tron:tron',
    ]);
    const ev = await events(GAS_BALANCE_LOW);
    expect(ev.map((e) => e.aggregateId).sort()).toEqual([
      'gas_low:gas-tron:tron:Tgas',
      'gas_low:relayer-evm:arb:0xrelayer',
    ]);
    expect(ev[0]!.merchantId).toBeNull();
    expect(await events(PIMLICO_BALANCE_LOW)).toHaveLength(0);
  });

  it('throttles at 6 h per account', async () => {
    await checkGasBalances(NOW);
    await checkGasBalances(new Date(NOW.getTime() + 15 * 60_000));
    await checkGasBalances(new Date(NOW.getTime() + 6 * H - 1));
    expect(await events(GAS_BALANCE_LOW)).toHaveLength(2);
    // Another account turning low is alerted at once.
    usd.base = '1';
    await checkGasBalances(new Date(NOW.getTime() + 6 * H - 1));
    expect(await events(GAS_BALANCE_LOW)).toHaveLength(3);
    const r = await checkGasBalances(new Date(NOW.getTime() + 6 * H));
    expect(
      r
        .filter((x) => x.alerted)
        .map((x) => x.chain)
        .sort(),
    ).toEqual(['arb', 'tron']);
    expect(await events(GAS_BALANCE_LOW)).toHaveLength(5);
  });

  it('alerts on a low Pimlico balance, throttled, and skips an unknown one', async () => {
    pimlico = '10';
    await checkGasBalances(NOW);
    await checkGasBalances(new Date(NOW.getTime() + H));
    expect(await events(PIMLICO_BALANCE_LOW)).toHaveLength(1);
    pimlico = null;
    const r = await checkGasBalances(new Date(NOW.getTime() + 7 * H));
    expect(r.find((x) => x.key === 'pimlico')).toBeUndefined();
    expect(await events(PIMLICO_BALANCE_LOW)).toHaveLength(1);
  });

  it('honours GAS_LOW_BALANCE_USD and skips a balance it cannot read', async () => {
    process.env.GAS_LOW_BALANCE_USD = '10';
    loadEnv();
    setGasAlertDeps({
      accounts: async () => ACCOUNTS,
      nativeBalance: async (a) => {
        if (a.chain === 'near') throw new Error('rpc down');
        return 1n;
      },
      usd: async (chain) => usd[chain]!,
      pimlicoBalanceUsd: async () => pimlico,
    });
    const r = await checkGasBalances(NOW);
    expect(r.map((x) => x.chain)).toEqual(['base', 'arb', 'tron', 'pimlico']);
    expect(r.some((x) => x.low)).toBe(false);
    delete process.env.GAS_LOW_BALANCE_USD;
    loadEnv();
  });

  it('reuses the loss-cap alert (Task 2) when the cap is reached', async () => {
    const reached = vi.spyOn(lossCap, 'lossCapReached').mockResolvedValue(true);
    const alert = vi.spyOn(lossCap, 'alertLossCapReached').mockResolvedValue();
    await checkGasBalances(NOW);
    expect(reached).toHaveBeenCalledWith(true, NOW);
    expect(alert).toHaveBeenCalledWith(true, NOW);
  });
});
