// The one "is a deposit in flight?" test every expiry path uses (I-1): the watcher's sweeper
// (`expireSessions`), `createSession` expiring a stale session that still holds the same
// `external_ref`, and the store's `/expire`. A session with a deposit in flight is never expired:
// expiring it would turn an on-time payment late and invite the shopper to pay again.
import type { Prisma } from '@prisma/client';
import type { prisma } from '../lib/prisma.js';

/** How long after a quote's deadline a reported or superseded deposit is still tracked. */
export const SUPERSEDED_GRACE_MS = 30 * 60_000;

/** Payment statuses that mean the money is still on its way. */
export const IN_FLIGHT_PAYMENT_STATUSES = ['DETECTED', 'PROCESSING', 'SCREENING_PENDING'] as const;

type Db = Prisma.TransactionClient | typeof prisma;

/** Why a session's deposit is in flight, or null when nothing is. */
export type InFlightReason = 'unpolled' | 'payment' | 'reported';

/**
 * Whether `session` has a deposit in flight at `now`:
 * - `unpolled`: the session is past `expires_at` and a watched address was not polled after it
 *   (a deposit made in time may not be attributed yet);
 * - `payment`: a payment is DETECTED / PROCESSING / SCREENING_PENDING;
 * - `reported`: the shopper reported a deposit tx that 1Click has not shown yet (no payment row)
 *   and its quote deadline plus SUPERSEDED_GRACE_MS has not passed.
 *
 * Read only: the sweeper polls a due address itself first; the API paths, which never poll,
 * refuse instead.
 */
export async function depositInFlight(
  db: Db,
  session: { id: string; merchantId: string; livemode: boolean; expiresAt: Date },
  now: Date,
): Promise<InFlightReason | null> {
  const tenant = { merchantId: session.merchantId, livemode: session.livemode };
  if (session.expiresAt <= now) {
    const unpolled = await db.quote.count({
      where: {
        ...tenant,
        sessionId: session.id,
        watchStoppedAt: null,
        OR: [{ watchPolledAt: null }, { watchPolledAt: { lt: session.expiresAt } }],
      },
    });
    if (unpolled > 0) return 'unpolled';
  }
  const payments = await db.payment.count({
    where: { ...tenant, sessionId: session.id, status: { in: [...IN_FLIGHT_PAYMENT_STATUSES] } },
  });
  if (payments > 0) return 'payment';
  const reported = await db.quote.count({
    where: {
      ...tenant,
      sessionId: session.id,
      depositTxSubmittedAt: { not: null },
      deadline: { gt: new Date(now.getTime() - SUPERSEDED_GRACE_MS) },
      payments: { none: {} },
    },
  });
  return reported > 0 ? 'reported' : null;
}
