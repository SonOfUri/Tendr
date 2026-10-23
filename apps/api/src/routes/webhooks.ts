import { CreateWebhookEndpointRequestSchema } from '@tendr/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { requireMerchant } from '../plugins/auth.js';
import { enqueueWebhook, generateWebhookSecret } from '../services/webhooks.js';

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/webhooks/endpoints', async (request, reply) => {
    const auth = requireMerchant(request);
    const body = CreateWebhookEndpointRequestSchema.parse(request.body);
    const url = new URL(body.url);
    if (env().NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new AppError('VALIDATION_ERROR', 'Webhook URL must be HTTPS in production', 400);
    }
    const secret = generateWebhookSecret();
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        merchantId: auth.merchantId,
        url: body.url,
        description: body.description,
        secretHash: secret.hash,
        secretPreview: secret.preview,
      },
    });
    return reply.status(201).send({
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description,
      enabled: endpoint.enabled,
      createdAt: endpoint.createdAt.toISOString(),
      secret: secret.raw,
      warning: 'Store this secret now. It is shown only once.',
    });
  });

  app.get('/v1/webhooks/endpoints', async (request) => {
    const auth = requireMerchant(request);
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { merchantId: auth.merchantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return {
      data: endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        description: e.description,
        enabled: e.enabled,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  app.post('/v1/webhooks/endpoints/:endpointId/test', async (request) => {
    const auth = requireMerchant(request);
    const { endpointId } = request.params as { endpointId: string };
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, merchantId: auth.merchantId, deletedAt: null },
    });
    if (!endpoint) {
      throw new AppError('NOT_FOUND', 'Webhook endpoint not found', 404);
    }
    await enqueueWebhook(auth.merchantId, 'checkout.session.created', {
      test: true,
      endpointId,
      message: 'Tendr webhook test event',
    });
    return { ok: true, message: 'Test event enqueued' };
  });
};
