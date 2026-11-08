import { AssistantInputSchema, RecommendationInputSchema } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { answerCheckout } from '../ai/assistant.js';
import { recommendRoutes } from '../ai/recommendations.js';
import { requirePrincipal } from '../gateway/principal.js';
import { unauthorized } from '../lib/errors.js';

function context(req: FastifyRequest) {
  const p = requirePrincipal(req);
  if (p.kind !== 'session_client') throw unauthorized();
  return { merchantId: p.merchantId, livemode: p.livemode, sessionId: p.sessionId };
}

const options = {
  config: { auth: { principals: ['session_client' as const] }, idempotency: false as const },
};

export const checkoutAiRoutes: FastifyPluginAsync = async (app) => {
  // Session secret determines the scope; no client-supplied session/account ids or chat history.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.post('/v1/checkout/client/ai/assistant', options, async (req) =>
    answerCheckout(context(req), AssistantInputSchema.parse(req.body)),
  );
  app.post('/v1/checkout/client/ai/recommendations', options, async (req) =>
    recommendRoutes(context(req), RecommendationInputSchema.parse(req.body)),
  );
};
