import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { env } from './env.js';
import { AppError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { authPlugin } from './plugins/auth.js';
import { checkoutRoutes } from './routes/checkout.js';
import { healthRoutes } from './routes/health.js';
import { openapiRoutes } from './routes/openapi.js';
import { paymentRoutes } from './routes/payments.js';
import { webhookRoutes } from './routes/webhooks.js';
import { randomUUID } from 'node:crypto';

export async function buildApp() {
  const app = Fastify({
    logger: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
  });

  const origins = env().CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: origins,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
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

  await app.register(healthRoutes);
  await app.register(openapiRoutes);
  await app.register(authPlugin);
  await app.register(checkoutRoutes);
  await app.register(paymentRoutes);
  await app.register(webhookRoutes);

  return app;
}
