import type { FastifyPluginAsync } from 'fastify';
import { requireDashboardUser } from '../gateway/principal.js';
import {
  ApiKeyCreateSchema,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
} from '../merchants/api-keys.js';

const manage = {
  principals: ['dashboard_user' as const],
  permission: 'settings:manage' as const,
};
const manageStepUp = { ...manage, stepUp: true };

export const apiKeyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/api_keys', { config: { auth: manage } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { merchantId, livemode } = requireDashboardUser(req);
    return { api_keys: await listApiKeys({ merchantId, livemode }) };
  });
  app.post(
    '/v1/api_keys',
    { config: { auth: manageStepUp, idempotency: false } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { merchantId, livemode, userId } = requireDashboardUser(req);
      const body = ApiKeyCreateSchema.parse(req.body);
      return reply.code(201).send(await issueApiKey({ merchantId, livemode }, userId, body));
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/v1/api_keys/:id',
    { config: { auth: manageStepUp } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { merchantId, livemode, userId } = requireDashboardUser(req);
      return revokeApiKey({ merchantId, livemode }, userId, req.params.id);
    },
  );
};
