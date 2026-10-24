import type { Prisma } from '@prisma/client';
import {
  canTransitionPayment,
  canTransitionSession,
  type PaymentStatus,
  type SessionStatus,
} from '@tendr/contracts';
import { conflict, invalidState, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { assertTransaction, recordEvent } from './record.js';

type Tx = Prisma.TransactionClient;

/**
 * Moves a session to `to` inside the caller's transaction. Illegal moves throw
 * INVALID_STATE_TRANSITION; a lost race (status changed since the read) throws CONFLICT.
 * Writes `session.status_changed` plus its outbox row in the same transaction.
 * `from`/`to` in the event payload cannot be overridden by `payload`.
 */
export async function transitionSession(
  tx: Tx,
  sessionId: string,
  to: SessionStatus,
  payload: object = {},
): Promise<void> {
  assertTransaction(tx);
  const row = await tx.session.findUnique({
    where: { id: sessionId },
    select: { status: true, merchantId: true, livemode: true },
  });
  if (!row) throw notFound('Session not found');
  const from: SessionStatus = row.status;
  if (!canTransitionSession(from, to)) {
    log('warn', 'illegal session transition', { sessionId, from, to });
    throw invalidState(`Cannot transition session from ${from} to ${to}`);
  }
  const { count } = await tx.session.updateMany({
    where: { id: sessionId, status: from },
    data: { status: to },
  });
  if (count === 0) throw conflict('concurrent transition');
  await recordEvent(tx, {
    merchantId: row.merchantId,
    livemode: row.livemode,
    aggregateType: 'session',
    aggregateId: sessionId,
    type: 'session.status_changed',
    payload: { ...payload, from, to },
  });
}

/**
 * Moves a payment to `to` inside the caller's transaction. Illegal moves throw
 * INVALID_STATE_TRANSITION; a lost race (status changed since the read) throws CONFLICT.
 * Writes `payment.status_changed` plus its outbox row in the same transaction.
 * `from`/`to` in the event payload cannot be overridden by `payload`.
 */
export async function transitionPayment(
  tx: Tx,
  paymentId: string,
  to: PaymentStatus,
  payload: object = {},
): Promise<void> {
  assertTransaction(tx);
  const row = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { status: true, merchantId: true, livemode: true },
  });
  if (!row) throw notFound('Payment not found');
  const from: PaymentStatus = row.status;
  if (!canTransitionPayment(from, to)) {
    log('warn', 'illegal payment transition', { paymentId, from, to });
    throw invalidState(`Cannot transition payment from ${from} to ${to}`);
  }
  const { count } = await tx.payment.updateMany({
    where: { id: paymentId, status: from },
    data: { status: to },
  });
  if (count === 0) throw conflict('concurrent transition');
  await recordEvent(tx, {
    merchantId: row.merchantId,
    livemode: row.livemode,
    aggregateType: 'payment',
    aggregateId: paymentId,
    type: 'payment.status_changed',
    payload: { ...payload, from, to },
  });
}
