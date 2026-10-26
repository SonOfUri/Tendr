// Redis-backed rate limits, one-minute windows.
//
//   ip_global      3000 / IP          every /v1 route, BEFORE auth — bounds credential guessing
//   secret_key     1000 / key
//   publishable_key  60 / (key, IP)   one key is shared by every browser on a merchant's site
//   session_client  120 / session
//   dashboard_user  600 / membership (person per store)
//   user_session    120 / person    (signed in, no store selected)
//   public           60 / IP          routes declared `auth: 'public'`
//   session_quote     8 / session     the shopper quote route only (route-level `sessionQuote`)
//   frame_origins    60 / session id  the public frame-origins route (C26), instead of `public`:
//                                     the web middleware calls it from one server IP
//   frame_origins_global 20000 / all  ceiling across every session id on that route
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
  | 'dashboard_user'
  | 'user_session'
  | 'public'
  /** Shopper quotes per session (each one calls 1Click and allocates a deposit address). */
  | 'session_quote'
  /** The public frame-origins route, per session id (C26). */
  | 'frame_origins'
  /** The public frame-origins route, across all session ids. */
  | 'frame_origins_global';

export const DEFAULT_LIMITS: Record<RateLimitKind, number> = {
  ip_global: 3000,
  secret_key: 1000,
  publishable_key: 60,
  session_client: 120,
  dashboard_user: 600,
  user_session: 120,
  public: 60,
  session_quote: 8,
  frame_origins: 60,
  frame_origins_global: 20_000,
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `'route'`: a public route that brings its own limiter (route-level hook) instead of the
     * per-IP `public` limit. The `ip_global` limit still applies.
     */
    publicLimit?: 'per_ip' | 'route';
  }
}

/** A session id as issued (`ses_` + ULID); anything else shares one bucket. */
const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

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
): Promise<{ ip: Hook; principal: Hook; sessionQuote: Hook; frameOrigins: Hook }> {
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
    dashboard_user: make('dashboard_user'),
    user_session: make('user_session'),
    public: make('public'),
    session_quote: make('session_quote'),
    frame_origins: make('frame_origins'),
    frame_origins_global: make('frame_origins_global'),
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
    /**
     * Route-level hook for the shopper quote route (after auth): `session_quote` per session.
     * Other principals pass through (the route refuses them anyway).
     */
    sessionQuote: async (req, reply) => {
      const p = req.principal;
      if (p?.kind !== 'session_client') return;
      await enforce(req, reply, 'session_quote', `quote:${p.sessionId}`);
    },
    /**
     * Route-level hook for `GET /v1/checkout/public/:sessionId/frame-origins` (C26): a global
     * ceiling, then `frame_origins` per session id. Malformed ids share one bucket.
     */
    frameOrigins: async (req, reply) => {
      await enforce(req, reply, 'frame_origins_global', 'fo:all');
      const id = (req.params as { sessionId?: string } | undefined)?.sessionId ?? '';
      await enforce(req, reply, 'frame_origins', `fo:${SESSION_ID.test(id) ? id : 'invalid'}`);
    },
    ip: async (req, reply) => {
      if (!isV1(req.routeOptions.url)) return;
      await enforce(req, reply, 'ip_global', `ip:${req.ip}`);
    },
    principal: async (req, reply) => {
      if (!isV1(req.routeOptions.url)) return;
      const p = req.principal;
      if (!p) {
        if (
          req.routeOptions.config.auth === 'public' &&
          req.routeOptions.config.publicLimit !== 'route'
        ) {
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
    case 'dashboard_user':
    case 'user_session':
      return p.kind;
    case 'agent':
      // Agents are not produced yet; give them the session-sized budget.
      return 'session_client';
  }
}

function principalKey(p: Principal, ip: string): string {
  const ref = `${p.kind}:${principalRef(p)}`;
  return p.kind === 'publishable_key' ? `${ref}:${ip}` : ref;
}
