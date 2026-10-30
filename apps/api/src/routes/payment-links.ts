// Merchant payment link API: create, list, read, update, archive.
// - A secret key needs `payment_links:read` / `payment_links:write` (checked by the gateway).
// - A dashboard user reads with `account:read` and writes with `money:request` (a link requests
//   money, so the finance role can make them); no step-up.
// - Bodies are strict: unknown keys, including `slug` on update, are a 400.
// - `POST` is idempotent through the gateway's `Idempotency-Key` layer.
import { PaymentLinkCreateSchema, PaymentLinkUpdateSchema } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePrincipal } from '../gateway/principal.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import {
  archiveLink,
  createLink,
  getLink,
  listLinks,
  updateLink,
  type LinkCtx,
} from '../payment-links/links.js';
import { denied } from './merchant-settings.js';

const principals = ['dashboard_user' as const, 'secret_key' as const];
const read = { principals, scope: 'payment_links:read' as const };
const write = { principals, scope: 'payment_links:write' as const };

const ListQuerySchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  include_archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().min(1).optional(),
});

function ctxOf(req: FastifyRequest, permission: 'account:read' | 'money:request'): LinkCtx {
  const p = requirePrincipal(req);
  if (!req.db) throw unauthorized();
  if (p.kind === 'dashboard_user') {
    if (!p.permissions.includes(permission)) {
      throw denied(req, forbidden(`Missing permission ${permission}`));
    }
  } else if (p.kind !== 'secret_key') {
    throw unauthorized();
  }
  return { merchantId: p.merchantId, livemode: p.livemode, db: req.db };
}

export const paymentLinkRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/payment_links', { config: { auth: write } }, async (req, reply) => {
    const ctx = ctxOf(req, 'money:request');
    const input = PaymentLinkCreateSchema.parse(req.body);
    return reply.status(201).send(await createLink(ctx, input));
  });

  app.get('/v1/payment_links', { config: { auth: read } }, async (req) => {
    const ctx = ctxOf(req, 'account:read');
    return listLinks(ctx, ListQuerySchema.parse(req.query ?? {}));
  });

  app.get<{ Params: { id: string } }>(
    '/v1/payment_links/:id',
    { config: { auth: read } },
    async (req) => getLink(ctxOf(req, 'account:read'), req.params.id),
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/payment_links/:id',
    { config: { auth: write } },
    async (req) => {
      const ctx = ctxOf(req, 'money:request');
      const input = PaymentLinkUpdateSchema.parse(req.body);
      return updateLink(ctx, req.params.id, input);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/payment_links/:id',
    { config: { auth: write } },
    async (req) => archiveLink(ctxOf(req, 'money:request'), req.params.id),
  );
};
