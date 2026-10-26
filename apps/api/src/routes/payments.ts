// Dashboard payments (checkout Task 10): the list and the detail, `account:read`. Reads go through
// the request's scoped client, so another store's or the other mode's payments are NOT_FOUND.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getPayment, listPayments, PaymentListQuerySchema } from '../checkout/payment-views.js';
import { requireDashboardUser } from '../gateway/principal.js';
import { unauthorized } from '../lib/errors.js';

const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };

function dbOf(req: FastifyRequest) {
  requireDashboardUser(req);
  if (!req.db) throw unauthorized();
  return req.db;
}

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/payments', { config: { auth: read } }, async (req) =>
    listPayments(dbOf(req), PaymentListQuerySchema.parse(req.query ?? {})),
  );

  app.get<{ Params: { id: string } }>('/v1/payments/:id', { config: { auth: read } }, async (req) =>
    getPayment(dbOf(req), req.params.id),
  );
};
