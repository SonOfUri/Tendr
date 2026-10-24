import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { ScopeContext } from './scoped.js';

/**
 * THE way services change merchant state. Runs `fn` in one interactive transaction on the
 * unscoped client, so a state change and the event describing it (`recordEvent` writes
 * `events` + `event_outbox`, which scoped clients cannot write) commit or roll back together.
 *
 * The transaction client is NOT tenant-scoped. Inside `fn`, change state only through the
 * tenant-aware helpers — `transitionSession`, `transitionPayment`, `recordEvent` — passing the
 * SAME `ctx` given here (it is also handed to `fn`); they filter every read and write by
 * `ctx.merchantId` + `ctx.livemode`, so a row of another merchant or mode is NOT_FOUND. Never
 * issue ad-hoc `tx.<model>` writes addressed by id alone: that is the cross-tenant path this
 * helper exists to close.
 */
export function tenantTransaction<T>(
  ctx: ScopeContext,
  fn: (tx: Prisma.TransactionClient, ctx: ScopeContext) => Promise<T>,
): Promise<T> {
  if (!ctx.merchantId) {
    return Promise.reject(new Error('tenantTransaction requires a merchant context'));
  }
  return prisma.$transaction((tx) => fn(tx, ctx));
}
