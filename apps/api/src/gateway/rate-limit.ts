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
//   connect_token    10 / IP          `POST /v1/connect/token` (public), instead of `public`
//   notification_email_verify 10 / IP `POST /v1/settings/notification-email/verify` (public),
//                                     instead of `public`
//   payment_link_read    120 / IP     the public payment-link read, instead of `public`
//   payment_link_read_global 20000 / all  ceiling across every payer on that route
//   payment_link_session  10 / IP     the public "Pay" route (session from a link)
//   payment_link_session_link 3 / (IP, link) per 5 minutes, on that route too
//
// On the payment-link routes "IP" is the payer's: `internalClient(req).clientIp`, which is
// `req.ip` unless the web server presents its internal token with the payer's address on a
// `GET /v1/payment_links/public/...` read (internal-client.ts). Such trusted reads skip
// `ip_global` (the server's own address would trip it for everyone); `payment_link_read` keys on
// the payer's IP, so a leaked token never lifts per-payer limits. Every other route ignores the
// internal headers and keys on `req.ip`.
//
// Counters are keyed by ids (principalRef) and IPs, never by raw credentials. Fails open:
// if Redis is unreachable the request is let through and a warning is logged.
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { isV1 } from './auth.js';
import { internalClient } from './internal-client.js';
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
  | 'frame_origins_global'
  /** The Connect code exchange, per IP. */
  | 'connect_token'
  /** The notification-email verify link, per IP. */
  | 'notification_email_verify'
  /** The public payment-link read, per payer IP. */
  | 'payment_link_read'
  /** The public payment-link read, across all payers. */
  | 'payment_link_read_global'
  /** Sessions from payment links, per payer IP. */
  | 'payment_link_session'
  /** Sessions from payment links, per (payer IP, link), over `PAYMENT_LINK_SESSION_LINK_WINDOW_MS`. */
  | 'payment_link_session_link';

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
  connect_token: 10,
  notification_email_verify: 10,
  payment_link_read: 120,
  payment_link_read_global: 20_000,
  payment_link_session: 10,
  payment_link_session_link: 3,
};

/** The window of `payment_link_session_link` (every other kind uses one minute). */
export const PAYMENT_LINK_SESSION_LINK_WINDOW_MS = 5 * 60_000;

const WINDOW_MS: Partial<Record<RateLimitKind, number>> = {
  payment_link_session_link: PAYMENT_LINK_SESSION_LINK_WINDOW_MS,
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
): Promise<{
  ip: Hook;
  principal: Hook;
  sessionQuote: Hook;
  frameOrigins: Hook;
  connectToken: Hook;
  notificationEmailVerify: Hook;
  paymentLinkRead: Hook;
  paymentLinkSession: Hook;
}> {
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
      timeWindow: WINDOW_MS[kind] ?? RATE_LIMIT_WINDOW_MS,
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
    connect_token: make('connect_token'),
    notification_email_verify: make('notification_email_verify'),
    payment_link_read: make('payment_link_read'),
    payment_link_read_global: make('payment_link_read_global'),
    payment_link_session: make('payment_link_session'),
    payment_link_session_link: make('payment_link_session_link'),
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
    /** Route-level hook for `POST /v1/connect/token`: `connect_token` per IP. */
    connectToken: async (req, reply) => {
      await enforce(req, reply, 'connect_token', `ct:${req.ip}`);
    },
    /** Route-level hook for the notification-email verify link: per IP. */
    notificationEmailVerify: async (req, reply) => {
      await enforce(req, reply, 'notification_email_verify', `nev:${req.ip}`);
    },
    /**
     * Route-level hook for `GET /v1/payment_links/public/:merchant/:link`: a global ceiling, then
     * `payment_link_read` per payer IP.
     */
    paymentLinkRead: async (req, reply) => {
      await enforce(req, reply, 'payment_link_read_global', 'plr:all');
      await enforce(req, reply, 'payment_link_read', `plr:${internalClient(req).clientIp}`);
    },
    /**
     * Route-level hook for `POST /v1/payment_links/public/:merchant/:link/sessions`:
     * `payment_link_session` per payer IP, then `payment_link_session_link` per (IP, link).
     */
    paymentLinkSession: async (req, reply) => {
      const ip = internalClient(req).clientIp;
      await enforce(req, reply, 'payment_link_session', `pls:${ip}`);
      await enforce(req, reply, 'payment_link_session_link', `plsl:${ip}:${linkKey(req)}`);
    },
    ip: async (req, reply) => {
      if (!isV1(req.routeOptions.url)) return;
      if (internalClient(req).trusted) return;
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

/** Slug-shaped params only; anything else (never a real link) shares one bucket per IP. */
const SLUG = /^[a-z0-9-]{1,64}$/;

/** The link a payer is paying: merchant slug, link slug and mode. */
function linkKey(req: FastifyRequest): string {
  const { merchant = '', link = '' } = (req.params ?? {}) as { merchant?: string; link?: string };
  if (!SLUG.test(merchant) || !SLUG.test(link)) return 'invalid';
  const test = (req.query as { mode?: unknown } | undefined)?.mode === 'test';
  return `${merchant}/${link}${test ? ':test' : ''}`;
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
