import { Prisma } from '@prisma/client';
import { deriveRefundStatus } from '@tendr/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import { recordEvent } from './record.js';
import { transitionPayment, transitionSession } from './transitions.js';

beforeEach(resetDb);

/** The test-mode tenant context of merchant `m`. */
const testMode = (m: { id: string }) => ({ merchantId: m.id, livemode: false });

const counts = async (aggregateId: string) => ({
  events: await prisma.event.count({ where: { aggregateId } }),
  outbox: await prisma.eventOutbox.count({ where: { event: { aggregateId } } }),
});

describe('transitionSession', () => {
  it('legal transition updates status and writes event + outbox in one tx', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    await prisma.$transaction((tx) =>
      transitionSession(tx, testMode(m), s.id, 'PROCESSING', { paymentId: 'pay_x' }),
    );
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PROCESSING',
    );
    const ev = await prisma.event.findFirstOrThrow({ where: { aggregateId: s.id } });
    expect(ev).toMatchObject({
      merchantId: m.id,
      livemode: false,
      aggregateType: 'session',
      type: 'session.status_changed',
      payload: { from: 'PENDING_DEPOSIT', to: 'PROCESSING', paymentId: 'pay_x' },
    });
    expect(await prisma.eventOutbox.count({ where: { eventId: ev.id } })).toBe(1);
  });

  it('illegal transition throws INVALID_STATE_TRANSITION and writes nothing', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    await expect(
      prisma.$transaction((tx) => transitionSession(tx, testMode(m), s.id, 'SETTLED')),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', status: 409 });
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PENDING_DEPOSIT',
    );
  });

  it('terminal session cannot be transitioned (SETTLED → REFUNDED)', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false, { status: 'SETTLED' });
    await expect(
      prisma.$transaction((tx) => transitionSession(tx, testMode(m), s.id, 'REFUNDED')),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
  });

  it('rolled-back tx leaves no event or outbox row', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    await expect(
      prisma.$transaction(async (tx) => {
        await transitionSession(tx, testMode(m), s.id, 'PROCESSING');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PENDING_DEPOSIT',
    );
  });

  it('concurrent transitions: the loser gets CONFLICT and writes no event', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    // Deterministic race: right after the transition's own read of the status, a competing
    // transaction commits PENDING_DEPOSIT → EXPIRED, so the guarded updateMany matches 0 rows.
    await expect(
      prisma.$transaction(async (tx) => {
        const racing = new Proxy(tx, {
          get(target, prop) {
            if (prop !== 'session') return Reflect.get(target, prop);
            return new Proxy(target.session, {
              get(sess, op) {
                if (op !== 'findFirst') return Reflect.get(sess, op);
                return async (...args: Parameters<typeof sess.findFirst>) => {
                  const row = await sess.findFirst(...args);
                  await prisma.session.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
                  return row;
                };
              },
            });
          },
        });
        await transitionSession(racing, testMode(m), s.id, 'PROCESSING');
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'EXPIRED',
    );
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
  });

  it('payload cannot overwrite from/to', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    await prisma.$transaction((tx) =>
      transitionSession(tx, testMode(m), s.id, 'PROCESSING', { from: 'X', to: 'Y', extra: 1 }),
    );
    const ev = await prisma.event.findFirstOrThrow({ where: { aggregateId: s.id } });
    expect(ev.payload).toEqual({ from: 'PENDING_DEPOSIT', to: 'PROCESSING', extra: 1 });
  });

  it('rejects the root client (state change and event must share a transaction)', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    const p = await createRow('Payment', m.id, false);
    await expect(transitionSession(prisma, testMode(m), s.id, 'PROCESSING')).rejects.toThrow(
      /transaction client/,
    );
    await expect(transitionPayment(prisma, testMode(m), p.id, 'PROCESSING')).rejects.toThrow(
      /transaction client/,
    );
    await expect(
      recordEvent(prisma, testMode(m), {
        aggregateType: 'session',
        aggregateId: s.id,
        type: 'x',
        payload: {},
      }),
    ).rejects.toThrow(/transaction client/);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PENDING_DEPOSIT',
    );
  });
});

describe('tenant isolation (tenantTransaction)', () => {
  it('transitions within the context’s merchant and mode', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    const p = await createRow('Payment', m.id, false);
    await tenantTransaction(testMode(m), async (tx, ctx) => {
      await transitionSession(tx, ctx, s.id, 'PROCESSING');
      await transitionPayment(tx, ctx, p.id, 'PROCESSING');
    });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PROCESSING',
    );
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'PROCESSING',
    );
    expect(await counts(s.id)).toEqual({ events: 1, outbox: 1 });
  });

  it.each([
    ['another merchant', false],
    ['the other mode', true],
  ])('a session of %s is NOT_FOUND and unchanged', async (label, livemode) => {
    const owner = await createMerchant();
    const attacker = await createMerchant();
    const s = await createRow('Session', owner.id, false);
    const ctx = { merchantId: label === 'another merchant' ? attacker.id : owner.id, livemode };
    await expect(
      tenantTransaction(ctx, (tx) => transitionSession(tx, ctx, s.id, 'PROCESSING')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PENDING_DEPOSIT',
    );
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
  });

  it.each([
    ['another merchant', false],
    ['the other mode', true],
  ])('a payment of %s is NOT_FOUND and unchanged', async (label, livemode) => {
    const owner = await createMerchant();
    const attacker = await createMerchant();
    const p = await createRow('Payment', owner.id, false);
    const ctx = { merchantId: label === 'another merchant' ? attacker.id : owner.id, livemode };
    await expect(
      tenantTransaction(ctx, (tx) => transitionPayment(tx, ctx, p.id, 'PROCESSING')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'DETECTED',
    );
    expect(await counts(p.id)).toEqual({ events: 0, outbox: 0 });
  });

  it('recordEvent stamps the context’s merchant and mode; null ctx is a system event', async () => {
    const m = await createMerchant();
    const ctx = { merchantId: m.id, livemode: true };
    const [merchantEvent, systemEvent] = await tenantTransaction(ctx, async (tx) => [
      await recordEvent(tx, ctx, {
        aggregateType: 'session',
        aggregateId: newId('ses'),
        type: 'session.created',
        payload: {},
      }),
      await recordEvent(tx, null, {
        aggregateType: 'system',
        aggregateId: 'sys',
        type: 'system.tick',
        payload: {},
      }),
    ]);
    expect(await prisma.event.findUniqueOrThrow({ where: { id: merchantEvent } })).toMatchObject({
      merchantId: m.id,
      livemode: true,
    });
    expect(await prisma.event.findUniqueOrThrow({ where: { id: systemEvent } })).toMatchObject({
      merchantId: null,
      livemode: null,
    });
  });
});

describe('recordEvent payload', () => {
  it('normalises Decimals (deeply) to plain strings', async () => {
    const m = await createMerchant();
    const id = await prisma.$transaction((tx) =>
      recordEvent(
        tx,
        { merchantId: m.id, livemode: true },
        {
          aggregateType: 'payment',
          aggregateId: newId('pay'),
          type: 'payment.test',
          payload: {
            big: new Prisma.Decimal('1e30'),
            nested: { small: new Prisma.Decimal('1e-18') },
            list: [new Prisma.Decimal('1e30')],
          },
        },
      ),
    );
    const ev = await prisma.event.findUniqueOrThrow({ where: { id } });
    expect(ev.payload).toEqual({
      big: '1000000000000000000000000000000',
      nested: { small: '0.000000000000000001' },
      list: ['1000000000000000000000000000000'],
    });
  });
});

describe('spec scenarios', () => {
  // Spec placeholder: no code path expires quotes yet. The real test arrives with project 2's
  // quote-expiry worker; for now it only documents that quote deadlines never move the session.
  it('spec placeholder: quote expiry leaves session PENDING_DEPOSIT', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    await createRow('Quote', m.id, false, {
      sessionId: s.id,
      deadline: new Date(Date.now() - 60_000),
    });
    // A second, live quote on the same session; nothing moves the session.
    await createRow('Quote', m.id, false, {
      sessionId: s.id,
      deadline: new Date(Date.now() + 60_000),
    });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PENDING_DEPOSIT',
    );
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
  });

  it('late deposit on a SETTLED session is recorded on a new payment, session unchanged', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false, { status: 'SETTLED' });
    const quote = await createRow('Quote', m.id, false, { sessionId: s.id });
    const late = await prisma.payment.create({
      data: {
        id: newId('pay'),
        merchantId: m.id,
        livemode: false,
        sessionId: s.id,
        quoteId: quote.id,
        amountReceived: '1000000',
        isLate: true,
        status: 'DETECTED',
      },
    });
    await prisma.$transaction((tx) => transitionPayment(tx, testMode(m), late.id, 'REFUNDING'));
    await prisma.$transaction((tx) => transitionPayment(tx, testMode(m), late.id, 'REFUNDED'));

    const session = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(session.status).toBe('SETTLED');
    const payments = await prisma.payment.findMany({ where: { sessionId: s.id } });
    expect(
      deriveRefundStatus(
        session.status,
        payments.map((p) => ({ id: p.id, status: p.status, isLate: p.isLate })),
        [{ paymentId: late.id, reason: 'late', createdAt: new Date() }],
      ),
    ).toEqual({ refundStatus: 'none', refundReason: null, lateRefundStatus: 'refunded' });
    expect(await counts(late.id)).toEqual({ events: 2, outbox: 2 });
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
  });
});
