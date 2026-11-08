import { AiThemeInputSchema, InsightInputSchema, InsightQuerySchema } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { explainInsights, merchantInsights } from '../ai/insights.js';
import { generateThemeDraft } from '../ai/theme-drafts.js';
import { requireDashboardUser } from '../gateway/principal.js';
import { createThemeFromDocument } from '../themes/themes.js';
import { ctxOf } from './themes.js';

const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };
const write = { principals: ['dashboard_user' as const], permission: 'settings:manage' as const };
function context(req: FastifyRequest) {
  const p = requireDashboardUser(req);
  return { merchantId: p.merchantId, livemode: p.livemode, actorId: p.membershipId };
}

export const merchantAiRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.get('/v1/ai/insights', { config: { auth: read } }, async (req) => {
    const query = InsightQuerySchema.parse(req.query);
    return merchantInsights(context(req), query.days);
  });
  app.post('/v1/ai/insights', { config: { auth: read, idempotency: false } }, async (req) =>
    explainInsights(context(req), InsightInputSchema.parse(req.body ?? {})),
  );
  app.post('/v1/ai/themes', { config: { auth: write } }, async (req, reply) => {
    // A retried generation must replay its saved draft instead of creating another one.
    z.string().min(1).max(255).parse(req.headers['idempotency-key']);
    const ctx = context(req);
    const themeCtx = ctxOf(req, 'settings:manage');
    const input = AiThemeInputSchema.parse(req.body);
    const document = await generateThemeDraft(ctx, input);
    const theme = await createThemeFromDocument(themeCtx, { name: input.name, document });
    return reply
      .status(201)
      .send({ theme, source: 'model_generated_draft', requires_publish: true });
  });
};
