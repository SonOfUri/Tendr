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
  EXECUTORS_QUEUE,
  processAccountJob,
  RECONCILE_JOB,
  setAccountJobs,
} from './jobs/account-notices.js';
import { pollNativePayouts } from './accounts/native-payouts.js';
import { retryPendingScreenings } from './checkout/screening.js';
import { sweepReturns } from './checkout/refunds.js';
import { expireSessions, pollDeposit, scanDueDeposits } from './checkout/watcher.js';
import { releaseStaleReservations } from './gas/quote-fee.js';
import { pollEvmRelays } from './relayer/index.js';
import { pollPaymasterOps } from './relayer/evm/pimlico.js';
import { pollNearMetaRelays } from './relayer/near-meta.js';
import { pollSolanaRelays } from './relayer/solana.js';
import { pollTronRelays } from './relayer/tron.js';
import {
  releaseEndedSessionReservations,
  releaseStuckConfirmedHolds,
} from './relayer/submissions.js';
import { sweepExpiredPaymasterUrls } from './relayer/evm/pimlico.js';
import {
  attemptDelivery,
  DELIVER_WEBHOOK_JOB,
  setWebhookQueue,
  SWEEP_WEBHOOKS_JOB,
  sweepDueDeliveries,
  type DeliverJobData,
} from './checkout/webhooks.js';
import { sweepConnections } from './connect/authorize.js';
import {
  attemptHook,
  DELIVER_HOOK_JOB,
  pollNearHooks,
  setHookQueue,
  SWEEP_HOOKS_JOB,
  sweepDueHooks,
  type DeliverHookJobData,
} from './hooks/deliver.js';
import { sweepNotificationEmailLinks } from './merchants/notification-email.js';
import {
  PRODUCT_IMAGES_CONCURRENCY,
  PRODUCT_IMAGES_QUEUE,
  runProductImageJob,
  setProductImageQueue,
  type CacheProductImagesJobData,
} from './themes/product-images.js';
import { runFeeSweep } from './jobs/fee-sweep.js';
import { CHECK_GAS_BALANCES_EVERY_MS, checkGasBalances } from './jobs/gas-alerts.js';
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
/** Re-screens SCREENING_PENDING payments (backoff is per payment); runs every minute. */
export const RETRY_SCREENINGS_JOB = 'retry-pending-screenings';
export const NATIVE_PAYOUTS_JOB = 'poll-native-payouts';
/**
 * Deletes expired Connect credentials and revokes connections never redeemed, and ends expired
 * notification-email links (deleting their tokens); every minute.
 */
export const SWEEP_CONNECTIONS_JOB = 'sweep-connections';
/**
 * Gas-fee sweep (live mode only): plans due sweeps of the gas-fee accounts into USDC on NEAR and,
 * with FEE_SWEEP_ENABLED, executes them; hourly.
 */
export const FEE_SWEEP_JOB = 'fee-sweep';
export const FEE_SWEEP_JOB_EVERY_MS = 60 * 60_000;
/** Relayer key and Pimlico balances below GAS_LOW_BALANCE_USD alert operators; every 15 min. */
export const CHECK_GAS_BALANCES_JOB = 'check-gas-balances';

/** Whether the worker schedules the gas-fee sweep and the gas balance alerts (production only). */
export function gasOpsJobsScheduled(): boolean {
  return env().NODE_ENV === 'production';
}
/** The payment watcher's queue: the 5 s scan, one poll job per due address, the expiry sweep. */
export const CHECKOUT_QUEUE = 'tendr-checkout';
export const SCAN_DEPOSITS_JOB = 'scan-deposits';
export const POLL_DEPOSIT_JOB = 'poll-deposit';
export const EXPIRE_SESSIONS_JOB = 'expire-sessions';
/** Queues returns the post-commit watcher hook missed and retries undrafted returns. */
export const SWEEP_RETURNS_JOB = 'sweep-returns';
export const SWEEP_RETURNS_EVERY_MS = 60_000;
export const SCAN_DEPOSITS_EVERY_MS = 5_000;
export const EXPIRE_SESSIONS_EVERY_MS = 60_000;
/** Releases gas-budget reservations of replaced or expired, unused quotes. */
export const RELEASE_GAS_RESERVATIONS_JOB = 'release-gas-reservations';
export const RELEASE_GAS_RESERVATIONS_EVERY_MS = 60_000;
/**
 * The EVM relayer's transactions (receipts, stuck replacements, give-ups, outcomes), Pimlico
 * paymaster user operations (receipts, give-ups) and Solana Kora payments (statuses, outcomes),
 * live only.
 */
export const POLL_EVM_RELAYS_JOB = 'poll-evm-relays';
export const POLL_EVM_RELAYS_EVERY_MS = 15_000;
/**
 * Merchant webhook sends and integrator hook calls (one job per attempt, delayed for retries) and
 * their due-retry sweeps.
 */
export const WEBHOOKS_QUEUE = 'tendr-webhooks';
export const SWEEP_WEBHOOKS_EVERY_MS = 60_000;

/** Runs one webhooks-queue job (merchant webhooks and integrator hook calls). */
export async function processWebhookJob(job: Pick<Job, 'name' | 'data'>): Promise<void> {
  if (job.name === DELIVER_WEBHOOK_JOB) {
    await attemptDelivery((job.data as DeliverJobData).deliveryId);
    return;
  }
  if (job.name === SWEEP_WEBHOOKS_JOB) {
    const n = await sweepDueDeliveries();
    if (n > 0) log('info', 'webhook sweep queued due deliveries', { count: n });
    return;
  }
  if (job.name === DELIVER_HOOK_JOB) {
    await attemptHook((job.data as DeliverHookJobData).hookCallId);
    return;
  }
  if (job.name === SWEEP_HOOKS_JOB) {
    const n = await sweepDueHooks();
    if (n > 0) log('info', 'hook sweep queued due calls', { count: n });
    return;
  }
  throw new Error(`unknown webhooks job ${job.name}`);
}

interface PollJobData {
  depositAddress: string;
  livemode: boolean;
}

/** Runs one checkout-queue job; `queue` receives the poll jobs a scan fans out. */
export async function processCheckoutJob(
  job: Pick<Job, 'name' | 'data'>,
  queue: Pick<Queue, 'add'>,
): Promise<void> {
  if (job.name === SCAN_DEPOSITS_JOB) {
    await scanDueDeposits((data: PollJobData) =>
      queue.add(POLL_DEPOSIT_JOB, data, {
        // One queued poll per address; removed when done so the next scan can add it again.
        jobId: `poll__${data.livemode ? 'live' : 'test'}__${data.depositAddress}`,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    return;
  }
  if (job.name === POLL_DEPOSIT_JOB) {
    const data = job.data as PollJobData;
    await pollDeposit(data.depositAddress, { livemode: data.livemode });
    return;
  }
  if (job.name === EXPIRE_SESSIONS_JOB) {
    const n = await expireSessions();
    if (n > 0) log('info', 'expired checkout sessions', { count: n });
    return;
  }
  if (job.name === SWEEP_RETURNS_JOB) {
    const n = await sweepReturns();
    if (n > 0) log('info', 'return sweep', { count: n });
    return;
  }
  if (job.name === RELEASE_GAS_RESERVATIONS_JOB) {
    const n =
      (await releaseStaleReservations()) +
      (await releaseEndedSessionReservations()) +
      (await releaseStuckConfirmedHolds());
    const swept = await sweepExpiredPaymasterUrls();
    if (swept > 0) log('info', 'expired paymaster URLs swept', { count: swept });
    if (n > 0) log('info', 'released gas reservations', { count: n });
    return;
  }
  if (job.name === POLL_EVM_RELAYS_JOB) {
    let failed: unknown = null;
    try {
      const n = await pollEvmRelays();
      if (n > 0) log('info', 'evm relay outcomes applied', { count: n });
    } catch (err) {
      failed = err;
    }
    // Smart-wallet user operations sponsored through Pimlico (receipts from Pimlico).
    try {
      const m = await pollPaymasterOps();
      if (m > 0) log('info', 'paymaster outcomes applied', { count: m });
    } catch (err) {
      failed ??= err;
    }
    // Solana payments sent through Pimlico's Kora paymaster (outcomes from SOLANA_RPC_URL).
    try {
      const k = await pollSolanaRelays();
      if (k > 0) log('info', 'solana relay outcomes applied', { count: k });
    } catch (err) {
      failed ??= err;
    }
    // NEAR meta-transactions relayed by relayer-near (outcomes from the live NEAR RPC).
    try {
      const n = await pollNearMetaRelays();
      if (n > 0) log('info', 'near relay outcomes applied', { count: n });
    } catch (err) {
      failed ??= err;
    }
    // NEAR integrator hook calls whose outcome was unknown when sent.
    try {
      const h = await pollNearHooks();
      if (h > 0) log('info', 'near hook outcomes applied', { count: h });
    } catch (err) {
      failed ??= err;
    }
    // Tron: gas-tron's just-in-time delegations (sent approves, reclaims) and payWithApproval
    // outcomes (from TRON_RPC_URL). Only while the Tron forwarder is configured.
    if (env().TRON_FORWARDER_ADDRESS) {
      try {
        const t = await pollTronRelays();
        if (t > 0) log('info', 'tron relay outcomes applied', { count: t });
      } catch (err) {
        failed ??= err;
      }
    }
    if (failed) throw failed;
    return;
  }
  throw new Error(`unknown checkout job ${job.name}`);
}

/** Loads the event and runs the handler named by the job. Throwing makes BullMQ retry. */
async function processEventJob(job: Job<EventJobData>): Promise<void> {
  const event = await prisma.event.findUnique({ where: { id: job.data.eventId } });
  if (!event) throw new Error(`event ${job.data.eventId} not found`);
  const handler = getEventHandler(event.type, job.name);
  if (!handler) throw new Error(`no handler ${job.name} registered for ${event.type}`);
  await handler(event);
}

async function processMaintenanceJob(job: Job): Promise<void> {
  if (job.name === NATIVE_PAYOUTS_JOB) {
    await pollNativePayouts();
    return;
  }
  if (job.name === RETRY_SCREENINGS_JOB) {
    const n = await retryPendingScreenings();
    if (n > 0) log('info', 'retried pending screenings', { count: n });
    return;
  }
  if (job.name === SWEEP_CONNECTIONS_JOB) {
    await sweepConnections();
    // C12: expired / orphaned notification-email link tokens, on the same minute tick.
    await sweepNotificationEmailLinks();
    return;
  }
  if (job.name === FEE_SWEEP_JOB) {
    const r = await runFeeSweep();
    if (r.planned > 0) log('info', 'fee sweep', { ...r });
    return;
  }
  if (job.name === CHECK_GAS_BALANCES_JOB) {
    const low = (await checkGasBalances()).filter((x) => x.low).length;
    if (low > 0) log('warn', 'gas balances low', { count: low });
    return;
  }
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
 * Starts the worker process: event-job, maintenance, merchant-account, checkout and product-image
 * workers, the hourly `purge-idempotency` schedule, the per-minute account jobs (reconciliation,
 * ready timelocks, ready recoveries), the payment watcher (5 s deposit scan, per-minute session
 * expiry), the outbox dispatcher and the health server.
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
  // Account jobs: one reconciliation job per account per tick (fanned out by `reconcile-accounts`)
  // and the delayed recovery reminder, several at once; the permissionless executors on their own
  // queue so a slow reconciliation never holds up a ready timelock (or the reverse).
  const accountsQueue = new Queue(ACCOUNTS_QUEUE, {
    ...setup,
    defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } },
  });
  const executorsQueue = new Queue(EXECUTORS_QUEUE, setup);
  setAccountJobs(accountsQueue);
  const runAccountJob = (job: Job) => processAccountJob(job.name, job.data);
  const accountsWorker = new Worker(ACCOUNTS_QUEUE, runAccountJob, { ...setup, concurrency: 5 });
  const executorsWorker = new Worker(EXECUTORS_QUEUE, runAccountJob, { ...setup, concurrency: 1 });
  // Payment watcher: polls are independent per address (claimed with a lease), so many at once.
  const checkoutQueue = new Queue(CHECKOUT_QUEUE, {
    ...setup,
    defaultJobOptions: { removeOnComplete: { age: 600 }, removeOnFail: { age: 86400 } },
  });
  const checkoutWorker = new Worker(
    CHECKOUT_QUEUE,
    (job: Job) => processCheckoutJob(job, checkoutQueue),
    { ...setup, concurrency: 10 },
  );
  // Merchant webhooks: each send waits up to 10 s on the merchant's server, so many at once.
  const webhooksQueue = new Queue(WEBHOOKS_QUEUE, setup);
  setWebhookQueue(webhooksQueue);
  setHookQueue(webhooksQueue);
  const webhooksWorker = new Worker(WEBHOOKS_QUEUE, processWebhookJob, {
    ...setup,
    concurrency: 20,
  });
  // Product images: fetches from store sites (up to ~30 s a job) on their own queue and worker,
  // so they never hold up the events queue.
  const productImagesQueue = new Queue(PRODUCT_IMAGES_QUEUE, setup);
  setProductImageQueue(productImagesQueue);
  const productImagesWorker = new Worker<CacheProductImagesJobData>(
    PRODUCT_IMAGES_QUEUE,
    (job) => runProductImageJob(job.data),
    { ...setup, concurrency: PRODUCT_IMAGES_CONCURRENCY },
  );
  const workers = [
    webhooksWorker,
    productImagesWorker,
    eventsWorker,
    maintenanceWorker,
    accountsWorker,
    executorsWorker,
    checkoutWorker,
  ] as Worker[];
  for (const w of workers) {
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

  await maintenanceQueue.upsertJobScheduler(
    NATIVE_PAYOUTS_JOB,
    { every: 60_000 },
    { name: NATIVE_PAYOUTS_JOB },
  );

  await maintenanceQueue.upsertJobScheduler(
    RETRY_SCREENINGS_JOB,
    { every: 60_000 },
    { name: RETRY_SCREENINGS_JOB },
  );

  await maintenanceQueue.upsertJobScheduler(
    SWEEP_CONNECTIONS_JOB,
    { every: 60_000 },
    { name: SWEEP_CONNECTIONS_JOB },
  );

  // The gas-fee sweep and the gas balance alerts read live chains, 1Click and the live key
  // addresses: scheduled only in production (never in tests or local development, R12-g), and
  // removed elsewhere in case a shared Redis kept an earlier schedule.
  if (gasOpsJobsScheduled()) {
    await maintenanceQueue.upsertJobScheduler(
      FEE_SWEEP_JOB,
      { every: FEE_SWEEP_JOB_EVERY_MS },
      { name: FEE_SWEEP_JOB },
    );
    await maintenanceQueue.upsertJobScheduler(
      CHECK_GAS_BALANCES_JOB,
      { every: CHECK_GAS_BALANCES_EVERY_MS },
      { name: CHECK_GAS_BALANCES_JOB },
    );
  } else {
    await maintenanceQueue.removeJobScheduler(FEE_SWEEP_JOB);
    await maintenanceQueue.removeJobScheduler(CHECK_GAS_BALANCES_JOB);
  }

  await accountsQueue.upsertJobScheduler(
    RECONCILE_JOB,
    { every: ACCOUNT_JOB_EVERY_MS },
    { name: RECONCILE_JOB },
  );
  for (const name of [EXECUTE_TIMELOCKS_JOB, EXECUTE_RECOVERY_JOB]) {
    await executorsQueue.upsertJobScheduler(name, { every: ACCOUNT_JOB_EVERY_MS }, { name });
  }

  await checkoutQueue.upsertJobScheduler(
    SCAN_DEPOSITS_JOB,
    { every: SCAN_DEPOSITS_EVERY_MS },
    { name: SCAN_DEPOSITS_JOB },
  );
  await checkoutQueue.upsertJobScheduler(
    EXPIRE_SESSIONS_JOB,
    { every: EXPIRE_SESSIONS_EVERY_MS },
    { name: EXPIRE_SESSIONS_JOB },
  );
  await checkoutQueue.upsertJobScheduler(
    RELEASE_GAS_RESERVATIONS_JOB,
    { every: RELEASE_GAS_RESERVATIONS_EVERY_MS },
    { name: RELEASE_GAS_RESERVATIONS_JOB },
  );
  await checkoutQueue.upsertJobScheduler(
    POLL_EVM_RELAYS_JOB,
    { every: POLL_EVM_RELAYS_EVERY_MS },
    { name: POLL_EVM_RELAYS_JOB },
  );
  await checkoutQueue.upsertJobScheduler(
    SWEEP_RETURNS_JOB,
    { every: SWEEP_RETURNS_EVERY_MS },
    { name: SWEEP_RETURNS_JOB },
  );

  await webhooksQueue.upsertJobScheduler(
    SWEEP_WEBHOOKS_JOB,
    { every: SWEEP_WEBHOOKS_EVERY_MS },
    { name: SWEEP_WEBHOOKS_JOB },
  );
  await webhooksQueue.upsertJobScheduler(
    SWEEP_HOOKS_JOB,
    { every: SWEEP_WEBHOOKS_EVERY_MS },
    { name: SWEEP_HOOKS_JOB },
  );

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
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(
        [
          eventsQueue,
          maintenanceQueue,
          accountsQueue,
          executorsQueue,
          checkoutQueue,
          webhooksQueue,
          productImagesQueue,
        ].map((q) => q.close()),
      );
      setAccountJobs(null);
      setWebhookQueue(null);
      setProductImageQueue(null);
      setHookQueue(null);
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
  log('info', 'Tendr worker started', {
    healthPort: worker.healthPort,
    screeningMode: env().SCREENING_MODE,
  });

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
