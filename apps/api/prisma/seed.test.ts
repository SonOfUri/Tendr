import { ALL_SCOPES } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { flushLastUsed } from '../src/gateway/auth.js';
import { prisma } from '../src/lib/prisma.js';
import { resetDb } from '../src/test/helpers.js';
import { DEMO_MERCHANT_NAME, isValidEvmAddress, PUBLISHABLE_KEY_SCOPES, seed } from './seed.js';

const PAYOUT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const silent = () => {};

const liveConfigs = () => prisma.settlementConfig.findMany({ where: { livemode: true } });

describe('seed', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates no live settlement config without SEED_PAYOUT_ADDRESS', async () => {
    const lines: string[] = [];
    const result = await seed({ payoutAddress: undefined, out: (l) => lines.push(l) });

    expect(result.liveSettlementConfigured).toBe(false);
    expect(await liveConfigs()).toEqual([]);
    expect(lines.join('\n')).toMatch(/Live payments are disabled/);

    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: result.merchantId } });
    expect(merchant).toMatchObject({ name: DEMO_MERCHANT_NAME, slug: 'demo-merchant' });
    expect(merchant.kind).toBe('merchant');
    expect(merchant.status).toBe('active');
    expect(await prisma.settlementConfig.findMany({ where: { livemode: false } })).toMatchObject([
      { payoutMode: 'wallet', destChain: 'base', isDefault: true },
    ]);
    expect(await prisma.merchantUser.findMany()).toMatchObject([
      { email: 'owner@demo.tendr.local', role: 'owner' },
    ]);
    expect(await prisma.checkoutTheme.findMany()).toMatchObject([
      { isDefault: true, status: 'published' },
    ]);
    expect(await prisma.feePlan.findMany()).toMatchObject([
      { feeBps: 50, defaultFeePayer: 'merchant' },
    ]);
    expect(await prisma.apiKey.count()).toBe(4);
    expect(Object.values(result.rawKeys).map((k) => k.replace(/[0-9a-f]{48}$/, ''))).toEqual([
      'tdr_test_',
      'tdr_live_',
      'tdr_pk_test_',
      'tdr_pk_live_',
    ]);
  });

  it('creates exactly one live settlement config with a valid SEED_PAYOUT_ADDRESS', async () => {
    const result = await seed({ payoutAddress: PAYOUT, out: silent });
    expect(result.liveSettlementConfigured).toBe(true);
    expect(await liveConfigs()).toMatchObject([{ payoutAddress: PAYOUT, payoutMode: 'wallet' }]);

    await seed({ payoutAddress: PAYOUT, out: silent });
    expect(await liveConfigs()).toHaveLength(1);
  });

  it('refuses the zero address and invalid addresses, writing nothing', async () => {
    await expect(
      seed({ payoutAddress: '0x0000000000000000000000000000000000000000', out: silent }),
    ).rejects.toThrow(/zero address/);
    await expect(seed({ payoutAddress: '0x1234', out: silent })).rejects.toThrow(/not a valid/);
    expect(await prisma.merchant.count()).toBe(0);
  });

  it('is idempotent: a second run reports already seeded and creates nothing', async () => {
    const first = await seed({ payoutAddress: undefined, out: silent });
    const lines: string[] = [];
    const second = await seed({ payoutAddress: undefined, out: (l) => lines.push(l) });

    expect(second.alreadySeeded).toBe(true);
    expect(second.merchantId).toBe(first.merchantId);
    expect(second.rawKeys).toEqual({});
    expect(lines[0]).toMatch(/already seeded/);
    expect(await prisma.merchant.count()).toBe(1);
    expect(await prisma.apiKey.count()).toBe(4);
    expect(await prisma.settlementConfig.count()).toBe(1);
    expect(await prisma.checkoutTheme.count()).toBe(1);
    expect(await prisma.feePlan.count()).toBe(1);
  });

  it('adds the live settlement config on a rerun once SEED_PAYOUT_ADDRESS is set', async () => {
    await seed({ payoutAddress: undefined, out: silent });
    await seed({ payoutAddress: PAYOUT, out: silent });
    expect(await liveConfigs()).toMatchObject([{ payoutAddress: PAYOUT }]);
  });

  it('warns, without changing it, when SEED_PAYOUT_ADDRESS differs from the live config', async () => {
    await seed({ payoutAddress: PAYOUT, out: silent });
    const other = '0x0000000000000000000000000000000000000002';
    const lines: string[] = [];
    await seed({ payoutAddress: other, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/differs from the existing live settlement config/);
    expect(await liveConfigs()).toMatchObject([{ payoutAddress: PAYOUT }]);

    const again: string[] = [];
    await seed({ payoutAddress: PAYOUT.toLowerCase(), out: (l) => again.push(l) });
    expect(again.join('\n')).not.toMatch(/differs/);
  });

  it('publishable keys get narrow checkout scopes; secret keys get every scope', async () => {
    await seed({ payoutAddress: undefined, out: silent });
    const keys = await prisma.apiKey.findMany({ select: { kind: true, scopes: true } });
    expect(keys).toHaveLength(4);
    for (const key of keys) {
      expect(key.scopes.sort()).toEqual(
        [...(key.kind === 'publishable' ? PUBLISHABLE_KEY_SCOPES : ALL_SCOPES)].sort(),
      );
    }
    expect(PUBLISHABLE_KEY_SCOPES).toEqual([
      'sessions:read',
      'sessions:write',
      'payment_links:read',
    ]);
  });

  it('seeded keys authenticate through the gateway', async () => {
    const { merchantId, rawKeys } = await seed({ payoutAddress: undefined, out: silent });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp();
      const ping = (raw: string) =>
        app!.inject({ url: '/v1/ping', headers: { authorization: `Bearer ${raw}` } });
      expect((await ping(rawKeys['Secret test key']!)).json()).toMatchObject({
        merchantId,
        livemode: false,
        principal: 'secret_key',
      });
      expect((await ping(rawKeys['Publishable live key']!)).json()).toMatchObject({
        livemode: true,
        principal: 'publishable_key',
      });
    } finally {
      await flushLastUsed();
      await app?.close();
      logSpy.mockRestore();
    }
  });
});

describe('isValidEvmAddress', () => {
  it('accepts lowercase, uppercase and valid checksums; rejects bad checksums', () => {
    expect(isValidEvmAddress(PAYOUT)).toBe(true);
    expect(isValidEvmAddress(PAYOUT.toLowerCase())).toBe(true);
    expect(isValidEvmAddress(`0x${PAYOUT.slice(2).toUpperCase()}`)).toBe(true);
    expect(isValidEvmAddress(PAYOUT.replace('fCD', 'fcD'))).toBe(false);
    expect(isValidEvmAddress('0x833589')).toBe(false);
  });
});
