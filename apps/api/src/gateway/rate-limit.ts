// Redis-backed rate limits, one-minute windows.
//
//   ip_global       600 / IP          every /v1 route, BEFORE auth — bounds credential guessing
//   secret_key     1000 / key
//   publishable_key  60 / (key, IP)   one key is shared by every browser on a merchant's site
//   session_client  120 / session
//   public           60 / IP          routes declared `auth: 'public'`
//
// Counters are keyed by ids (principalRef) and IPs, never by raw credentials. Fails open:
// if Redis is unreachable the request is let through and a warning is logged.
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { isV1 } from './auth.js';
import { principalRef, type Principal } from './principal.js';

export const RATE_LIMIT_WINDOW_MS = 60_000;

export type RateLimitKind =
  | 'ip_global'
  | 'secret_key'
  | 'publishable_key'
  | 'session_client'
  | 'public';

export const DEFAULT_LIMITS: Record<RateLimitKind, number> = {
  ip_global: 600,
  secret_key: 1000,
  publishable_key: 60,
  session_client: 120,
  public: 60,
};

export type RateLimitOptions = {
  redis: Redis;
  /** Redis key prefix; tests use a unique one per app instance. */
  nameSpace?: string;
  overrides?: Partial<Record<RateLimitKind, number>>;
};

type Limiter = (req: FastifyRequest) => Promise<{
  isAllowed: boolean;
  max?: number;
  ttl?: number;
  ttlInSeconds?: number;
  remaining?: number;
  isExceeded?: boolean;
}>;

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Registers `@fastify/rate-limit` and returns two `onRequest` hooks. The caller must add
 * `ip` BEFORE the auth plugin and `principal` AFTER it (hooks run in registration order).
 */
export async function createRateLimiters(
  app: FastifyInstance,
  opts: RateLimitOptions,
): Promise<{ ip: Hook; principal: Hook }> {
  await app.register(rateLimit, {
    global: false,
    redis: opts.redis,
    nameSpace: opts.nameSpace ?? 'tendr:rl:',
    skipOnError: true,
  });
  const max = (kind: RateLimitKind) => opts.overrides?.[kind] ?? DEFAULT_LIMITS[kind];

  // The plugin's keyGenerator only receives the request, so the calling hook leaves the key here.
  const keys = new WeakMap<FastifyRequest, string>();
  const make = (kind: RateLimitKind): Limiter =>
    app.createRateLimit({
      max: max(kind),
      timeWindow: RATE_LIMIT_WINDOW_MS,
      keyGenerator: (req: FastifyRequest) => keys.get(req) ?? '',
    });
  const limiters: Record<RateLimitKind, Limiter> = {
    ip_global: make('ip_global'),
    secret_key: make('secret_key'),
    publishable_key: make('publishable_key'),
    session_client: make('session_client'),
    public: make('public'),
  };

  async function enforce(
    req: FastifyRequest,
    reply: FastifyReply,
    kind: RateLimitKind,
    key: string,
  ) {
    keys.set(req, key);
    const r = await limiters[kind](req);
    if (r.isAllowed) return;
    // A store failure is swallowed by `skipOnError`; it shows as a zero ttl (a live counter always has one).
    if (!r.ttl || r.ttl <= 0) {
      log('warn', 'rate limit store unavailable; failing open', { requestId: req.id, kind });
      return;
    }
    reply.header('ratelimit-limit', r.max);
    reply.header('ratelimit-remaining', r.isExceeded ? 0 : r.remaining);
    reply.header('ratelimit-reset', r.ttlInSeconds);
    if (r.isExceeded) {
      reply.header('retry-after', r.ttlInSeconds);
      throw new AppError('RATE_LIMITED', 'Too many requests', 429);
    }
  }

  return {
    ip: async (req, reply) => {
      if (!isV1(req.routeOptions.url)) return;
      await enforce(req, reply, 'ip_global', `ip:${req.ip}`);
    },
    principal: async (req, reply) => {
      if (!isV1(req.routeOptions.url)) return;
      const p = req.principal;
      if (!p) {
        if (req.routeOptions.config.auth === 'public') {
          await enforce(req, reply, 'public', `pub:${req.ip}`);
        }
        return;
      }
      await enforce(req, reply, principalKind(p), principalKey(p, req.ip));
    },
  };
}

function principalKind(p: Principal): Exclude<RateLimitKind, 'ip_global' | 'public'> {
  switch (p.kind) {
    case 'secret_key':
    case 'publishable_key':
    case 'session_client':
      return p.kind;
    default:
      // dashboard users and agents are not produced yet; give them the session-sized budget.
      return 'session_client';
  }
}

function principalKey(p: Principal, ip: string): string {
  const ref = `${p.kind}:${principalRef(p)}`;
  return p.kind === 'publishable_key' ? `${ref}:${ip}` : ref;
}
