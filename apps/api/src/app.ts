import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from './env.js';
import { auth } from './gateway/auth.js';
import { idempotency } from './gateway/idempotency.js';
import { createRateLimiters, type RateLimitKind } from './gateway/rate-limit.js';
import { closeClient, closeRedis, createRedis, getRedis, whenReady } from './lib/redis.js';
import { AppError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { pingRoutes } from './routes/ping.js';
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

export async function buildApp(opts: BuildAppOptions = {}) {
  const app = Fastify({
    logger: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
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

  const origins = env().CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: origins,
    credentials: true,
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
  opts.extraRoutes?.(app);

  return app;
}
