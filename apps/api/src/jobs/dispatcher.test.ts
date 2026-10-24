import { randomUUID } from 'node:crypto';
import type { Event } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordEvent } from '../events/record.js';
import { env, loadEnv } from '../env.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, resetDb } from '../test/helpers.js';
import { startHealthServer, startWorker } from '../worker.js';
import { dispatchOnce, ENQUEUE_TIMEOUT_MS, startDispatcher } from './dispatcher.js';
import { clearEventHandlers, registerEventHandler } from './handlers.js';
import {
  closeConnection,
  createEventsQueue,
  createMaintenanceQueue,
  createQueueConnection,
  listFailedJobs,
  PURGE_IDEMPOTENCY_JOB,
  purgeExpiredIdempotencyKeys,
} from './queue.js';

// A unique key prefix keeps this file's BullMQ data apart from any other queue in the same Redis.
const prefix = `test-${randomUUID()}`;

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('event dispatch', () => {
  let connection: Redis;
  let queue: Queue;
  let worker: { stop(): Promise<void> } | null = null;
  let merchantId: string;

  const record = (type: string) =>
    prisma.$transaction((tx) =>
      recordEvent(
        tx,
        { merchantId, livemode: false },
        {
          aggregateType: 'session',
          aggregateId: newId('ses'),
          type,
          payload: { n: 1 },
        },
      ),
    );
  const outboxCount = () => prisma.eventOutbox.count();
  const runWorker = async () => {
    worker = await startWorker({ prefix, healthPort: 0, dispatcher: false });
  };

  beforeAll(() => {
    connection = createQueueConnection();
    queue = createEventsQueue({ connection, prefix });
  });
  afterAll(async () => {
    // The worker also registers the purge-idempotency schedule under this prefix.
    const maintenance = createMaintenanceQueue({ connection, prefix });
    await maintenance.removeJobScheduler(PURGE_IDEMPOTENCY_JOB);
    await maintenance.obliterate({ force: true });
    await maintenance.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await closeConnection(connection);
  });
  beforeEach(async () => {
    await resetDb();
    merchantId = (await createMerchant()).id;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    await worker?.stop();
    worker = null;
    clearEventHandlers();
    await queue.obliterate({ force: true });
    vi.restoreAllMocks();
  });

  it('every committed event is dispatched once per handler', async () => {
    const calls: string[] = [];
    registerEventHandler('session.created', 'audit', async (e) => void calls.push(`audit:${e.id}`));
    registerEventHandler(
      'session.created',
      'notify',
      async (e) => void calls.push(`notify:${e.id}`),
    );
    registerEventHandler('payment.settled', 'audit', async (e) => void calls.push(`audit:${e.id}`));

    const a = await record('session.created');
    const b = await record('payment.settled');
    const c = await record('nobody.listens'); // no handlers: just leaves the outbox

    loadEnv({ ...process.env, LOG_LEVEL: 'debug' });
    try {
      expect(await dispatchOnce({ queue })).toBe(3);
    } finally {
      loadEnv();
    }
    expect(await outboxCount()).toBe(0);
    expect(await dispatchOnce({ queue })).toBe(0);
    // The no-handler row is dropped (events keeps the record), and that is logged at debug.
    const logged = vi.mocked(console.log).mock.calls.map((args) => String(args[0]));
    expect(logged.some((l) => l.includes('outbox rows dropped with no handler'))).toBe(true);
    expect(logged.find((l) => l.includes('no handler'))).toContain('"count":1');

    await runWorker();
    await waitFor(() => calls.length === 3);
    await sleep(100);
    expect(calls.sort()).toEqual([`audit:${a}`, `audit:${b}`, `notify:${a}`].sort());
    expect(calls.some((x) => x.endsWith(c))).toBe(false);
  });

  it('events committed out of id order are still dispatched', async () => {
    const seen: string[] = [];
    registerEventHandler('session.created', 'audit', async (e) => void seen.push(e.id));

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let recorded!: () => void;
    const aRecorded = new Promise<void>((r) => (recorded = r));
    // tx A records first (older ULID, older outbox created_at) but stays open.
    const txA = prisma.$transaction(
      async (tx) => {
        const id = await recordEvent(
          tx,
          { merchantId, livemode: false },
          {
            aggregateType: 'session',
            aggregateId: newId('ses'),
            type: 'session.created',
            payload: {},
          },
        );
        recorded();
        await held;
        return id;
      },
      { timeout: 10_000 },
    );
    await aRecorded;
    const b = await record('session.created'); // tx B commits while A is still open

    expect(await dispatchOnce({ queue })).toBe(1);
    release();
    const a = await txA;
    expect(a < b).toBe(true); // A's id sorts first even though it committed last
    expect(await dispatchOnce({ queue })).toBe(1);
    expect(await outboxCount()).toBe(0);

    await runWorker();
    await waitFor(() => seen.length === 2);
    expect(seen.sort()).toEqual([a, b].sort());
  });

  it('crash after enqueue before delete does not run a handler twice', async () => {
    const seen: string[] = [];
    registerEventHandler('session.created', 'audit', async (e) => void seen.push(e.id));
    const a = await record('session.created');
    const b = await record('session.created');
    await runWorker();

    // Jobs are enqueued, then the outbox DELETE fails: the transaction rolls back.
    await expect(
      dispatchOnce({
        queue,
        beforeDelete: () => {
          throw new Error('simulated crash before DELETE');
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect(await outboxCount()).toBe(2);

    // The first enqueue's jobs run and complete before the rows are dispatched again.
    await waitFor(() => seen.length === 2);
    expect(await dispatchOnce({ queue })).toBe(2);
    expect(await outboxCount()).toBe(0);
    await sleep(300);

    expect(seen.sort()).toEqual([a, b].sort());
    const counts = await queue.getJobCounts('completed', 'waiting', 'active', 'delayed');
    expect(counts).toEqual({ completed: 2, waiting: 0, active: 0, delayed: 0 });
  });

  it('failed handler retries then lands in failed set', async () => {
    let attempts = 0;
    registerEventHandler('session.created', 'flaky', async () => {
      attempts++;
      throw new Error('downstream unavailable');
    });
    const id = await record('session.created');
    await dispatchOnce({
      queue,
      jobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
    });
    await runWorker();

    await waitFor(async () => (await queue.getJobCounts('failed')).failed === 1);
    expect(attempts).toBe(2);
    const failed = await listFailedJobs(queue);
    expect(failed).toEqual([
      { id: `${id}__flaky`, handler: 'flaky', attempts: 2, error: 'downstream unavailable' },
    ]);
  });

  it('uses the default retry policy: 8 attempts, exponential backoff, kept on failure', async () => {
    registerEventHandler('session.created', 'audit', async () => {});
    const id = await record('session.created');
    await dispatchOnce({ queue });
    const job = await queue.getJob(`${id}__audit`);
    expect(job?.name).toBe('audit');
    expect(job?.data).toEqual({ eventId: id });
    expect(job?.opts).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: false,
    });
  });
});

describe('dispatch with Redis down', () => {
  let connection: Redis;
  let deadQueue: Queue;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Nothing listens on port 1: the queue connection never becomes ready.
    connection = createQueueConnection('redis://127.0.0.1:1');
    deadQueue = createEventsQueue({ connection, prefix });
    deadQueue.on('error', () => {});
  });
  afterEach(async () => {
    clearEventHandlers();
    connection.disconnect();
    vi.restoreAllMocks();
  });

  it('dispatchOnce fails within the enqueue timeout and leaves the outbox rows', async () => {
    registerEventHandler('session.created', 'audit', async () => {});
    const m = await createMerchant();
    await prisma.$transaction((tx) =>
      recordEvent(
        tx,
        { merchantId: m.id, livemode: false },
        {
          aggregateType: 'session',
          aggregateId: newId('ses'),
          type: 'session.created',
          payload: {},
        },
      ),
    );

    const started = Date.now();
    await expect(dispatchOnce({ queue: deadQueue })).rejects.toThrow('enqueue timed out');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(ENQUEUE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(ENQUEUE_TIMEOUT_MS + 1000);
    expect(await prisma.eventOutbox.count()).toBe(1);

    // A dispatcher stuck on the dead queue still stops within the enqueue timeout.
    const stop = startDispatcher(50, { queue: deadQueue });
    await sleep(100);
    const stopStarted = Date.now();
    await stop();
    expect(Date.now() - stopStarted).toBeLessThan(ENQUEUE_TIMEOUT_MS + 1000);
    expect(await prisma.eventOutbox.count()).toBe(1);
  }, 20_000);
});

describe('registerEventHandler', () => {
  afterEach(() => clearEventHandlers());

  it('rejects names that cannot form a BullMQ job id, and duplicates', () => {
    const fn = async (_e: Event) => {};
    expect(() => registerEventHandler('t', 'a__b', fn)).toThrow();
    expect(() => registerEventHandler('t', 'a:b', fn)).toThrow();
    expect(() => registerEventHandler('t', '', fn)).toThrow();
    registerEventHandler('t', 'ok', fn);
    expect(() => registerEventHandler('t', 'ok', fn)).toThrow();
  });
});

describe('purge-idempotency', () => {
  beforeEach(() => resetDb());

  it('deletes only expired idempotency keys', async () => {
    const m = await createMerchant();
    const row = (key: string, expiresAt: Date) => ({
      id: newId('idem'),
      merchantId: m.id,
      livemode: false,
      principalRef: 'secret_key:key_x',
      key,
      requestHash: 'h',
      lockedAt: new Date(),
      expiresAt,
    });
    await prisma.idempotencyKey.createMany({
      data: [row('old', new Date(Date.now() - 1000)), row('fresh', new Date(Date.now() + 60_000))],
    });
    expect(await purgeExpiredIdempotencyKeys()).toBe(1);
    expect((await prisma.idempotencyKey.findMany()).map((k) => k.key)).toEqual(['fresh']);
  });

  it('compares in UTC regardless of the session time zone', async () => {
    const m = await createMerchant();
    await prisma.idempotencyKey.create({
      data: {
        id: newId('idem'),
        merchantId: m.id,
        livemode: false,
        principalRef: 'secret_key:key_x',
        key: 'in-an-hour',
        requestHash: 'h',
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    // UTC+14: a bare now() would treat the UTC timestamp as local and see it as 13 h expired.
    const removed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`;
      return purgeExpiredIdempotencyKeys(tx);
    });
    expect(removed).toBe(0);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });
});

describe('worker health', () => {
  const get = async (port: number) => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it('is 200 when Postgres and Redis respond', async () => {
    const server = await startHealthServer({ port: 0, redisUrl: env().REDIS_URL });
    try {
      expect(await get(server.port)).toEqual({ status: 200, body: { status: 'ok' } });
    } finally {
      await server.close();
    }
  });

  it('worker health is 503 when Redis is down', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Nothing listens on port 1: every Redis command fails.
    const server = await startHealthServer({ port: 0, redisUrl: 'redis://127.0.0.1:1' });
    try {
      expect(await get(server.port)).toEqual({
        status: 503,
        body: { status: 'degraded', db: 'ok', redis: 'down' },
      });
    } finally {
      await server.close();
      vi.restoreAllMocks();
    }
  });
});
