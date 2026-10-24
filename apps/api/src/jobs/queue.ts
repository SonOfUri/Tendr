import type { Prisma } from '@prisma/client';
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { closeClient } from '../lib/redis.js';

/** Event fan-out: one job per (event, handler); the job name is the handler name. */
export const EVENTS_QUEUE = 'tendr-events';
/** Scheduled housekeeping jobs. */
export const MAINTENANCE_QUEUE = 'tendr-maintenance';
export const PURGE_IDEMPOTENCY_JOB = 'purge-idempotency';

export interface EventJobData {
  eventId: string;
}

/** Retry policy for event jobs; failed jobs are kept so ops can inspect them (`npm run jobs:failed`). */
export const EVENT_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
} satisfies JobsOptions;

/**
 * A Redis connection for BullMQ. Unlike the rate limiter's fail-fast client, BullMQ needs
 * `maxRetriesPerRequest: null` (required for workers' blocking commands) and an offline queue,
 * so commands wait out a Redis restart instead of failing.
 */
export function createQueueConnection(url: string = env().REDIS_URL): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: null });
  client.on('error', (err) => log('warn', 'queue redis error', { err: String(err) }));
  return client;
}

export const closeConnection = closeClient;

export interface QueueSetup {
  connection: Redis;
  /** BullMQ key prefix; tests use a unique one to stay isolated. */
  prefix?: string;
}

export function createEventsQueue({ connection, prefix }: QueueSetup): Queue<EventJobData> {
  return new Queue<EventJobData>(EVENTS_QUEUE, { connection, prefix });
}

export function createMaintenanceQueue({ connection, prefix }: QueueSetup): Queue {
  return new Queue(MAINTENANCE_QUEUE, { connection, prefix });
}

let shared: { connection: Redis; queue: Queue<EventJobData> } | null = null;

/** The process-wide events queue on `REDIS_URL`, built on first use. */
export function getEventsQueue(): Queue<EventJobData> {
  if (!shared) {
    const connection = createQueueConnection();
    shared = { connection, queue: createEventsQueue({ connection }) };
  }
  return shared.queue;
}

export async function closeEventsQueue(): Promise<void> {
  const s = shared;
  shared = null;
  if (s) {
    await s.queue.close();
    await closeConnection(s.connection);
  }
}

export interface FailedJob {
  id: string | undefined;
  handler: string;
  attempts: number;
  error: string;
}

/** Jobs that exhausted their attempts (BullMQ's failed set), oldest first. */
export async function listFailedJobs(queue: Queue): Promise<FailedJob[]> {
  const jobs = await queue.getFailed();
  return jobs
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((j) => ({ id: j.id, handler: j.name, attempts: j.attemptsMade, error: j.failedReason }));
}

/**
 * Deletes expired idempotency keys; returns how many were removed. `expires_at` is a
 * `timestamp(3)` holding UTC (Prisma's convention), so it is compared with the database's UTC
 * wall clock — a bare `now()` would be shifted by the session time zone. `db` lets tests run it
 * on a connection with a non-UTC time zone.
 */
export async function purgeExpiredIdempotencyKeys(
  db: Pick<Prisma.TransactionClient, '$executeRaw'> = prisma,
): Promise<number> {
  return db.$executeRaw`DELETE FROM idempotency_keys WHERE expires_at < (now() AT TIME ZONE 'UTC')`;
}
