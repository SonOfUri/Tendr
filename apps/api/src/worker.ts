import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Queue, Worker, type Job } from 'bullmq';
import { env, loadEnv } from './env.js';
import {
  ACCOUNT_JOB_EVERY_MS,
  ACCOUNTS_QUEUE,
  EXECUTE_RECOVERY_JOB,
  EXECUTE_TIMELOCKS_JOB,
  processAccountJob,
  RECONCILE_JOB,
  setDelayedJobs,
} from './jobs/account-notices.js';
import { startDispatcher } from './jobs/dispatcher.js';
import { getEventHandler } from './jobs/handlers.js';
// Registers every event handler; must load before the dispatcher runs (see dispatchOnce).
import './jobs/register-handlers.js';
import {
  closeConnection,
  createEventsQueue,
  createMaintenanceQueue,
  createQueueConnection,
  EVENTS_QUEUE,
  MAINTENANCE_QUEUE,
  PURGE_IDEMPOTENCY_JOB,
  purgeExpiredIdempotencyKeys,
  type EventJobData,
} from './jobs/queue.js';
import { loadDotenvFile } from './lib/load-dotenv.js';
import { log } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { closeClient, createRedis, whenReady } from './lib/redis.js';

const HEALTH_CHECK_TIMEOUT_MS = 1000;

/** Loads the event and runs the handler named by the job. Throwing makes BullMQ retry. */
async function processEventJob(job: Job<EventJobData>): Promise<void> {
  const event = await prisma.event.findUnique({ where: { id: job.data.eventId } });
  if (!event) throw new Error(`event ${job.data.eventId} not found`);
  const handler = getEventHandler(event.type, job.name);
  if (!handler) throw new Error(`no handler ${job.name} registered for ${event.type}`);
  await handler(event);
}

async function processMaintenanceJob(job: Job): Promise<void> {
  if (job.name !== PURGE_IDEMPOTENCY_JOB) throw new Error(`unknown maintenance job ${job.name}`);
  const purged = await purgeExpiredIdempotencyKeys();
  log('info', 'purged expired idempotency keys', { purged });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function check(p: () => Promise<unknown>): Promise<'ok' | 'down'> {
  try {
    await withTimeout(p(), HEALTH_CHECK_TIMEOUT_MS);
    return 'ok';
  } catch {
    return 'down';
  }
}

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

/**
 * `GET /health`: 200 `{ status: 'ok' }` when Postgres (`SELECT 1`) and Redis (`PING`) answer,
 * otherwise 503 `{ status: 'degraded', db, redis }`. Uses its own fail-fast Redis client so a
 * dead Redis shows up as `down` instead of a hung request.
 */
export async function startHealthServer(opts: {
  port: number;
  redisUrl: string;
  /** Interface to bind; Node's default (all interfaces) when omitted. */
  host?: string;
}): Promise<HealthServer> {
  const redis = createRedis(opts.redisUrl);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const [db, redisStatus] = await Promise.all([
        check(() => prisma.$queryRaw`SELECT 1`),
        // A client still (re)connecting rejects at once (no offline queue): give it a moment.
        check(async () => {
          await whenReady(redis, HEALTH_CHECK_TIMEOUT_MS / 2);
          return redis.ping();
        }),
      ]);
      const ok = db === 'ok' && redisStatus === 'ok';
      const body = ok ? { status: 'ok' } : { status: 'degraded', db, redis: redisStatus };
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    })();
  });
  await new Promise<void>((done) => server.listen(opts.port, opts.host, done));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await closeClient(redis);
    },
  };
}

export interface WorkerOptions {
  /** BullMQ key prefix (tests use a unique one). */
  prefix?: string;
  /** Defaults to `WORKER_HEALTH_PORT`; 0 picks a free port. */
  healthPort?: number;
  /** Run the outbox dispatcher in this process (default true). */
  dispatcher?: boolean;
  dispatchIntervalMs?: number;
}

/**
 * Starts the worker process: event-job, maintenance and merchant-account workers, the hourly
 * `purge-idempotency` schedule, the per-minute account jobs (reconciliation, ready timelocks,
 * ready recoveries), the outbox dispatcher and the health server.
 */
export async function startWorker(
  opts: WorkerOptions = {},
): Promise<{ healthPort: number; stop(): Promise<void> }> {
  const connection = createQueueConnection();
  const setup = { connection, prefix: opts.prefix };
  const eventsQueue = createEventsQueue(setup);
  const maintenanceQueue = createMaintenanceQueue(setup);

  const eventsWorker = new Worker<EventJobData>(EVENTS_QUEUE, processEventJob, {
    ...setup,
    concurrency: 5,
  });
  const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, processMaintenanceJob, setup);
  const accountsQueue = new Queue(ACCOUNTS_QUEUE, setup);
  // Delayed account jobs (the recovery reminder) go on this process's accounts queue.
  setDelayedJobs(accountsQueue);
  const accountsWorker = new Worker(
    ACCOUNTS_QUEUE,
    (job: Job) => processAccountJob(job.name, job.data),
    setup,
  );
  for (const w of [eventsWorker, maintenanceWorker, accountsWorker] as Worker[]) {
    w.on('failed', (job, err) =>
      log('warn', 'job failed', {
        queue: w.name,
        jobId: job?.id,
        handler: job?.name,
        attemptsMade: job?.attemptsMade,
        err: String(err),
      }),
    );
    w.on('error', (err) => log('error', 'worker error', { queue: w.name, err: String(err) }));
  }

  await maintenanceQueue.upsertJobScheduler(
    PURGE_IDEMPOTENCY_JOB,
    { pattern: '0 * * * *' },
    { name: PURGE_IDEMPOTENCY_JOB },
  );

  for (const name of [RECONCILE_JOB, EXECUTE_TIMELOCKS_JOB, EXECUTE_RECOVERY_JOB]) {
    await accountsQueue.upsertJobScheduler(name, { every: ACCOUNT_JOB_EVERY_MS }, { name });
  }

  const stopDispatcher =
    opts.dispatcher === false
      ? async () => {}
      : startDispatcher(opts.dispatchIntervalMs, { queue: eventsQueue });

  const health = await startHealthServer({
    port: opts.healthPort ?? env().WORKER_HEALTH_PORT,
    host: env().WORKER_HEALTH_HOST,
    redisUrl: env().REDIS_URL,
  });

  return {
    healthPort: health.port,
    stop: async () => {
      await stopDispatcher();
      await Promise.all([eventsWorker.close(), maintenanceWorker.close(), accountsWorker.close()]);
      await Promise.all([eventsQueue.close(), maintenanceQueue.close(), accountsQueue.close()]);
      setDelayedJobs(null);
      await closeConnection(connection);
      await health.close();
    },
  };
}

async function main() {
  // Load monorepo root .env (apps/api cwd) — does not override existing env.
  loadDotenvFile(resolve(process.cwd(), '../../.env'));
  loadDotenvFile(resolve(process.cwd(), '.env'));
  loadEnv();
  const worker = await startWorker();
  log('info', 'Tendr worker started', { healthPort: worker.healthPort });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // a second signal must not run stop() again
    shuttingDown = true;
    log('info', 'shutting down', { signal });
    try {
      await worker.stop();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      log('error', 'shutdown failed', { err: String(err) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
