import type { Merchant } from '@prisma/client';
import { LINK_SLUG_RE, PaymentLinkUpdateSchema, RESERVED_LINK_SLUGS } from '@tendr/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFxCache } from '../checkout/fx.js';
import { scopedDb } from '../db/scoped.js';
import { loadEnv } from '../env.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getRedis, whenReady } from '../lib/redis.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  archiveLink,
  assertAboveFloor,
  createLink,
  getLink,
  linkAvailability,
  linkUrls,
  listLinks,
  updateLink,
  type LinkCtx,
} from './links.js';

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('payment link service', () => {
  let merchant: Merchant;

  const ctxOf = (livemode = false, merchantId = merchant.id): LinkCtx => ({
    merchantId,
    livemode,
    db: scopedDb({ merchantId, livemode }),
  });

  beforeAll(async () => {
    await whenReady(getRedis());
  });
  beforeEach(async () => {
    await resetDb();
    await resetFxCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    merchant = await createMerchant({ slug: 'acme' });
    for (const livemode of [false, true]) {
      await createRow('MerchantAccount', merchant.id, livemode, { status: 'active' });
      await createRow('SettlementConfig', merchant.id, livemode, {
        destAssetId: 'nep141:usdc.test',
        destChain: 'near',
        payoutMode: 'intents',
        payoutAddress: null,
        isDefault: true,
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    loadEnv();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const fixedNgn = {
    title: 'Sunday Offering',
    amount_type: 'fixed',
    amount: '5000',
    currency: 'NGN',
    note: 'optional',
  } as const;
  const fixedUsd = { ...fixedNgn, currency: 'USD', amount: '5' } as const;

  describe('create', () => {
    it('creates a fixed NGN link with a generated slug', async () => {
      const a = await createLink(ctxOf(), fixedNgn);
      expect(a).toMatchObject({
        object: 'payment_link',
        livemode: false,
        title: 'Sunday Offering',
        slug: 'sunday-offering',
        amount_type: 'fixed',
        amount: '5000.00',
        currency: 'NGN',
        min_amount: null,
        note: 'optional',
        fee_payer: null,
        gas_payer: null,
        status: 'active',
        archived: false,
        availability: 'available',
        use_count: 0,
        total_paid: '0.00',
        total_paid_usd: '0.00',
        total_refunded: '0.00',
        total_refunded_usd: '0.00',
      });
      expect(a.id).toMatch(/^plink_/);
      expect(a.url).toBe('http://localhost:3000/pay/acme/sunday-offering?mode=test');
      expect(a.qr_url).toBe('http://localhost:3000/pay/acme/sunday-offering/qr?mode=test');
      const b = await createLink(ctxOf(), fixedNgn);
      expect(b.slug).not.toBe(a.slug);
      expect(b.slug).toMatch(LINK_SLUG_RE);
      expect(b.slug.startsWith('sunday-offering')).toBe(true);
    });

    it('uses an explicit slug and refuses a taken one', async () => {
      const a = await createLink(ctxOf(), { ...fixedNgn, slug: 'give' });
      expect(a.slug).toBe('give');
      const err = await rejection(createLink(ctxOf(), { ...fixedNgn, slug: 'give' }));
      expect(err.code).toBe('CONFLICT');
    });

    it('never generates a reserved or too-short slug', async () => {
      for (const title of ['QR', 'Test', '!!', 'a']) {
        const l = await createLink(ctxOf(), { ...fixedNgn, title });
        expect(l.slug).toMatch(LINK_SLUG_RE);
        expect(RESERVED_LINK_SLUGS).not.toContain(l.slug);
      }
    });

    it('same slug allowed in test and live mode', async () => {
      const t = await createLink(ctxOf(false), { ...fixedUsd, slug: 'give' });
      const l = await createLink(ctxOf(true), { ...fixedUsd, slug: 'give' });
      expect(t.slug).toBe('give');
      expect(l.slug).toBe('give');
      expect(t.url).toContain('?mode=test');
      expect(l.url).toBe('http://localhost:3000/pay/acme/give');
      expect(l.livemode).toBe(true);
    });

    it('rejects unsupported currency and the settlement asset id', async () => {
      for (const currency of ['XXX', 'nep141:usdc.test', 'usd']) {
        const err = await rejection(createLink(ctxOf(), { ...fixedNgn, currency }));
        expect(err.code).toBe('UNSUPPORTED_CURRENCY');
        expect(err.status).toBe(400);
      }
    });

    it('rejects amounts with excess precision for the currency', async () => {
      const usd = await rejection(createLink(ctxOf(), { ...fixedUsd, amount: '10.001' }));
      expect(usd.code).toBe('VALIDATION_ERROR');
      const jpy = await rejection(
        createLink(ctxOf(), { ...fixedNgn, currency: 'JPY', amount: '5.5' }),
      );
      expect(jpy.code).toBe('VALIDATION_ERROR');
      const min = await rejection(
        createLink(ctxOf(), {
          title: 'Open',
          amount_type: 'open',
          note: 'optional',
          currency: 'USD',
          min_amount: '2.005',
        }),
      );
      expect(min.code).toBe('VALIDATION_ERROR');
    });

    it('refuses links for integrator merchants with contract payout', async () => {
      const integrator = await createMerchant({ kind: 'integrator', slug: 'integ' });
      await createRow('MerchantAccount', integrator.id, false, { status: 'active' });
      await createRow('SettlementConfig', integrator.id, false, {
        destAssetId: 'nep141:usdc.test',
        destChain: 'base',
        payoutMode: 'wallet',
        payoutAddress: '0x0000000000000000000000000000000000000001',
        isDefault: true,
      });
      const err = await rejection(createLink(ctxOf(false, integrator.id), fixedNgn));
      expect(err.code).toBe('LINK_NOT_SUPPORTED');
      expect(err.status).toBe(409);
      // An integrator that settles to its Intents account is a normal store.
      const plain = await createMerchant({ kind: 'integrator', slug: 'integ2' });
      await createRow('SettlementConfig', plain.id, false, {
        payoutMode: 'intents',
        payoutAddress: null,
      });
      await expect(createLink(ctxOf(false, plain.id), fixedNgn)).resolves.toMatchObject({
        object: 'payment_link',
      });
    });

    it('creates an open link with a min_amount and settings', async () => {
      const l = await createLink(ctxOf(), {
        title: 'Tip jar',
        amount_type: 'open',
        currency: 'USD',
        min_amount: '2',
        note: 'off',
        fee_payer: 'shopper',
        gas_payer: 'merchant',
        gas_max_usd: '0.5',
        max_uses: 3,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        status: 'inactive',
      });
      expect(l).toMatchObject({
        amount_type: 'open',
        amount: null,
        min_amount: '2.00',
        note: 'off',
        fee_payer: 'shopper',
        gas_payer: 'merchant',
        gas_max_usd: '0.5',
        max_uses: 3,
        status: 'inactive',
        availability: 'inactive',
      });
    });
  });

  describe('$1 floor', () => {
    const rate1600 = () => loadEnv({ ...process.env, FX_FIXED_RATES: '{"NGN":"1600"}' });

    it('fixed link below the $1 floor is refused', async () => {
      rate1600();
      const err = await rejection(createLink(ctxOf(), { ...fixedNgn, amount: '1000' }));
      expect(err.code).toBe('AMOUNT_TOO_LOW');
      expect(err.status).toBe(400);
      expect(err.details).toMatchObject({ min_amount: '1600.00' });
      await expect(createLink(ctxOf(), { ...fixedNgn, amount: '1600' })).resolves.toMatchObject({
        amount: '1600.00',
      });
    });

    it('a USD link below $1 is refused', async () => {
      const err = await rejection(createLink(ctxOf(), { ...fixedUsd, amount: '0.99' }));
      expect(err).toMatchObject({ code: 'AMOUNT_TOO_LOW', details: { min_amount: '1.00' } });
    });

    it('rounds the floor up to the currency minor units', async () => {
      loadEnv({ ...process.env, FX_FIXED_RATES: '{"JPY":"151.5"}' });
      const fx = { livemode: false };
      const err = await rejection(assertAboveFloor('151', 'JPY', new Date(), fx));
      expect(err.details).toMatchObject({ min_amount: '152' });
      await expect(assertAboveFloor('152', 'JPY', new Date(), fx)).resolves.toBeUndefined();
    });

    it('FX down refuses a non-USD fixed link', async () => {
      // Live mode with no live provider configured: every rate is unavailable.
      const err = await rejection(createLink(ctxOf(true), fixedNgn));
      expect(err.code).toBe('FX_RATE_UNAVAILABLE');
      await expect(createLink(ctxOf(true), fixedUsd)).resolves.toMatchObject({ currency: 'USD' });
    });

    it('applies the same checks on update when the amount changes', async () => {
      rate1600();
      const l = await createLink(ctxOf(), { ...fixedNgn, amount: '5000' });
      const low = await rejection(updateLink(ctxOf(), l.id, { amount: '1000' }));
      expect(low).toMatchObject({ code: 'AMOUNT_TOO_LOW', details: { min_amount: '1600.00' } });
      expect((await updateLink(ctxOf(), l.id, { amount: '1600' })).amount).toBe('1600.00');
    });

    it('does not call FX when the amount and currency are unchanged', async () => {
      // A live NGN link with FX unavailable can still be renamed.
      const row = await createRow('PaymentLink', merchant.id, true, {
        slug: 'old',
        amount: '5000',
        amountCurrency: 'NGN',
      });
      const renamed = await updateLink(ctxOf(true), row.id, { title: 'Renamed' });
      expect(renamed.title).toBe('Renamed');
      const err = await rejection(updateLink(ctxOf(true), row.id, { amount: '6000' }));
      expect(err.code).toBe('FX_RATE_UNAVAILABLE');
    });

    it('re-checks precision when the currency changes', async () => {
      const l = await createLink(ctxOf(), { ...fixedUsd, amount: '5.25' });
      const err = await rejection(updateLink(ctxOf(), l.id, { currency: 'JPY' }));
      expect(err.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('update', () => {
    it('slug cannot be changed by update', async () => {
      const l = await createLink(ctxOf(), fixedNgn);
      // The route schema drops the key; the service refuses it if it ever arrives.
      expect(PaymentLinkUpdateSchema.parse({ slug: 'other', title: 'x' })).not.toHaveProperty(
        'slug',
      );
      const err = await rejection(
        updateLink(ctxOf(), l.id, { slug: 'other' } as unknown as Parameters<typeof updateLink>[2]),
      );
      expect(err.status).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect((await getLink(ctxOf(), l.id)).slug).toBe(l.slug);
    });

    it('switches between fixed and open amounts', async () => {
      const l = await createLink(ctxOf(), fixedUsd);
      const open = await updateLink(ctxOf(), l.id, {
        amount_type: 'open',
        note: 'optional',
        min_amount: '3',
      });
      expect(open).toMatchObject({
        amount_type: 'open',
        note: 'optional',
        amount: null,
        min_amount: '3.00',
      });
      const fixed = await updateLink(ctxOf(), l.id, { amount_type: 'fixed', amount: '7' });
      expect(fixed).toMatchObject({ amount_type: 'fixed', amount: '7.00', min_amount: null });
      // Open without a min_amount drops the old amount and clears the minimum.
      const plain = await updateLink(ctxOf(), l.id, { amount_type: 'open' });
      expect(plain).toMatchObject({ amount: null, min_amount: null });
    });

    it('refuses an amount on an open link and a fixed link without one', async () => {
      const open = await createLink(ctxOf(), {
        title: 'Tip',
        amount_type: 'open',
        note: 'optional',
        currency: 'USD',
      });
      const stray = await rejection(updateLink(ctxOf(), open.id, { amount: '7' }));
      expect(stray.code).toBe('VALIDATION_ERROR');
      const noAmount = await rejection(updateLink(ctxOf(), open.id, { amount_type: 'fixed' }));
      expect(noAmount.code).toBe('VALIDATION_ERROR');
    });

    it('updates settings', async () => {
      const l = await createLink(ctxOf(), fixedUsd);
      const u = await updateLink(ctxOf(), l.id, {
        note: 'off',
        status: 'inactive',
        max_uses: 2,
        fee_payer: 'shopper',
        description: 'Thanks',
      });
      expect(u).toMatchObject({
        note: 'off',
        status: 'inactive',
        max_uses: 2,
        fee_payer: 'shopper',
        description: 'Thanks',
        availability: 'inactive',
      });
    });
  });

  describe('availability', () => {
    const base = {
      archivedAt: null as Date | null,
      status: 'active' as 'active' | 'inactive' | 'expired',
      expiresAt: null as Date | null,
      maxUses: null as number | null,
      useCount: 0,
    };
    const now = new Date('2026-10-30T12:00:00Z');
    const past = new Date('2026-10-30T11:00:00Z');
    const ok = { now, merchantReady: true };

    it('checks in order: archived, inactive, expired, used_up, merchant_not_ready, available', () => {
      const archivedAll = {
        ...base,
        archivedAt: past,
        expiresAt: past,
        status: 'inactive' as const,
      };
      expect(linkAvailability(archivedAll, ok)).toBe('archived');
      expect(linkAvailability({ ...base, status: 'inactive', expiresAt: past }, ok)).toBe(
        'inactive',
      );
      expect(linkAvailability({ ...base, expiresAt: past, maxUses: 1, useCount: 1 }, ok)).toBe(
        'expired',
      );
      expect(linkAvailability({ ...base, expiresAt: now }, ok)).toBe('expired');
      expect(
        linkAvailability({ ...base, maxUses: 2, useCount: 2 }, { now, merchantReady: false }),
      ).toBe('used_up');
      expect(linkAvailability({ ...base, maxUses: 2, useCount: 3 }, ok)).toBe('used_up');
      expect(linkAvailability(base, { now, merchantReady: false })).toBe('merchant_not_ready');
      const later = new Date(now.getTime() + 1);
      expect(linkAvailability({ ...base, maxUses: 2, useCount: 1, expiresAt: later }, ok)).toBe(
        'available',
      );
    });

    it('reports merchant_not_ready when the mode has no active account', async () => {
      const m2 = await createMerchant({ slug: 'noacct' });
      const l = await createLink(ctxOf(false, m2.id), fixedUsd);
      expect(l.availability).toBe('merchant_not_ready');
    });

    it('computes expired on read without persisting it', async () => {
      const l = await createLink(ctxOf(), fixedUsd);
      await prisma.paymentLink.update({
        where: { id: l.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const read = await getLink(ctxOf(), l.id);
      expect(read.availability).toBe('expired');
      expect(read.status).toBe('active');
      const row = await prisma.paymentLink.findUniqueOrThrow({ where: { id: l.id } });
      expect(row.status).toBe('active');
    });
  });

  describe('list, archive', () => {
    it('archive hides from default list; include_archived shows it; PATCH archived:false restores', async () => {
      const a = await createLink(ctxOf(), fixedUsd);
      const b = await createLink(ctxOf(), { ...fixedUsd, amount: '6' });
      const archived = await archiveLink(ctxOf(), a.id);
      expect(archived).toMatchObject({ archived: true, availability: 'archived' });
      const q = { limit: 10 };
      expect((await listLinks(ctxOf(), q)).data.map((l) => l.id)).toEqual([b.id]);
      const all = await listLinks(ctxOf(), { ...q, include_archived: true });
      expect(all.data.map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
      const restored = await updateLink(ctxOf(), a.id, { archived: false });
      expect(restored).toMatchObject({ archived: false, availability: 'available' });
      expect((await listLinks(ctxOf(), q)).data).toHaveLength(2);
      await archiveLink(ctxOf(), a.id);
      await expect(archiveLink(ctxOf(), a.id)).resolves.toMatchObject({ archived: true });
    });

    it('pages newest first and filters by status', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await createLink(ctxOf(), fixedUsd)).id);
      await updateLink(ctxOf(), ids[0]!, { status: 'inactive' });
      const p1 = await listLinks(ctxOf(), { limit: 2 });
      expect(p1.has_more).toBe(true);
      expect(p1.data.map((l) => l.id)).toEqual([ids[2], ids[1]]);
      const p2 = await listLinks(ctxOf(), { limit: 2, starting_after: ids[1] });
      expect(p2.has_more).toBe(false);
      expect(p2.data.map((l) => l.id)).toEqual([ids[0]]);
      const inactive = await listLinks(ctxOf(), { limit: 10, status: 'inactive' });
      expect(inactive.data.map((l) => l.id)).toEqual([ids[0]]);
      const active = await listLinks(ctxOf(), { limit: 10, status: 'active' });
      expect(active.data).toHaveLength(2);
    });

    it("another merchant's link is NOT_FOUND", async () => {
      const other = await createMerchant({ slug: 'other' });
      const theirs = await createLink(ctxOf(false, other.id), fixedUsd);
      for (const run of [
        () => getLink(ctxOf(), theirs.id),
        () => updateLink(ctxOf(), theirs.id, { title: 'x' }),
        () => archiveLink(ctxOf(), theirs.id),
      ]) {
        expect((await rejection(run())).code).toBe('NOT_FOUND');
      }
      expect((await listLinks(ctxOf(), { limit: 10 })).data).toHaveLength(0);
      // The same id in the other mode is not visible either.
      expect((await rejection(getLink(ctxOf(true, other.id), theirs.id))).code).toBe('NOT_FOUND');
    });
  });

  describe('totals', () => {
    /** A link session, with a payment that settled (or not). */
    async function paid(
      linkId: string,
      s: { amount: string; originalAmount?: string; originalCurrency?: string; settled: boolean },
    ) {
      const session = await createRow('Session', merchant.id, false, {
        paymentLinkId: linkId,
        amount: s.amount,
        ...(s.originalAmount
          ? {
              originalAmount: s.originalAmount,
              originalCurrency: s.originalCurrency,
              fxRate: '1600',
              fxSource: 'fixed',
              fxAsOf: new Date(),
            }
          : {}),
        status: s.settled ? 'SETTLED' : 'PENDING_DEPOSIT',
      });
      const quote = await createRow('Quote', merchant.id, false, { sessionId: session.id });
      return createRow('Payment', merchant.id, false, {
        sessionId: session.id,
        quoteId: quote.id,
        amountOut: '20000000',
        settledAt: s.settled ? new Date() : null,
        status: s.settled ? 'SETTLED' : 'DETECTED',
      });
    }
    let refundN = 0;
    const refund = (paymentId: string, amount: string, over: Record<string, unknown> = {}) => {
      const merchantRefund = (over.reason ?? 'merchant') === 'merchant';
      return createRow('Refund', merchant.id, false, {
        paymentId,
        reason: 'merchant',
        status: 'confirmed',
        amount,
        ...(merchantRefund ? { externalRef: `r${++refundN}`, requestedAmountUsd: '1.00' } : {}),
        ...over,
      });
    };

    it('sums settled payments and executed merchant refunds in USD', async () => {
      const link = await createLink(ctxOf(), fixedUsd);
      const first = await paid(link.id, { amount: '10.00', settled: true });
      await paid(link.id, { amount: '5.50', settled: true });
      await paid(link.id, { amount: '99.00', settled: false });
      // Half of the first payment came back. A cancelled and a non-merchant refund do not count.
      await refund(first.id, '10000000');
      await refund(first.id, '5000000', { status: 'failed', reviewReason: 'store_cancelled' });
      await refund(first.id, '5000000', { reason: 'expired' });
      const v = await getLink(ctxOf(), link.id);
      expect(v).toMatchObject({
        total_paid: '15.50',
        total_paid_usd: '15.50',
        total_refunded: '5.00',
        total_refunded_usd: '5.00',
      });
      const listed = (await listLinks(ctxOf(), { limit: 5 })).data[0];
      expect(listed).toMatchObject({ total_paid_usd: '15.50' });
    });

    it('NGN totals are in naira and in USD', async () => {
      const link = await createLink(ctxOf(), { ...fixedNgn, amount: '50000' });
      const first = await paid(link.id, {
        amount: '31.25',
        originalAmount: '50000',
        originalCurrency: 'NGN',
        settled: true,
      });
      await paid(link.id, {
        amount: '15.63',
        originalAmount: '25000',
        originalCurrency: 'NGN',
        settled: true,
      });
      await refund(first.id, '10000000');
      const v = await getLink(ctxOf(), link.id);
      expect(v).toMatchObject({
        currency: 'NGN',
        total_paid: '75000.00',
        total_paid_usd: '46.88',
        total_refunded: '25000.00',
        total_refunded_usd: '15.63',
      });
    });

    it("ignores other links' sessions", async () => {
      const a = await createLink(ctxOf(), fixedUsd);
      const b = await createLink(ctxOf(), fixedUsd);
      await paid(a.id, { amount: '10.00', settled: true });
      expect((await getLink(ctxOf(), b.id)).total_paid_usd).toBe('0.00');
    });
  });

  describe('linkUrls', () => {
    it('builds live and test URLs', () => {
      expect(linkUrls('acme', 'give', true)).toEqual({
        url: 'http://localhost:3000/pay/acme/give',
        qr_url: 'http://localhost:3000/pay/acme/give/qr',
      });
      expect(linkUrls('acme', 'give', false)).toEqual({
        url: 'http://localhost:3000/pay/acme/give?mode=test',
        qr_url: 'http://localhost:3000/pay/acme/give/qr?mode=test',
      });
    });
  });
});
