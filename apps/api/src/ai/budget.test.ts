import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import { createRedis, whenReady, closeClient } from '../lib/redis.js';
import { reserveAiUsage } from './budget.js';

describe('AI usage reservations', () => {
  const redis = createRedis(env().REDIS_URL);
  // An isolated historical time window never shares counters with a running local application.
  const now = 100_000_000 + Math.floor(Math.random() * 100_000_000);
  const ctx = { merchantId: randomUUID(), sessionId: randomUUID(), livemode: false };
  beforeAll(async () => {
    await whenReady(redis);
  });
  afterAll(async () => {
    await redis.del(`tendr:ai:model:platform:${Math.floor(now / 86_400_000)}`);
    await closeClient(redis);
  });

  it('atomically caps concurrent model requests per session', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => reserveAiUsage(ctx, 'assistant', redis, now)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('shares the daily platform cap across all model features and live/test modes', async () => {
    const key = `tendr:ai:model:platform:${Math.floor(now / 86_400_000)}`;
    await redis.set(key, env().AI_DAILY_REQUEST_LIMIT, 'EX', 120);
    for (const livemode of [true, false]) {
      for (const kind of ['assistant', 'insights', 'theme'] as const) {
        await expect(
          reserveAiUsage({ ...ctx, sessionId: randomUUID(), livemode }, kind, redis, now),
        ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      }
    }
  });

  it('fails closed if Redis cannot reserve the budget', async () => {
    const spy = vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('unavailable'));
    await expect(reserveAiUsage(ctx, 'assistant', redis, now)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    spy.mockRestore();
  });
});
