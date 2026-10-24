import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, minimalSession, resetDb } from '../test/helpers.js';
import { INFRA_MODELS, PER_MODE_MODELS, SHARED_MODELS } from './models.js';
import { readOnlyDb, scopedDb } from './scoped.js';

// Dynamic model access (`db[delegate]`) is untyped by design in these tests.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = Record<string, any>;
const lcFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const delegate = (db: unknown, model: string): any => (db as AnyDb)[lcFirst(model)];

const forbidden = { code: 'FORBIDDEN', status: 403 };
const isNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';

describe('scoped data access', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(PER_MODE_MODELS)('%s: test-mode client cannot see live rows', async (model) => {
    const m = await createMerchant();
    const liveRow = await createRow(model, m.id, true);
    const testDb = scopedDb({ merchantId: m.id, livemode: false });
    expect(await delegate(testDb, model).findMany({})).toEqual([]);
    expect(await delegate(testDb, model).findFirst({ where: { id: liveRow.id } })).toBeNull();
    expect(await delegate(testDb, model).findUnique({ where: { id: liveRow.id } })).toBeNull();
    expect(await delegate(testDb, model).count()).toBe(0);

    const liveDb = scopedDb({ merchantId: m.id, livemode: true });
    expect(await delegate(liveDb, model).findUnique({ where: { id: liveRow.id } })).toMatchObject({
      id: liveRow.id,
    });
  });

  it.each([...PER_MODE_MODELS, ...SHARED_MODELS])(
    '%s: another merchant’s rows are invisible',
    async (model) => {
      const a = await createMerchant();
      const b = await createMerchant();
      const rowB = await createRow(model, b.id, true);
      const dbA = scopedDb({ merchantId: a.id, livemode: true });
      expect(await delegate(dbA, model).findMany({})).toEqual([]);
      expect(await delegate(dbA, model).findUnique({ where: { id: rowB.id } })).toBeNull();
    },
  );

  it('shared models are visible from both modes', async () => {
    const m = await createMerchant();
    const theme = await createRow('CheckoutTheme', m.id, true);
    for (const livemode of [true, false]) {
      const db = scopedDb({ merchantId: m.id, livemode });
      expect(await db.checkoutTheme.findUnique({ where: { id: theme.id } })).toMatchObject({
        id: theme.id,
      });
    }
  });

  it('a caller-supplied merchantId or livemode in where cannot widen the scope', async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    await createRow('Session', b.id, true);
    await createRow('Session', a.id, false);
    const dbA = scopedDb({ merchantId: a.id, livemode: true });
    expect(await dbA.session.findMany({ where: { merchantId: b.id } })).toEqual([]);
    expect(await dbA.session.findMany({ where: { livemode: false } })).toEqual([]);
    expect(
      await dbA.session.findMany({ where: { OR: [{ merchantId: b.id }, { livemode: false }] } }),
    ).toEqual([]);
  });

  it('create injects merchantId and livemode', async () => {
    const m = await createMerchant();
    const other = await createMerchant();
    const db = scopedDb({ merchantId: m.id, livemode: true });
    const s = await db.session.create({
      data: minimalSession({ merchantId: other.id, livemode: false }),
    });
    expect(s).toMatchObject({ merchantId: m.id, livemode: true });
  });

  it('createMany and shared-model create inject the tenant', async () => {
    const m = await createMerchant();
    const db = scopedDb({ merchantId: m.id, livemode: false });
    const {
      merchantId: _m,
      livemode: _l,
      ...rest
    } = minimalSession({ merchantId: 'x', livemode: true });
    await db.session.createMany({ data: [{ ...rest } as any] });
    expect(await prisma.session.findMany()).toMatchObject([{ merchantId: m.id, livemode: false }]);

    const plan = await db.feePlan.create({
      data: {
        id: 'fplan_scoped',
        feeBps: 25,
        defaultFeePayer: 'merchant',
        volumeTiers: [],
        effectiveFrom: new Date(),
      } as any,
    });
    expect(plan.merchantId).toBe(m.id);
  });

  it('update by id cannot touch another merchant’s row', async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const rowB = await createRow('Session', b.id, true, { metadata: { owner: 'b' } });
    const dbA = scopedDb({ merchantId: a.id, livemode: true });

    await expect(
      dbA.session.update({ where: { id: rowB.id }, data: { metadata: { owner: 'a' } } }),
    ).rejects.toSatisfy(isNotFound);
    expect(await dbA.session.updateMany({ data: { metadata: { owner: 'a' } } })).toEqual({
      count: 0,
    });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: rowB.id } })).metadata).toEqual({
      owner: 'b',
    });
  });

  it('update by id cannot touch the same merchant’s other-mode row', async () => {
    const m = await createMerchant();
    const live = await createRow('Session', m.id, true, { metadata: { v: 1 } });
    const testDb = scopedDb({ merchantId: m.id, livemode: false });
    await expect(
      testDb.session.update({ where: { id: live.id }, data: { metadata: { v: 2 } } }),
    ).rejects.toSatisfy(isNotFound);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: live.id } })).metadata).toEqual({
      v: 1,
    });
  });

  it('delete by id cannot remove another merchant’s row', async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const rowB = await createRow('PaymentLink', b.id, true);
    const dbA = scopedDb({ merchantId: a.id, livemode: true });

    await expect(dbA.paymentLink.delete({ where: { id: rowB.id } })).rejects.toSatisfy(isNotFound);
    expect(await dbA.paymentLink.deleteMany({})).toEqual({ count: 0 });
    expect(await prisma.paymentLink.findUnique({ where: { id: rowB.id } })).not.toBeNull();
  });

  it('upsert by another merchant’s id never modifies that row', async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const rowB = await createRow('Session', b.id, true, { metadata: { owner: 'b' } });
    const dbA = scopedDb({ merchantId: a.id, livemode: true });

    await expect(
      dbA.session.upsert({
        where: { id: rowB.id },
        create: minimalSession({ id: rowB.id, merchantId: a.id, livemode: true }),
        update: { metadata: { owner: 'a' } },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const after = await prisma.session.findUniqueOrThrow({ where: { id: rowB.id } });
    expect(after).toMatchObject({ merchantId: b.id, metadata: { owner: 'b' } });
  });

  it('upsert creates within the scope', async () => {
    const m = await createMerchant();
    const db = scopedDb({ merchantId: m.id, livemode: false });
    const s = await db.session.upsert({
      where: { id: 'ses_upsert' },
      create: minimalSession({ id: 'ses_upsert', merchantId: 'ignored', livemode: true }),
      update: {},
    });
    expect(s).toMatchObject({ merchantId: m.id, livemode: false });
  });

  it.each(['merchantId', 'livemode', 'merchant'])(
    'update data cannot change the tenant column %s',
    async (field) => {
      const m = await createMerchant();
      const row = await createRow('Session', m.id, true);
      const db = scopedDb({ merchantId: m.id, livemode: true });
      const value =
        field === 'livemode' ? false : field === 'merchant' ? { connect: { id: m.id } } : m.id;
      await expect(
        db.session.update({ where: { id: row.id }, data: { [field]: value } as any }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        db.session.updateMany({ data: { [field]: value } as any }),
      ).rejects.toMatchObject(forbidden);
    },
  );

  it('merchant model is scoped to the principal’s merchant and cannot be created', async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const dbA = scopedDb({ merchantId: a.id, livemode: true });
    expect((await dbA.merchant.findMany({})).map((r) => r.id)).toEqual([a.id]);
    expect(await dbA.merchant.findUnique({ where: { id: b.id } })).toBeNull();
    await expect(
      dbA.merchant.update({ where: { id: b.id }, data: { name: 'pwned' } }),
    ).rejects.toSatisfy(isNotFound);
    await expect(
      dbA.merchant.create({ data: { id: 'mer_new', name: 'x', slug: 'x' } }),
    ).rejects.toMatchObject(forbidden);
    await expect(dbA.merchant.delete({ where: { id: a.id } })).rejects.toMatchObject(forbidden);
  });

  it('relations from a shared or merchant root cannot reach rows of the other mode', async () => {
    const m = await createMerchant();
    const theme = await createRow('CheckoutTheme', m.id, true);
    await createRow('Session', m.id, true, { themeId: theme.id });
    const testDb = scopedDb({ merchantId: m.id, livemode: false }) as AnyDb;
    const attempts: (() => Promise<unknown>)[] = [
      () => testDb.merchant.findMany({ include: { sessions: true } }),
      () => testDb.merchant.findMany({ select: { _count: { select: { sessions: true } } } }),
      () => testDb.checkoutTheme.findMany({ include: { sessions: true } }),
      () => testDb.checkoutTheme.findMany({ where: { sessions: { some: {} } } }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject(forbidden);
  });

  it('per-mode relations stay within the mode (composite FKs)', async () => {
    const m = await createMerchant();
    const payment = await createRow('Payment', m.id, true);
    const liveDb = scopedDb({ merchantId: m.id, livemode: true });
    const s = await liveDb.session.findUniqueOrThrow({
      where: { id: payment.sessionId as string },
      include: { payments: true, theme: true, merchant: true },
    });
    expect(s.payments.map((p) => p.id)).toEqual([payment.id]);
  });

  it('relations cannot reach infra models', async () => {
    const m = await createMerchant();
    const delivery = await createRow('WebhookDelivery', m.id, true);
    const db = scopedDb({ merchantId: m.id, livemode: true }) as AnyDb;
    const attempts: (() => Promise<unknown>)[] = [
      () => db.webhookDelivery.findMany({ include: { event: true } }),
      () => db.webhookEndpoint.findMany({ select: { secret: { select: { ciphertext: true } } } }),
      () => db.webhookEndpoint.findMany({ where: { secret: { kek: 'local' } } }),
      () => db.apiKey.findMany({ include: { signingSecret: true } }),
      () => db.merchant.findMany({ include: { events: true } }),
      () =>
        db.webhookDelivery.update({
          where: { id: delivery.id },
          data: { event: { update: { type: 'x' } } },
        }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject(forbidden);
  });

  it.each(INFRA_MODELS)(
    '%s is not reachable through the scoped or read-only client',
    async (model) => {
      const m = await createMerchant();
      const ctx = { merchantId: m.id, livemode: true };
      await expect(delegate(scopedDb(ctx), model).findMany({})).rejects.toMatchObject(forbidden);
      await expect(delegate(readOnlyDb(ctx), model).findMany({})).rejects.toMatchObject(forbidden);
    },
  );

  it.each(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'])(
    '%s is blocked on scoped and read-only clients',
    async (method) => {
      const m = await createMerchant();
      const ctx = { merchantId: m.id, livemode: true };
      await expect((scopedDb(ctx) as AnyDb)[method]`SELECT 1`).rejects.toMatchObject(forbidden);
      await expect((readOnlyDb(ctx) as AnyDb)[method]`SELECT 1`).rejects.toMatchObject(forbidden);
    },
  );

  it('interactive $transaction on the scoped client stays scoped', async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const rowB = await createRow('Session', b.id, true);
    const dbA = scopedDb({ merchantId: a.id, livemode: true });

    const created = await dbA.$transaction(async (tx) => {
      expect(await tx.session.findUnique({ where: { id: rowB.id } })).toBeNull();
      await expect((tx as AnyDb).$queryRaw`SELECT 1`).rejects.toMatchObject(forbidden);
      return tx.session.create({ data: minimalSession({ merchantId: b.id, livemode: false }) });
    });
    expect(created).toMatchObject({ merchantId: a.id, livemode: true });
  });

  describe('read-only client', () => {
    it('reads within the scope', async () => {
      const a = await createMerchant();
      const b = await createMerchant();
      const own = await createRow('Session', a.id, false);
      await createRow('Session', a.id, true);
      await createRow('Session', b.id, false);
      const ro = readOnlyDb({ merchantId: a.id, livemode: false });
      expect((await ro.session.findMany({})).map((s) => s.id)).toEqual([own.id]);
    });

    it('read-only client rejects writes', async () => {
      const m = await createMerchant();
      const row = await createRow('Session', m.id, true);
      const ro = readOnlyDb({ merchantId: m.id, livemode: true });
      const id = row.id;
      const attempts: (() => Promise<unknown>)[] = [
        () => ro.session.update({ where: { id }, data: { metadata: {} } }),
        () => ro.session.updateMany({ data: { metadata: {} } }),
        () => ro.session.create({ data: minimalSession({ merchantId: m.id, livemode: true }) }),
        () =>
          ro.session.createMany({ data: [minimalSession({ merchantId: m.id, livemode: true })] }),
        () =>
          ro.session.upsert({
            where: { id },
            create: minimalSession({ merchantId: m.id, livemode: true }),
            update: {},
          }),
        () => ro.session.delete({ where: { id } }),
        () => ro.session.deleteMany({}),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({
          ...forbidden,
          message: 'read-only data access',
        });
      }
      expect(await prisma.session.count()).toBe(1);
    });

    it('rejects $transaction', async () => {
      const m = await createMerchant();
      const ro = readOnlyDb({ merchantId: m.id, livemode: true }) as AnyDb;
      await expect(ro.$transaction(async () => 1)).rejects.toMatchObject(forbidden);
      await expect(ro.$transaction([])).rejects.toMatchObject(forbidden);
    });
  });
});
