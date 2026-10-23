import type { FastifyPluginAsync } from 'fastify';

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Tendr API',
    version: '0.1.0',
    description:
      'Tendr checkout and payment orchestration API. Sandbox mode does not move real funds.',
  },
  servers: [{ url: 'http://localhost:4000' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': { get: { summary: 'Liveness', security: [] } },
    '/ready': { get: { summary: 'Readiness', security: [] } },
    '/v1/checkout/sessions': {
      post: {
        summary: 'Create checkout session',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            schema: { type: 'string' },
          },
        ],
      },
    },
    '/v1/checkout/sessions/{sessionId}': { get: { summary: 'Retrieve checkout session' } },
    '/v1/checkout/sessions/{sessionId}/quote': { post: { summary: 'Create quote' } },
    '/v1/checkout/sessions/{sessionId}/confirm': { post: { summary: 'Confirm checkout' } },
    '/v1/payments/{paymentId}': { get: { summary: 'Retrieve payment' } },
    '/v1/merchants/me': { get: { summary: 'Current merchant' } },
    '/v1/merchants/me/payments': { get: { summary: 'List merchant payments' } },
    '/v1/webhooks/endpoints': {
      get: { summary: 'List webhook endpoints' },
      post: { summary: 'Create webhook endpoint' },
    },
    '/v1/webhooks/endpoints/{endpointId}/test': { post: { summary: 'Send test webhook' } },
  },
};

export const openapiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/openapi.json', async () => spec);
};
