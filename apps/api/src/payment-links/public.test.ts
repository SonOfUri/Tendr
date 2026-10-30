import { randomBytes } from 'node:crypto';
import type { Merchant } from '@prisma/client';
import type { PaymentLinkCreate } from '@tendr/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFxCache } from '../checkout/fx.js';
import { LINK_UNQUOTED_TTL_MS } from '../checkout/sessions.js';
import { scopedDb } from '../db/scoped.js';
import { loadEnv } from '../env.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { getRedis, whenReady } from '../lib/redis.js';
import { createMerchant, createRow, minimalSession, resetDb } from '../test/helpers.js';
import { archiveLink, createLink, type LinkCtx } from './links.js';
import { LINK_MAX_QUOTED_SESSIONS, createLinkSession, getPublicLink } from './public.js';

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

const IP = '203.0.113.7';

describe('public payment links', () => {
  let merchant: Merchant;
  const ctx = (livemode = false): LinkCtx => ({
    merchantId: merchant.id,
    livemode,
    db: scopedDb({ merchantId: merchant.id, livemode }),
  });
  const rate = (ngn: string) => loadEnv({ ...process.env, FX_FIXED_RATES: `{"NGN":"${ngn}"}` });

  beforeAll(async () => {
    await whenReady(getRedis());
  });
  beforeEach(async () => {
    await resetDb();
    await resetFxCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    rate('1600');
    merchant = await createMerchant({ slug: 'acme', name: 'Acme Church' });
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

  const openNgn: PaymentLinkCreate = {
    title: 'Offering',
    slug: 'offering',
    amount_type: 'open',
    currency: 'NGN',
    note: 'optional',
  };
  const fixedUsd: PaymentLinkCreate = {
    title: 'T-shirt',
    slug: 'tshirt',
    amount_type: 'fixed',
    amount: '5.00',
    currency: 'USD',
    note: 'optional',
  };

  describe('read', () => {
    it('public view hides ids, limits and counts', async () => {
      await createLink(ctx(), { ...openNgn, min_amount: '2000', max_uses: 10 });
      const v = await getPublicLink('acme', 'offering', false);
      expect(Object.keys(v).sort()).toEqual(
        [
          'amount',
          'amount_type',
          'availability',
          'currency',
          'description',
          'fee_payer',
          'livemode',
          'merchant',
          'min_amount',
          'minor_units',
          'note',
          'title',
          'usd_rate',
        ].sort(),
      );
      expect(Object.keys(v.merchant).sort()).toEqual(['logo_url', 'name']);
      // The page formats and checks amounts with the API's ISO 4217 table, never its own.
      expect(v.minor_units).toBe(2);
      expect(v).toMatchObject({
        merchant: { name: 'Acme Church', logo_url: null },
        title: 'Offering',
        description: null,
        amount_type: 'open',
        amount: null,
        currency: 'NGN',
        min_amount: '2000.00',
        usd_rate: '1600',
        note: 'optional',
        fee_payer: 'merchant',
        availability: 'available',
        livemode: false,
      });
      expect(JSON.stringify(v)).not.toContain(merchant.id);
      expect(JSON.stringify(v)).not.toContain('plink_');
    });

    it('unknown merchant and unknown link give the same 404', async () => {
      await createLink(ctx(), fixedUsd);
      const a = await rejection(getPublicLink('nobody', 'tshirt', false));
      const b = await rejection(getPublicLink('acme', 'nothing', false));
      expect(a.code).toBe('NOT_FOUND');
      expect(b.code).toBe('NOT_FOUND');
      expect(a.message).toBe(b.message);
      expect(a.status).toBe(404);
    });

    it('test link needs mode=test', async () => {
      await createLink(ctx(false), fixedUsd);
      expect((await rejection(getPublicLink('acme', 'tshirt', true))).code).toBe('NOT_FOUND');
      expect((await getPublicLink('acme', 'tshirt', false)).livemode).toBe(false);
    });

    it('effective min is the $1 floor in NGN rounded up', async () => {
      rate('1602.045');
      await createLink(ctx(), openNgn);
      const v = await getPublicLink('acme', 'offering', false);
      expect(v.min_amount).toBe('1602.05');
      expect(v.usd_rate).toBe('1602.045');
      // A merchant minimum below the floor never lowers it; one above it wins.
      await createLink(ctx(), { ...openNgn, slug: 'low', min_amount: '100' });
      expect((await getPublicLink('acme', 'low', false)).min_amount).toBe('1602.05');
      await createLink(ctx(), { ...openNgn, slug: 'high', min_amount: '5000' });
      expect((await getPublicLink('acme', 'high', false)).min_amount).toBe('5000.00');
      // USD: the floor itself, no rate.
      await createLink(ctx(), { ...openNgn, slug: 'usd', currency: 'USD' });
      expect(await getPublicLink('acme', 'usd', false)).toMatchObject({
        min_amount: '1.00',
        usd_rate: null,
        minor_units: 2,
      });
      // minor_units is the ISO 4217 table's (RSD 2, where Intl says 0).
      await createLink(ctx(), { ...openNgn, slug: 'rsd', currency: 'RSD' });
      const rsd = await getPublicLink('acme', 'rsd', false);
      expect(rsd.minor_units).toBe(2);
      expect(rsd.min_amount).toMatch(/^\d+\.\d{2}$/);
      // Fixed links have no minimum.
      await createLink(ctx(), fixedUsd);
      expect((await getPublicLink('acme', 'tshirt', false)).min_amount).toBeNull();
    });

    it('archived is reported as inactive; the link fee payer shows', async () => {
      const l = await createLink(ctx(), { ...fixedUsd, fee_payer: 'shopper' });
      expect((await getPublicLink('acme', 'tshirt', false)).fee_payer).toBe('shopper');
      await archiveLink(ctx(), l.id);
      expect((await getPublicLink('acme', 'tshirt', false)).availability).toBe('inactive');
    });
  });

  describe('create', () => {
    const sessionOf = async (url: string) => {
      const id = /\/pay\/(ses_[0-9A-Z]+)#cs=/.exec(url)![1]!;
      return prisma.session.findUniqueOrThrow({ where: { id } });
    };

    it('returns the hosted url with #cs= and the session has no external_ref', async () => {
      const l = await createLink(ctx(), fixedUsd);
      const out = await createLinkSession('acme', 'tshirt', false, {}, IP);
      expect(Object.keys(out)).toEqual(['url', 'expires_at']);
      expect(out.url).toMatch(
        /^http:\/\/localhost:3000\/pay\/ses_[0-9A-Z]{26}#cs=ses_[0-9A-Z]{26}_secret_[0-9a-f]{32}$/,
      );
      const s = await sessionOf(out.url);
      expect(s.externalRef).toBeNull();
      expect(s.paymentLinkId).toBe(l.id);
      expect(s.successUrl).toBe('http://localhost:3000/pay/acme/tshirt?mode=test');
      expect(s.cancelUrl).toBe(s.successUrl);
      expect(s.amount.toFixed()).toBe('5');
      expect(s.connectionId).toBeNull();
      // The page keeps the session to offer "Continue your payment" until it expires.
      expect(out.expires_at).toBe(s.expiresAt.toISOString());
    });

    it('link session starts with a 5-minute expiry', async () => {
      await createLink(ctx(), fixedUsd);
      const before = Date.now();
      const s = await sessionOf((await createLinkSession('acme', 'tshirt', false, {}, IP)).url);
      expect(LINK_UNQUOTED_TTL_MS).toBe(5 * 60_000);
      expect(s.expiresAt.getTime()).toBeGreaterThanOrEqual(before + LINK_UNQUOTED_TTL_MS - 1000);
      expect(s.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + LINK_UNQUOTED_TTL_MS);
    });

    it('fixed link ignores posted amount', async () => {
      await createLink(ctx(), fixedUsd);
      const s = await sessionOf(
        (await createLinkSession('acme', 'tshirt', false, { amount: '1.00' }, IP)).url,
      );
      expect(s.amount.toFixed()).toBe('5');
    });

    it('converts an open NGN amount to USD and keeps the original', async () => {
      await createLink(ctx(), openNgn);
      const s = await sessionOf(
        (await createLinkSession('acme', 'offering', false, { amount: '3200' }, IP)).url,
      );
      expect(s.amount.toFixed()).toBe('2');
      expect(s.originalAmount?.toFixed()).toBe('3200');
      expect(s.originalCurrency).toBe('NGN');
    });

    it('rejects amounts with excess precision or separators', async () => {
      await createLink(ctx(), openNgn);
      for (const amount of ['1000.555', '5,000', '1 000', '-5', '', undefined]) {
        const err = await rejection(
          createLinkSession('acme', 'offering', false, amount === undefined ? {} : { amount }, IP),
        );
        expect(err.code, String(amount)).toBe('VALIDATION_ERROR');
        expect(err.status).toBe(400);
      }
      expect(await prisma.session.count()).toBe(0);
    });

    it('AMOUNT_TOO_LOW below min', async () => {
      await createLink(ctx(), { ...openNgn, min_amount: '2000' });
      const err = await rejection(
        createLinkSession('acme', 'offering', false, { amount: '1999.99' }, IP),
      );
      expect(err).toMatchObject({ code: 'AMOUNT_TOO_LOW', status: 400 });
      expect(err.details).toMatchObject({ min_amount: '2000.00' });
      // Below the $1 floor (1600 NGN) with no merchant minimum.
      await createLink(ctx(), { ...openNgn, slug: 'free' });
      const floor = await rejection(
        createLinkSession('acme', 'free', false, { amount: '1599' }, IP),
      );
      expect(floor.code).toBe('AMOUNT_TOO_LOW');
      expect(floor.details).toMatchObject({ min_amount: '1600.00' });
      expect(await createLinkSession('acme', 'free', false, { amount: '1600' }, IP)).toHaveProperty(
        'url',
      );
    });

    it('cleans the note', async () => {
      await createLink(ctx(), fixedUsd);
      const s = await sessionOf(
        (
          await createLinkSession(
            'acme',
            'tshirt',
            false,
            { note: '  thanks\u0007 for\n\n the  <b>shirt</b> ' },
            IP,
          )
        ).url,
      );
      expect(s.payerNote).toBe('thanks for the <b>shirt</b>');
      const long = await sessionOf(
        (await createLinkSession('acme', 'tshirt', false, { note: 'x'.repeat(400) }, IP)).url,
      );
      expect(long.payerNote).toHaveLength(280);
    });

    it('records session.created with the link id and note, null external_ref', async () => {
      const l = await createLink(ctx(), fixedUsd);
      const s = await sessionOf(
        (await createLinkSession('acme', 'tshirt', false, { note: 'for Sam' }, IP)).url,
      );
      const ev = await prisma.event.findFirstOrThrow({
        where: { type: 'session.created', aggregateId: s.id },
      });
      expect(ev.payload).toEqual({
        session_id: s.id,
        external_ref: null,
        payment_link_id: l.id,
        payer_note: 'for Sam',
      });
    });

    it('drops the note when the link has note off', async () => {
      await createLink(ctx(), { ...fixedUsd, note: 'off' });
      const s = await sessionOf(
        (await createLinkSession('acme', 'tshirt', false, { note: 'hello' }, IP)).url,
      );
      expect(s.payerNote).toBeNull();
    });

    it('re-checks availability at press time', async () => {
      const l = await createLink(ctx(), fixedUsd);
      expect((await getPublicLink('acme', 'tshirt', false)).availability).toBe('available');
      await archiveLink(ctx(), l.id);
      const err = await rejection(createLinkSession('acme', 'tshirt', false, {}, IP));
      expect(err).toMatchObject({ code: 'LINK_UNAVAILABLE', status: 409 });
      expect(err.details).toEqual({ availability: 'inactive' });
      expect(await prisma.session.count()).toBe(0);
    });

    it('merchant_not_ready is LINK_UNAVAILABLE', async () => {
      await createLink(ctx(), fixedUsd);
      await prisma.settlementConfig.deleteMany({
        where: { merchantId: merchant.id, livemode: false },
      });
      const err = await rejection(createLinkSession('acme', 'tshirt', false, {}, IP));
      expect(err.code).toBe('LINK_UNAVAILABLE');
      expect(err.details).toEqual({ availability: 'merchant_not_ready' });
    });

    it('fixed link below the floor at press time', async () => {
      // 2000 NGN is $1.25 at creation …
      await createLink(ctx(), { ...fixedUsd, currency: 'NGN', amount: '2000' });
      // … and $0.80 when the payer presses Pay.
      rate('2500');
      await resetFxCache();
      const err = await rejection(createLinkSession('acme', 'tshirt', false, {}, IP));
      expect(err.code).toBe('AMOUNT_TOO_LOW');
      expect(err.details).toMatchObject({ min_amount: '2500.00' });
    });

    it('an unknown or suspended merchant is the same 404', async () => {
      await createLink(ctx(), fixedUsd);
      const unknown = await rejection(createLinkSession('nobody', 'tshirt', false, {}, IP));
      await prisma.merchant.update({ where: { id: merchant.id }, data: { status: 'suspended' } });
      const suspended = await rejection(createLinkSession('acme', 'tshirt', false, {}, IP));
      expect(unknown.code).toBe('NOT_FOUND');
      expect(suspended.message).toBe(unknown.message);
    });
  });

  describe('reservation', () => {
    it('concurrent pay on max_uses 1 creates one session', async () => {
      await createLink(ctx(), { ...fixedUsd, max_uses: 1 });
      const results = await Promise.allSettled([
        createLinkSession('acme', 'tshirt', false, {}, IP),
        createLinkSession('acme', 'tshirt', false, {}, IP),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.reason).toMatchObject({
        code: 'LINK_RESERVED',
        status: 409,
        message: 'Someone is paying this link right now, try again shortly.',
      });
      expect(await prisma.session.count()).toBe(1);
    });

    it('reservation freed when the session expires', async () => {
      await createLink(ctx(), { ...fixedUsd, max_uses: 1 });
      await createLinkSession('acme', 'tshirt', false, {}, IP);
      expect((await rejection(createLinkSession('acme', 'tshirt', false, {}, IP))).code).toBe(
        'LINK_RESERVED',
      );
      // The session's lifetime passes (the sweeper has not run yet).
      await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await createLinkSession('acme', 'tshirt', false, {}, IP)).toHaveProperty('url');
    });

    it.each(['PROCESSING', 'SCREENING_PENDING'] as const)(
      'a %s session holds its use past its expiry',
      async (status) => {
        await createLink(ctx(), { ...fixedUsd, max_uses: 1 });
        await createLinkSession('acme', 'tshirt', false, {}, IP);
        // The deposit arrived just before the expiry; the payment is still being processed.
        await prisma.session.updateMany({
          data: { status, expiresAt: new Date(Date.now() - 60_000) },
        });
        const err = await rejection(createLinkSession('acme', 'tshirt', false, {}, IP));
        expect(err.code).toBe('LINK_RESERVED');
        expect(await prisma.session.count()).toBe(1);
      },
    );

    it('all uses settled → LINK_UNAVAILABLE used_up', async () => {
      const l = await createLink(ctx(), { ...fixedUsd, max_uses: 2 });
      await prisma.paymentLink.update({ where: { id: l.id }, data: { useCount: 2 } });
      const err = await rejection(createLinkSession('acme', 'tshirt', false, {}, IP));
      expect(err.code).toBe('LINK_UNAVAILABLE');
      expect(err.details).toEqual({ availability: 'used_up' });
    });

    it('one settled use plus one open session reserves the last use', async () => {
      const l = await createLink(ctx(), { ...fixedUsd, max_uses: 2 });
      await prisma.paymentLink.update({ where: { id: l.id }, data: { useCount: 1 } });
      await createLinkSession('acme', 'tshirt', false, {}, IP);
      expect((await rejection(createLinkSession('acme', 'tshirt', false, {}, IP))).code).toBe(
        'LINK_RESERVED',
      );
    });
  });

  describe('busy ceiling', () => {
    async function openSessions(linkId: string, n: number, quoted: boolean) {
      const rows = Array.from({ length: n }, () =>
        minimalSession({ merchantId: merchant.id, livemode: false, paymentLinkId: linkId }),
      );
      await prisma.session.createMany({ data: rows });
      if (!quoted) return;
      await prisma.quote.createMany({
        data: rows.map((s) => ({
          id: newId('quo'),
          merchantId: merchant.id,
          livemode: false,
          sessionId: s.id,
          originAssetId: 'nep141:eth.test',
          depositAddress: `dep-${randomBytes(12).toString('hex')}`,
          amountIn: '1000000',
          amountOut: '1000000',
          refundTo: 'buyer.testnet',
          deadline: new Date(Date.now() + 30 * 60_000),
        })),
      });
    }

    it('unquoted sessions do not count toward LINK_BUSY', async () => {
      const l = await createLink(ctx(), fixedUsd);
      expect(LINK_MAX_QUOTED_SESSIONS).toBe(200);
      await openSessions(l.id, 200, false);
      expect(await createLinkSession('acme', 'tshirt', false, {}, IP)).toHaveProperty('url');
    });

    it('LINK_BUSY at 200 quoted open sessions', async () => {
      const l = await createLink(ctx(), fixedUsd);
      await openSessions(l.id, 199, true);
      expect(await createLinkSession('acme', 'tshirt', false, {}, IP)).toHaveProperty('url');
      await openSessions(l.id, 1, true);
      const err = await rejection(createLinkSession('acme', 'tshirt', false, {}, IP));
      expect(err).toMatchObject({ code: 'LINK_BUSY', status: 429 });
    });
  });
});
