// The Tendr-wide daily cap on unrecovered sponsorship losses (project 5a, spec §2.2, §2.5).
//
// A merchant-sponsored cost Tendr could not recover is recorded with `sponsor = tendr` and the time
// it was recognised (`recognizeTendrLoss`). Once the total of the losses recognised on the current
// UTC day in a mode reaches TENDR_SPONSOR_LOSS_CAP_USD, new payments are
// not sponsored (the shopper pays) and operators are alerted: an internal system event
// `gas.loss_cap_reached` (never a webhook) plus an `OPS ALERT` log line, once per UTC day per mode
// (the same pattern as the watcher's ops events).
import { Prisma } from '@prisma/client';
import { UsdAmountSchema } from '@tendr/contracts';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

/** Internal system event (no merchant, never a webhook): the day's loss cap was reached. */
export const GAS_LOSS_CAP_REACHED = 'gas.loss_cap_reached';

/** The UTC day of `at`, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayBounds(at: Date): { start: Date; end: Date } {
  const start = new Date(`${utcDay(at)}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * Records a sponsorship's cost as Tendr's own loss (spec §2.5: recovery from the merchant was
 * impossible): `sponsor = tendr`, `cost_usd = costUsd`, `loss_recognized_at = at`. Only a
 * sponsorship not already a Tendr loss changes; returns false (a no-op) otherwise, so the loss
 * keeps its first recognition time. Must run inside the caller's transaction.
 */
export async function recognizeTendrLoss(
  tx: Prisma.TransactionClient,
  sponsorshipId: string,
  costUsd: string,
  at: Date,
): Promise<boolean> {
  const cost = UsdAmountSchema.parse(costUsd);
  const { count } = await tx.gasSponsorship.updateMany({
    where: { id: sponsorshipId, NOT: { sponsor: 'tendr' } },
    data: { sponsor: 'tendr', costUsd: cost, lossRecognizedAt: at },
  });
  return count === 1;
}

/**
 * The unrecovered sponsorship losses recognised on the UTC day of `now` in the mode, in USD: the
 * whole cost of Tendr losses (`sponsor = tendr`), plus the unrecovered part (`unrecovered_usd`,
 * cost above what was collected) of sponsorships that are not themselves a Tendr loss.
 */
async function lossToday(livemode: boolean, now: Date): Promise<Prisma.Decimal> {
  const { start, end } = dayBounds(now);
  const [whole, part] = await Promise.all([
    prisma.gasSponsorship.aggregate({
      where: { livemode, sponsor: 'tendr', lossRecognizedAt: { gte: start, lt: end } },
      _sum: { costUsd: true },
    }),
    prisma.gasSponsorship.aggregate({
      where: {
        livemode,
        NOT: { sponsor: 'tendr' },
        unrecoveredAt: { gte: start, lt: end },
      },
      _sum: { unrecoveredUsd: true },
    }),
  ]);
  return (whole._sum.costUsd ?? new Prisma.Decimal(0)).plus(
    part._sum.unrecoveredUsd ?? new Prisma.Decimal(0),
  );
}

/**
 * Whether the total `cost_usd` of `sponsor = tendr` sponsorships in the mode whose loss was
 * recognised (`loss_recognized_at`) on the UTC day of `now` has reached TENDR_SPONSOR_LOSS_CAP_USD.
 */
export async function lossCapReached(livemode: boolean, now: Date): Promise<boolean> {
  return (await lossToday(livemode, now)).gte(env().TENDR_SPONSOR_LOSS_CAP_USD);
}

/**
 * Alerts operators that the mode's loss cap is reached: records `gas.loss_cap_reached` and logs an
 * `OPS ALERT`, at most once per UTC day per mode (an advisory lock serialises concurrent callers).
 */
export async function alertLossCapReached(livemode: boolean, now: Date): Promise<void> {
  const day = utcDay(now);
  const aggregateId = `${livemode ? 'live' : 'test'}:${day}`;
  const capUsd = env().TENDR_SPONSOR_LOSS_CAP_USD;
  const recorded = await prisma.$transaction(async (tx) => {
    const key = `${GAS_LOSS_CAP_REACHED}:${aggregateId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
    const seen = await tx.event.findFirst({
      where: { aggregateType: 'gas_loss_cap', aggregateId, type: GAS_LOSS_CAP_REACHED },
      select: { id: true },
    });
    if (seen) return null;
    const lossUsd = (await lossToday(livemode, now)).toFixed();
    await recordEvent(tx, null, {
      aggregateType: 'gas_loss_cap',
      aggregateId,
      type: GAS_LOSS_CAP_REACHED,
      payload: { livemode, day, cap_usd: capUsd, loss_usd: lossUsd },
    });
    return lossUsd;
  });
  if (recorded !== null) {
    log('warn', `OPS ALERT: ${GAS_LOSS_CAP_REACHED}`, {
      livemode,
      day,
      capUsd,
      lossUsd: recorded,
    });
  }
}
