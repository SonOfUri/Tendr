import type { Merchant } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpOneClick } from '../checkout/oneclick/index.js';
import { createSession } from '../checkout/sessions.js';
import * as tokens from '../checkout/tokens.js';
import { scopedDb } from '../db/scoped.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb, setLiveMode } from '../test/helpers.js';
import { createLink, getLink, updateLink, type LinkCtx } from './links.js';
import { createLinkSession, getPublicLink } from './public.js';
import { linkSettlementOptions } from './settlement.js';

const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const BTC = 'nep141:btc.omft.near';
const ETH = 'nep141:eth.omft.near';
const DEFAULT = 'nep141:usdc.test';
const input = {
  title: 'Coffee',
  amount_type: 'fixed',
  amount: '5.00',
  currency: 'USD',
  note: 'optional',
} as const;
const sessionInput = {
  amount: '5.00',
  amount_currency: 'USD',
  external_ref: 'order-1',
  success_url: 'https://example.com/paid',
  cancel_url: 'https://example.com/cancel',
};

describe('per-link Intents settlement', () => {
  let merchant: Merchant;
  const ctx = (livemode = false, merchantId = merchant.id): LinkCtx => ({
    merchantId,
    livemode,
    db: scopedDb({ merchantId, livemode }),
  });
  beforeEach(async () => {
    await resetDb();
    tokens.resetTokenCache();
    merchant = await createMerchant({ slug: 'coffee-store' });
    for (const livemode of [false, true]) {
      await createRow('MerchantAccount', merchant.id, livemode, {
        status: 'active',
        nearAccountId: livemode ? 'coffee.near' : 'coffee.testnet',
      });
      await createRow('SettlementConfig', merchant.id, livemode, {
        destAssetId: DEFAULT,
        destChain: 'near',
        payoutMode: 'intents',
        payoutAddress: null,
        isDefault: true,
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    tokens.resetTokenCache();
    setLiveMode(undefined);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('offers separate asset ids for the same symbol on different chains', async () => {
    const options = await linkSettlementOptions(ctx());
    expect(options.store_default).toMatchObject({ asset: DEFAULT, payout_mode: 'intents' });
    expect(options.tokens).toContainEqual({
      asset: BASE_USDC,
      symbol: 'USDC',
      chain: 'base',
      decimals: 6,
    });
    expect(
      new Set(options.tokens.filter((t) => t.symbol === 'USDC').map((t) => t.chain)).size,
    ).toBeGreaterThan(1);
  });

  it('credits the selected asset to the Tendr account even without a store default', async () => {
    await prisma.settlementConfig.deleteMany({
      where: { merchantId: merchant.id, livemode: false },
    });
    const link = await createLink(ctx(), { ...input, settlement_asset: BASE_USDC });
    expect(link).toMatchObject({
      settlement_asset: BASE_USDC,
      settlement_symbol: 'USDC',
      settlement_chain: 'base',
      availability: 'available',
    });
    expect((await getPublicLink(merchant.slug, link.slug, false)).availability).toBe('available');
    await createLinkSession(merchant.slug, link.slug, false, {}, '203.0.113.3');
    const session = await prisma.session.findFirstOrThrow({ where: { paymentLinkId: link.id } });
    expect(session).toMatchObject({
      destAsset: BASE_USDC,
      destChain: 'near',
      recipientType: 'INTENTS',
      recipient: 'coffee.testnet',
      intentsAccount: 'coffee.testnet',
    });
  });

  it('pins old sessions while edits and clearing the override affect only new sessions', async () => {
    const link = await createLink(ctx(), { ...input, settlement_asset: BASE_USDC });
    const first = await createSession(ctx(), { ...sessionInput, payment_link_id: link.id });
    await updateLink(ctx(), link.id, { settlement_asset: BTC });
    await prisma.settlementConfig.updateMany({
      where: { merchantId: merchant.id, livemode: false },
      data: { destAssetId: ETH },
    });
    const second = await createSession(ctx(), {
      ...sessionInput,
      external_ref: 'order-2',
      payment_link_id: link.id,
    });
    const cleared = await updateLink(ctx(), link.id, { settlement_asset: null });
    expect(cleared).toMatchObject({
      settlement_asset: null,
      settlement_symbol: null,
      settlement_chain: null,
    });
    const third = await createSession(ctx(), {
      ...sessionInput,
      external_ref: 'order-3',
      payment_link_id: link.id,
    });
    for (const [id, asset] of [
      [first.id, BASE_USDC],
      [second.id, BTC],
      [third.id, ETH],
    ]) {
      expect(await prisma.session.findUniqueOrThrow({ where: { id } })).toMatchObject({
        destAsset: asset,
        recipient: 'coffee.testnet',
        recipientType: 'INTENTS',
      });
    }
  });

  it('uses an override for token-denominated API sessions and preserves an omitted override on patch', async () => {
    const link = await createLink(ctx(), { ...input, settlement_asset: BASE_USDC });
    await updateLink(ctx(), link.id, { title: 'New title' });
    const session = await createSession(ctx(), {
      ...sessionInput,
      amount_currency: BASE_USDC,
      amount: '1.123456',
      payment_link_id: link.id,
    });
    expect(await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      destAsset: BASE_USDC,
      amountCurrency: BASE_USDC,
    });
    expect((await getLink(ctx(), link.id)).settlement_asset).toBe(BASE_USDC);
  });

  it('refuses unknown assets, cross-store links and cross-mode links', async () => {
    await expect(
      createLink(ctx(), { ...input, settlement_asset: 'nep141:unknown.near' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET' });
    const link = await createLink(ctx(), { ...input, settlement_asset: BASE_USDC });
    await expect(
      updateLink(ctx(), link.id, { settlement_asset: 'nep141:unknown.near' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET' });
    expect((await getLink(ctx(), link.id)).settlement_asset).toBe(BASE_USDC);
    const other = await createMerchant();
    await expect(
      createSession(ctx(false, other.id), { ...sessionInput, payment_link_id: link.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    setLiveMode(true);
    await expect(
      createSession(ctx(true), { ...sessionInput, payment_link_id: link.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('uses the live provider catalog in live mode and keeps the live gate on session creation', async () => {
    const liveAsset = 'nep141:live-only.near';
    vi.spyOn(HttpOneClick.prototype, 'tokens').mockResolvedValue([
      { assetId: liveAsset, symbol: 'USDC', blockchain: 'base', decimals: 6 },
    ]);
    expect((await linkSettlementOptions(ctx(true))).tokens.map((t) => t.asset)).toEqual([
      liveAsset,
    ]);
    // Test-mode links may pin a live-catalog settlement asset (dashboard picker uses live 1Click).
    const testLink = await createLink(ctx(false), { ...input, settlement_asset: liveAsset });
    expect(testLink).toMatchObject({
      settlement_asset: liveAsset,
      settlement_symbol: 'USDC',
      settlement_chain: 'base',
    });
    const link = await createLink(ctx(true), { ...input, settlement_asset: liveAsset });
    setLiveMode(false);
    await expect(
      createSession(ctx(true), { ...sessionInput, payment_link_id: link.id }),
    ).rejects.toMatchObject({ code: 'LIVE_MODE_UNAVAILABLE' });
    setLiveMode(true);
    const created = await createSession(ctx(true), { ...sessionInput, payment_link_id: link.id });
    expect(await prisma.session.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      destAsset: liveAsset,
      recipient: 'coffee.near',
      livemode: true,
    });
  });

  it('keeps overrides unavailable when the account is not provisioned', async () => {
    await prisma.merchantAccount.updateMany({
      where: { merchantId: merchant.id, livemode: false },
      data: { status: 'failed' },
    });
    const link = await createLink(ctx(), { ...input, settlement_asset: BASE_USDC });
    expect(link.availability).toBe('merchant_not_ready');
    await expect(
      createSession(ctx(), { ...sessionInput, payment_link_id: link.id }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
  });

  it('rejects a concurrent settlement edit instead of creating a session with the stale asset', async () => {
    const link = await createLink(ctx(), { ...input, settlement_asset: BASE_USDC });
    const lookup = tokens.tokenInfo;
    vi.spyOn(tokens, 'tokenInfo').mockImplementationOnce(async (...args) => {
      const token = await lookup(...args);
      await prisma.paymentLink.update({
        where: { id: link.id },
        data: { settlementAssetId: BTC, settlementAssetSymbol: 'BTC', settlementAssetChain: 'btc' },
      });
      return token;
    });
    await expect(
      createSession(ctx(), { ...sessionInput, payment_link_id: link.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await prisma.session.count()).toBe(0);
  });
});
