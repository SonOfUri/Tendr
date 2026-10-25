// Store-side checkout session API (secret API keys only): create, read, cancel.
// `POST /v1/checkout/sessions` is idempotent through the gateway's `Idempotency-Key` layer.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  CreateSessionSchema,
  createSession,
  expireSession,
  sessionView,
  type CheckoutCtx,
} from '../checkout/sessions.js';
import { requirePrincipal } from '../gateway/principal.js';
import { unauthorized } from '../lib/errors.js';

const write = { principals: ['secret_key' as const], scope: 'sessions:write' as const };
const read = { principals: ['secret_key' as const], scope: 'sessions:read' as const };

function ctxOf(req: FastifyRequest): CheckoutCtx {
  const p = requirePrincipal(req);
  if (p.kind === 'user_session' || !req.db) throw unauthorized();
  return { merchantId: p.merchantId, livemode: p.livemode, db: req.db };
}

export const checkoutSessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/checkout/sessions', { config: { auth: write } }, async (req, reply) => {
    const ctx = ctxOf(req);
    const input = CreateSessionSchema.parse(req.body);
    return reply.status(201).send(await createSession(ctx, input));
  });

  app.get<{ Params: { id: string } }>(
    '/v1/checkout/sessions/:id',
    { config: { auth: read } },
    async (req) => sessionView(ctxOf(req), req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/v1/checkout/sessions/:id/expire',
    { config: { auth: write } },
    async (req) => expireSession(ctxOf(req), req.params.id),
  );
};
