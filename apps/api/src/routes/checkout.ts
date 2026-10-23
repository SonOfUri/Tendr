import type { FastifyPluginAsync } from 'fastify';
import { requireMerchant } from '../plugins/auth.js';
import {
  confirmCheckout,
  createCheckoutSession,
  createQuote,
  getCheckoutSession,
} from '../services/checkout.js';

export const checkoutRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/checkout/sessions', async (request, reply) => {
    const auth = requireMerchant(request);
    const idempotencyKey = request.headers['idempotency-key'];
    const key = typeof idempotencyKey === 'string' ? idempotencyKey : undefined;
    const result = await createCheckoutSession(auth.merchantId, request.body, key);
    return reply.status(result.statusCode).send(result.body);
  });

  app.get('/v1/checkout/sessions/:sessionId', async (request) => {
    const auth = requireMerchant(request);
    const { sessionId } = request.params as { sessionId: string };
    return getCheckoutSession(auth.merchantId, sessionId);
  });

  app.post('/v1/checkout/sessions/:sessionId/quote', async (request) => {
    const auth = requireMerchant(request);
    const { sessionId } = request.params as { sessionId: string };
    return createQuote(auth.merchantId, sessionId, request.body);
  });

  app.post('/v1/checkout/sessions/:sessionId/confirm', async (request) => {
    const auth = requireMerchant(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as { quoteId?: string };
    if (!body?.quoteId) {
      const { AppError } = await import('../lib/errors.js');
      throw new AppError('VALIDATION_ERROR', 'quoteId is required', 400);
    }
    return confirmCheckout(auth.merchantId, sessionId, body.quoteId);
  });
};
