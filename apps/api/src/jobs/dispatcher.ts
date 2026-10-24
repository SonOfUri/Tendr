import type { JobsOptions, Queue } from 'bullmq';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { handledEventTypes, handlerNamesFor, JOB_ID_SEPARATOR } from './handlers.js';
import { EVENT_JOB_OPTIONS, getEventsQueue, type EventJobData } from './queue.js';

export const DISPATCH_BATCH_SIZE = 100;
/** Bound on enqueueing a batch; well under the transaction timeout so a dead Redis fails the batch. */
export const ENQUEUE_TIMEOUT_MS = 5_000;
const TX_TIMEOUT_MS = 15_000;

export interface DispatchOptions {
  /** Defaults to the process-wide events queue. */
  queue?: Queue<EventJobData>;
  /** Merged over the default retry policy (tests shorten it). */
  jobOptions?: JobsOptions;
  /** Defaults to `ENQUEUE_TIMEOUT_MS`. */
  enqueueTimeoutMs?: number;
  /** Test hook: runs after enqueueing, before the outbox rows are deleted. */
  beforeDelete?: () => void | Promise<void>;
}

/**
 * Moves one batch of committed events from `event_outbox` onto the queue: one job per
 * registered handler, then deletes the rows, all inside one transaction.
 *
 * The outbox (not `events.id` order) is the source of truth, so an event whose transaction
 * commits after a newer one is still picked up. `SKIP LOCKED` lets several dispatchers run
 * at once. If anything fails after enqueueing, the transaction rolls back and the rows are
 * dispatched again; the deterministic job id (`{eventId}__{handler}`) makes BullMQ ignore the
 * duplicate while the first job is queued or retained (completed jobs are kept 24h).
 *
 * Only rows whose event type has at least one handler in this process's registry (the worker
 * registers every handler via `register-handlers.ts`) are claimed. Rows of other types are left
 * untouched — never deleted — so during a rolling deploy an older dispatcher cannot drop events
 * a newer release handles; they are dispatched once a dispatcher with a handler runs. With no
 * handlers registered at all, nothing is claimed.
 *
 * If Redis is unreachable, enqueueing is abandoned after `enqueueTimeoutMs` so the transaction
 * rolls back promptly and the caller sees the error.
 *
 * Returns the number of outbox rows dispatched.
 */
export async function dispatchOnce(opts: DispatchOptions = {}): Promise<number> {
  const handledTypes = handledEventTypes();
  if (handledTypes.length === 0) return 0;
  const queue = opts.queue ?? getEventsQueue();
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ event_id: string }[]>`
        SELECT o.event_id FROM event_outbox o
        JOIN events e ON e.id = o.event_id
        WHERE e.type = ANY(${handledTypes})
        ORDER BY o.created_at
        LIMIT ${DISPATCH_BATCH_SIZE}
        FOR UPDATE OF o SKIP LOCKED`;
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.event_id);

      const events = await tx.event.findMany({
        where: { id: { in: ids } },
        select: { id: true, type: true },
      });
      const jobs = events.flatMap((e) =>
        handlerNamesFor(e.type).map((name) => ({
          name,
          data: { eventId: e.id },
          opts: {
            ...EVENT_JOB_OPTIONS,
            ...opts.jobOptions,
            jobId: `${e.id}${JOB_ID_SEPARATOR}${name}`,
          },
        })),
      );
      await withTimeout(queue.addBulk(jobs), opts.enqueueTimeoutMs ?? ENQUEUE_TIMEOUT_MS);

      await opts.beforeDelete?.();
      await tx.$executeRaw`DELETE FROM event_outbox WHERE event_id = ANY(${ids})`;
      return ids.length;
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`enqueue timed out after ${ms}ms`)), ms);
  });
  // The abandoned enqueue may still land later; its rows are re-dispatched and deduped by job id.
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Polls the outbox every `intervalMs`, draining back-to-back while batches come back full.
 * Errors are logged and retried on the next tick. Returns `stop()`, which waits for the
 * in-flight batch.
 */
export function startDispatcher(
  intervalMs = 500,
  opts: Omit<DispatchOptions, 'beforeDelete'> = {},
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      while (!stopped && (await dispatchOnce(opts)) === DISPATCH_BATCH_SIZE);
    } catch (err) {
      log('error', 'event dispatch failed', { err: String(err) });
    }
    if (!stopped) timer = setTimeout(schedule, intervalMs);
  };
  const schedule = () => {
    running = tick();
  };
  schedule();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
