// Throttled operator notices (project 5a, Task 12): the same channel as the loss-cap alert
// (loss-cap.ts): an internal system event (no merchant, never a webhook) plus an `OPS ALERT` log
// line, at most once per `everyMs` per key. The throttle is a row per key in `gas_ops_alerts`,
// claimed atomically, so concurrent workers send one notice.
import { recordEvent } from '../events/record.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

/** Operator notices about one account repeat at most every 6 hours. */
export const OPS_NOTICE_EVERY_MS = 6 * 60 * 60_000;

/**
 * Sends the notice `type` for `key` unless one was sent within `everyMs` before `now`. Returns
 * whether it was sent.
 */
export async function opsNotice(input: {
  type: string;
  key: string;
  payload: Record<string, unknown>;
  now: Date;
  everyMs?: number;
}): Promise<boolean> {
  const { type, key, payload, now } = input;
  const cutoff = new Date(now.getTime() - (input.everyMs ?? OPS_NOTICE_EVERY_MS));
  const sent = await prisma.$transaction(async (tx) => {
    // INSERT … ON CONFLICT DO NOTHING: a first notice for the key, or nothing.
    const created = await tx.gasOpsAlert.createMany({
      data: [{ key, lastNotifiedAt: now }],
      skipDuplicates: true,
    });
    let claimed = created.count === 1;
    if (!claimed) {
      const { count } = await tx.gasOpsAlert.updateMany({
        where: { key, lastNotifiedAt: { lte: cutoff } },
        data: { lastNotifiedAt: now },
      });
      claimed = count === 1;
    }
    if (!claimed) return false;
    await recordEvent(tx, null, {
      aggregateType: 'gas_ops',
      aggregateId: key,
      type,
      payload: { ...payload, at: now.toISOString() },
    });
    return true;
  });
  if (sent) log('warn', `OPS ALERT: ${type}`, { key, ...payload });
  return sent;
}
