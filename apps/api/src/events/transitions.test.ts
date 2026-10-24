import { Prisma } from '@prisma/client';
import { deriveRefundStatus } from '@tendr/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import { recordEvent } from './record.js';
import { transitionPayment, transitionSession } from './transitions.js';

beforeEach(resetDb);

const counts = async (aggregateId: string) => ({
  events: await prisma.event.count({ where: { aggregateId } }),
  outbox: await prisma.eventOutbox.count({ where: { event: { aggregateId } } }),
});

describe('transitionSession', () => {
  it('legal transition updates status and writes event + outbox in one tx', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    await prisma.$transaction((tx) =>
      transitionSession(tx, s.id, 'PROCESSING', { paymentId: 'pay_x' }),
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
      prisma.$transaction((tx) => transitionSession(tx, s.id, 'SETTLED')),
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
      prisma.$transaction((tx) => transitionSession(tx, s.id, 'REFUNDED')),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(await counts(s.id)).toEqual({ events: 0, outbox: 0 });
  });

  it('rolled-back tx leaves no event or outbox row', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    await expect(
      prisma.$transaction(async (tx) => {
        await transitionSession(tx, s.id, 'PROCESSING');
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
                if (op !== 'findUnique') return Reflect.get(sess, op);
                return async (...args: Parameters<typeof sess.findUnique>) => {
                  const row = await sess.findUnique(...args);
                  await prisma.session.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
                  return row;
                };
              },
            });
          },
        });
        await transitionSession(racing, s.id, 'PROCESSING');
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
      transitionSession(tx, s.id, 'PROCESSING', { from: 'X', to: 'Y', extra: 1 }),
    );
    const ev = await prisma.event.findFirstOrThrow({ where: { aggregateId: s.id } });
    expect(ev.payload).toEqual({ from: 'PENDING_DEPOSIT', to: 'PROCESSING', extra: 1 });
  });

  it('rejects the root client (state change and event must share a transaction)', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    const p = await createRow('Payment', m.id, false);
    await expect(transitionSession(prisma, s.id, 'PROCESSING')).rejects.toThrow(
      /transaction client/,
    );
    await expect(transitionPayment(prisma, p.id, 'PROCESSING')).rejects.toThrow(
      /transaction client/,
    );
    await expect(
      recordEvent(prisma, {
        merchantId: m.id,
        livemode: false,
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

describe('recordEvent payload', () => {
  it('normalises Decimals (deeply) to plain strings', async () => {
    const m = await createMerchant();
    const id = await prisma.$transaction((tx) =>
      recordEvent(tx, {
        merchantId: m.id,
        livemode: true,
        aggregateType: 'payment',
        aggregateId: newId('pay'),
        type: 'payment.test',
        payload: {
          big: new Prisma.Decimal('1e30'),
          nested: { small: new Prisma.Decimal('1e-18') },
          list: [new Prisma.Decimal('1e30')],
        },
      }),
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
    await prisma.$transaction((tx) => transitionPayment(tx, late.id, 'REFUNDING'));
    await prisma.$transaction((tx) => transitionPayment(tx, late.id, 'REFUNDED'));

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
