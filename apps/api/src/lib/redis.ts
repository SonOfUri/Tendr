import { Redis } from 'ioredis';
import { env } from '../env.js';
import { log } from './logger.js';

/**
 * A Redis client that fails fast instead of queueing: with Redis down, commands reject at once
 * so callers can fail open rather than hang.
 */
export function createRedis(url: string): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  // Without a listener ioredis would print every connection error; log them at `warn`.
  client.on('error', (err) => log('warn', 'redis error', { err: String(err) }));
  return client;
}

let shared: Redis | null = null;

/** The process-wide client, built from `REDIS_URL` on first use. */
export function getRedis(): Redis {
  shared ??= createRedis(env().REDIS_URL);
  return shared;
}

export async function closeRedis(): Promise<void> {
  const client = shared;
  shared = null;
  if (client) await closeClient(client);
}

/** Closes any client; a connection that is already down is not an error. */
export async function closeClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

/** Resolves once the client is ready, or after `timeoutMs` (Redis down must not block startup). */
export function whenReady(client: Redis, timeoutMs = 2000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      client.off('ready', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    client.once('ready', done);
  });
}
