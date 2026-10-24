import { Prisma } from '@prisma/client';
import type { ScopeContext } from '../db/scoped.js';
import { newId } from '../lib/ids.js';
import { toJsonDecimal } from '../lib/serialize.js';

type Tx = Prisma.TransactionClient;

/** Rejects the root PrismaClient: event + state change must share one transaction. */
export function assertTransaction(tx: Tx): void {
  if ('$transaction' in tx) {
    throw new Error(
      'recordEvent/transition functions require a transaction client, not the root client',
    );
  }
}

/** Deeply converts Prisma.Decimal values to plain decimal strings so the payload is JSON-safe. */
function normalisePayload(v: unknown): unknown {
  if (Prisma.Decimal.isDecimal(v)) return toJsonDecimal(v as Prisma.Decimal);
  if (Array.isArray(v)) return v.map(normalisePayload);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalisePayload(x)]));
  }
  return v;
}

export interface RecordEventInput {
  aggregateType: 'session' | 'payment' | (string & {});
  aggregateId: string;
  type: string;
  payload: object;
}

/**
 * Appends an event and its outbox row. Must run inside the caller's transaction (for merchant
 * events: `tenantTransaction` with the same `ctx`) so the event exists if and only if the state
 * change it describes committed; the worker drains `event_outbox` to fan events out.
 * A merchant event takes its merchant and mode from `ctx`; `ctx` is null only for system events
 * (no merchant), which no scoped client can read.
 */
export async function recordEvent(
  tx: Tx,
  ctx: ScopeContext | null,
  e: RecordEventInput,
): Promise<string> {
  assertTransaction(tx);
  const id = newId('evt');
  await tx.event.create({
    data: {
      id,
      merchantId: ctx?.merchantId ?? null,
      livemode: ctx?.livemode ?? null,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      type: e.type,
      payload: normalisePayload(e.payload) as Prisma.InputJsonValue,
    },
  });
  await tx.eventOutbox.create({ data: { id: newId('obx'), eventId: id } });
  return id;
}
