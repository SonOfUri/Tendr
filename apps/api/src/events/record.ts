import type { Prisma } from '@prisma/client';
import { newId } from '../lib/ids.js';

type Tx = Prisma.TransactionClient;

export interface RecordEventInput {
  merchantId: string | null;
  livemode: boolean | null;
  aggregateType: 'session' | 'payment' | (string & {});
  aggregateId: string;
  type: string;
  payload: object;
}

/**
 * Appends an event and its outbox row. Must run inside the caller's transaction so the
 * event exists if and only if the state change it describes committed; the worker drains
 * `event_outbox` to fan events out.
 */
export async function recordEvent(tx: Tx, e: RecordEventInput): Promise<string> {
  const id = newId('evt');
  await tx.event.create({
    data: {
      id,
      merchantId: e.merchantId,
      livemode: e.livemode,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      type: e.type,
      payload: e.payload as Prisma.InputJsonValue,
    },
  });
  await tx.eventOutbox.create({ data: { id: newId('evt'), eventId: id } });
  return id;
}
