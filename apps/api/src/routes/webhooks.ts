// Merchant webhook endpoints (dashboard). Managing endpoints needs `settings:manage`; creating one
// or rotating its secret also needs a fresh passkey (step-up), since the response carries the
// signing secret — the only times it is ever shown. Resending a delivery needs `webhooks:resend`.
import { WebhookEventTypeSchema } from '@tendr/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  resendDelivery,
  rotateEndpointSecret,
  sendTestEvent,
} from '../checkout/webhooks.js';
import { requireDashboardUser } from '../gateway/principal.js';

const manage = {
  principals: ['dashboard_user' as const],
  permission: 'settings:manage' as const,
};
const manageStepUp = { ...manage, stepUp: true };
const resend = {
  principals: ['dashboard_user' as const],
  permission: 'webhooks:resend' as const,
};

const ctxOf = (req: Parameters<typeof requireDashboardUser>[0]) => {
  const p = requireDashboardUser(req);
  return { merchantId: p.merchantId, livemode: p.livemode };
};

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/webhooks/endpoints', { config: { auth: manageStepUp } }, async (req, reply) => {
    const body = z
      .object({
        url: z.string().min(1).max(2048),
        events: z.array(WebhookEventTypeSchema).max(32).optional(),
      })
      .strict()
      .parse(req.body);
    return reply.status(201).send(await createEndpoint(ctxOf(req), body));
  });

  app.get('/v1/webhooks/endpoints', { config: { auth: manage } }, async (req) => ({
    endpoints: await listEndpoints(ctxOf(req)),
  }));

  app.delete<{ Params: { id: string } }>(
    '/v1/webhooks/endpoints/:id',
    { config: { auth: manage } },
    async (req) => ({ ...(await deleteEndpoint(ctxOf(req), req.params.id)), deleted: true }),
  );

  app.post<{ Params: { id: string } }>(
    '/v1/webhooks/endpoints/:id/rotate',
    { config: { auth: manageStepUp } },
    async (req) => rotateEndpointSecret(ctxOf(req), req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/v1/webhooks/endpoints/:id/test',
    { config: { auth: manage } },
    async (req) => ({ delivery: await sendTestEvent(ctxOf(req), req.params.id) }),
  );

  app.get<{ Params: { id: string } }>(
    '/v1/webhooks/endpoints/:id/deliveries',
    { config: { auth: manage } },
    async (req) => ({ deliveries: await listDeliveries(ctxOf(req), req.params.id) }),
  );

  app.post<{ Params: { id: string } }>(
    '/v1/webhooks/deliveries/:id/resend',
    { config: { auth: resend } },
    async (req) => ({ delivery: await resendDelivery(ctxOf(req), req.params.id) }),
  );
};
