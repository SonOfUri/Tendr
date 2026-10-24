import { deriveRefundStatus } from '@tendr/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
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

  it('concurrent transitions: exactly one wins', async () => {
    const m = await createMerchant();
    const s = await createRow('Session', m.id, false);
    // Both transactions read PENDING_DEPOSIT before either writes; the barrier forces the race.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const racer = (to: 'PROCESSING' | 'EXPIRED') =>
      prisma.$transaction(async (tx) => {
        await tx.session.findUniqueOrThrow({ where: { id: s.id } });
        if (++arrived === 2) release();
        await gate;
        await transitionSession(tx, s.id, to);
      });
    const results = await Promise.allSettled([racer('PROCESSING'), racer('EXPIRED')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409 });
    expect(['CONFLICT', 'INVALID_STATE_TRANSITION']).toContain(failed.reason.code);
    expect((await counts(s.id)).events).toBe(1);
  });
});

describe('spec scenarios', () => {
  it('quote expiry leaves session PENDING_DEPOSIT', async () => {
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
