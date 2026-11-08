// The one "is a deposit in flight?" test every expiry path uses (I-1): the watcher's sweeper
// (`expireSessions`), `createSession` expiring a stale session that still holds the same
// `external_ref`, and the store's `/expire`. A session with a deposit in flight is never expired:
// expiring it would turn an on-time payment late and invite the shopper to pay again.
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/** How long after a quote's deadline a reported or superseded deposit is still tracked. */
export const SUPERSEDED_GRACE_MS = 30 * 60_000;

/** Payment statuses that mean the money is still on its way. */
export const IN_FLIGHT_PAYMENT_STATUSES = ['DETECTED', 'PROCESSING', 'SCREENING_PENDING'] as const;

type Db = Prisma.TransactionClient | typeof prisma;

/** Read-only check for services that must not receive internal relay-record delegates. */
export function sessionDepositInFlight(
  session: { id: string; merchantId: string; livemode: boolean; expiresAt: Date },
  now: Date,
): Promise<boolean> {
  return depositInFlight(prisma, session, now).then((reason) => reason !== null);
}

/** Why a session's deposit is in flight, or null when nothing is. */
export type InFlightReason = 'unpolled' | 'payment' | 'reported';

/**
 * Whether `session` has a deposit in flight at `now`:
 * - `unpolled`: the session is past `expires_at` and a watched address was not polled after it
 *   (a deposit made in time may not be attributed yet);
 * - `payment`: a payment is DETECTED / PROCESSING / SCREENING_PENDING;
 * - `reported`: the shopper reported a deposit tx that 1Click has not shown yet (no payment row),
 *   or a gasless relay for the quote is claimed / broadcast with no known outcome yet
 *   (`quotesWithRelayInFlight`), and its quote deadline plus SUPERSEDED_GRACE_MS has not passed.
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
  const relaying = [...(await quotesWithRelayInFlight(db, tenant, session.id))];
  const reported = await db.quote.count({
    where: {
      ...tenant,
      sessionId: session.id,
      OR: [
        { depositTxSubmittedAt: { not: null } },
        ...(relaying.length > 0 ? [{ id: { in: relaying } }] : []),
      ],
      deadline: { gt: new Date(now.getTime() - SUPERSEDED_GRACE_MS) },
      payments: { none: {} },
    },
  });
  return reported > 0 ? 'reported' : null;
}

/** Relayed-submission statuses whose outcome is not known yet (a claim, or a broadcast). */
export const RELAY_IN_FLIGHT_STATUSES = ['pending', 'submitted'] as const;

/**
 * The session's quotes with a gasless relay that may still move the shopper's money (final review
 * I3): a `gas_sponsorships` submission claimed for the quote or broadcast without a known outcome
 * (including an unknown-outcome / 5xx relay, which never set `deposit_tx_submitted_at`), or a
 * Tron approval in flight. Such a quote is treated as a reported deposit: no re-quote and no
 * expiry while it can still land.
 */
export async function quotesWithRelayInFlight(
  db: Db,
  scope: { merchantId: string; livemode: boolean },
  sessionId: string,
): Promise<Set<string>> {
  const tenant = { merchantId: scope.merchantId, livemode: scope.livemode };
  const [sponsorships, approvals] = await Promise.all([
    db.gasSponsorship.findMany({
      where: {
        ...tenant,
        sessionId,
        quoteId: { not: null },
        status: { in: [...RELAY_IN_FLIGHT_STATUSES] },
      },
      select: { quoteId: true },
    }),
    db.tronApproval.findMany({
      where: { ...tenant, sessionId, status: { in: [...RELAY_IN_FLIGHT_STATUSES] } },
      select: { quoteId: true },
    }),
  ]);
  return new Set(
    [...sponsorships.map((s) => s.quoteId), ...approvals.map((a) => a.quoteId)].filter(
      (id): id is string => id !== null,
    ),
  );
}
