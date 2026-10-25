// Test helper: a Redis-backed simulated 1Click store on a key prefix unique to this test file and
// vitest worker, so test files never see or delete each other's simulated deposits (deposit
// addresses are deterministic) or locks.
//
//   const sim1click = isolatedSimStore();
//   beforeEach(() => sim1click.clear());
//   afterAll(() => sim1click.clear());
//   new SimulatedOneClick({ store: sim1click.store() });
//   // or, for code that calls providerFor(false):
//   resetOneClickProviders({ simulated: new SimulatedOneClick({ store: sim1click.store() }) });
import { randomBytes } from 'node:crypto';
import { RedisSimStore, SIM_KEY_PREFIX } from '../checkout/oneclick/sim-store.js';
import { getRedis, whenReady } from '../lib/redis.js';

export interface IsolatedSimStore {
  /** `sim1click:test:<pool id>:<random>:`. */
  prefix: string;
  /** A new store on the prefix; stores from one helper share state (like two processes). */
  store(): RedisSimStore;
  /** Deletes every key under the prefix (and nothing else). */
  clear(): Promise<void>;
}

export function isolatedSimStore(): IsolatedSimStore {
  const pool = process.env.VITEST_POOL_ID ?? '0';
  const prefix = `${SIM_KEY_PREFIX}test:${pool}:${randomBytes(6).toString('hex')}:`;
  return {
    prefix,
    store: () => new RedisSimStore({ keyPrefix: prefix }),
    async clear() {
      const redis = getRedis();
      await whenReady(redis);
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    },
  };
}
