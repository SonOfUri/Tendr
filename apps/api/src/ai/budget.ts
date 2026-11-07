import type { Redis } from 'ioredis';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { getRedis } from '../lib/redis.js';
import type { ScopeContext } from '../db/scoped.js';

export type AiUsageContext = ScopeContext & ({ sessionId: string } | { actorId: string });
export type AiUsageKind = 'assistant' | 'recommendations' | 'insights' | 'theme';

// One atomic reservation across the session, merchant and platform. Fail closed on Redis failure.
const RESERVE = `
for i, key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') >= tonumber(ARGV[i]) then return 0 end
end
for i, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('EXPIRE', key, i == 3 and tonumber(ARGV[4]) or 120) end
end
return 1`;

export async function reserveAiUsage(
  ctx: AiUsageContext,
  kind: AiUsageKind,
  redis: Redis = getRedis(),
  now = Date.now(),
) {
  const modelCall = kind !== 'recommendations';
  const pool = modelCall ? 'model' : 'recommendations';
  const actor = 'sessionId' in ctx ? ctx.sessionId : ctx.actorId;
  const minute = Math.floor(now / 60_000);
  const platformWindow = modelCall ? Math.floor(now / 86_400_000) : minute;
  let allowed: unknown;
  try {
    allowed = await redis.eval(
      RESERVE,
      3,
      `tendr:ai:${kind}:actor:${actor}:${minute}`,
      `tendr:ai:${pool}:merchant:${ctx.merchantId}:${minute}`,
      `tendr:ai:${pool}:platform:${platformWindow}`,
      kind === 'theme' || !modelCall ? 3 : 6,
      30,
      modelCall ? env().AI_DAILY_REQUEST_LIMIT : 120,
      modelCall ? 90000 : 120,
    );
  } catch {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'AI usage controls are unavailable; try again later',
      503,
    );
  }
  if (Number(allowed) !== 1)
    throw new AppError('RATE_LIMITED', 'AI request limit reached; try again later', 429);
}
