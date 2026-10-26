import cors from '@fastify/cors';
import { Prisma } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from './env.js';
import { auth } from './gateway/auth.js';
import { idempotency } from './gateway/idempotency.js';
import { createRateLimiters, type RateLimitKind } from './gateway/rate-limit.js';
import { closeClient, closeRedis, createRedis, getRedis, whenReady } from './lib/redis.js';
import { AppError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import {
  CHECKOUT_CLIENT_PREFIX,
  CHECKOUT_REFUND_ADDRESS_PATH,
  checkoutClientRoutes,
} from './routes/checkout-client.js';
import { checkoutSessionRoutes } from './routes/checkout-sessions.js';
import { healthRoutes } from './routes/health.js';
import { merchantRoutes } from './routes/merchants.js';
import { pingRoutes } from './routes/ping.js';
import { proposalRoutes } from './routes/proposals.js';
import { recoveryRoutes } from './routes/recovery.js';
import { teamRoutes } from './routes/team.js';
import { webhookRoutes } from './routes/webhooks.js';
import { randomUUID } from 'node:crypto';

export type BuildAppOptions = {
  /** Extra routes (tests); registered after the auth plugin so they get the same checks. */
  extraRoutes?: (app: FastifyInstance) => void;
  /** Per-minute limit overrides (tests). */
  rateLimitOverrides?: Partial<Record<RateLimitKind, number>>;
  /** Redis URL for this app instance only (tests); default is the shared `REDIS_URL` client. */
  redisUrl?: string;
  /** Redis key prefix for rate-limit counters (tests isolate runs with a unique one). */
  rateLimitNamespace?: string;
};

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The request id: the client's `x-request-id` when it is a safe token (≤128 chars of
 * `[A-Za-z0-9._:-]`), otherwise a fresh UUID. It is echoed in a header and written to logs, so
 * arbitrary client bytes (newlines, huge values) are never taken as-is.
 */
export function requestIdFor(header: unknown): string {
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

/**
 * Prisma errors a route can trigger by input alone, mapped to fixed public messages so a
 * unique-violation or missing-row probe is a 4xx without internal details, never a 500.
 */
const PRISMA_ERRORS: Partial<
  Record<string, { status: number; code: 'CONFLICT' | 'NOT_FOUND'; message: string }>
> = {
  P2002: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
};

export async function buildApp(opts: BuildAppOptions = {}) {
  const app = Fastify({
    logger: false,
    // Fastify would take the header verbatim; `genReqId` validates it instead.
    requestIdHeader: false,
    genReqId: (req) => requestIdFor(req.headers['x-request-id']),
    bodyLimit: 1_048_576,
    // Trust exactly one proxy hop (Railway's edge): `req.ip` is the address that proxy appended to
    // X-Forwarded-For, which a client cannot forge. `true` would trust the whole header, letting any
    // client pick its own IP (and dodge per-IP limits). Without a proxy (local dev) a client can
    // still spoof X-Forwarded-For, which is harmless there.
    trustProxy: (_addr: string, hop: number) => hop < 1,
  });

  const redis = opts.redisUrl ? createRedis(opts.redisUrl) : getRedis();
  app.addHook('onClose', async () => {
    if (opts.redisUrl) await closeClient(redis);
    else await closeRedis();
  });
  // Commands fail fast while connecting (no offline queue); give the client a moment to be ready.
  await whenReady(redis);
  const limiters = await createRateLimiters(app, {
    redis,
    // Tests get a private keyspace per app so runs never share counters.
    nameSpace:
      opts.rateLimitNamespace ??
      (process.env.NODE_ENV === 'test' ? `tendr:rl:test:${randomUUID()}:` : undefined),
    overrides: opts.rateLimitOverrides,
  });

  const origins = env()
    .CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // The hosted checkout calls only the shopper routes, with a Bearer client secret: its origin is
  // allowed there and nowhere else, and without credentials, so scripts on the checkout page
  // (third-party wallet SDKs) can never make cookie-authenticated dashboard calls.
  const checkoutOrigin = new URL(env().CHECKOUT_BASE_URL).origin;
  await app.register(cors, {
    delegator: (req, cb) => {
      const url = req.url ?? '';
      if (
        url.startsWith(CHECKOUT_CLIENT_PREFIX) ||
        url.split('?')[0] === CHECKOUT_REFUND_ADDRESS_PATH
      ) {
        cb(null, { origin: [checkoutOrigin], credentials: false });
      } else {
        cb(null, { origin: origins, credentials: true });
      }
    },
  });

  // JSON only: Fastify's default text/plain parser would deliver bodies that signing never covers.
  app.removeContentTypeParser('text/plain');
  // Keep the raw bytes for request-signature verification, then parse as JSON.
  // Parsing uses Fastify's own secure parser: `__proto__` / `constructor.prototype` keys are rejected.
  const secureJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, undefined);
    secureJson(req, buf.toString('utf8'), (err, parsed) => {
      if (err) {
        return done(
          Object.assign(new Error('Invalid JSON body'), {
            code: 'FST_ERR_CTP_INVALID_JSON_BODY',
            statusCode: 400,
          }),
          undefined,
        );
      }
      done(null, parsed);
    });
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          requestId,
          details: error.flatten(),
        },
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          requestId,
          details: error.details,
        },
      });
    }
    const mapped =
      error instanceof Prisma.PrismaClientKnownRequestError ? PRISMA_ERRORS[error.code] : undefined;
    if (mapped) {
      return reply.status(mapped.status).send({
        error: { code: mapped.code, message: mapped.message, requestId },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          requestId,
        },
      });
    }
    // Fastify-native client errors (bad JSON, 413, 415, ...) keep their status.
    const { statusCode: status, code } = error as { statusCode?: number; code?: unknown };
    if (
      typeof code === 'string' &&
      code.startsWith('FST_') &&
      status !== undefined &&
      status >= 400 &&
      status < 500
    ) {
      const messages: Record<number, string> = {
        400: 'Invalid request',
        413: 'Request body too large',
        415: 'Unsupported content type',
      };
      return reply.status(status).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: messages[status] ?? 'Invalid request',
          requestId,
        },
      });
    }
    log('error', 'unhandled error', {
      requestId,
      err: String(error),
    });
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId,
      },
    });
  });

  // Per-IP limit first so failed authentication is throttled; the per-principal one after auth.
  app.addHook('onRequest', limiters.ip);
  await app.register(auth);
  app.addHook('onRequest', limiters.principal);
  // preHandler: after auth and the signature check (preValidation).
  await app.register(idempotency);
  await app.register(healthRoutes);
  await app.register(pingRoutes);
  await app.register(authRoutes);
  await app.register(merchantRoutes);
  await app.register(teamRoutes);
  await app.register(proposalRoutes);
  await app.register(accountRoutes);
  await app.register(recoveryRoutes);
  await app.register(checkoutSessionRoutes);
  await app.register(checkoutClientRoutes, { quoteRateLimit: limiters.sessionQuote });
  await app.register(webhookRoutes);
  opts.extraRoutes?.(app);

  return app;
}
