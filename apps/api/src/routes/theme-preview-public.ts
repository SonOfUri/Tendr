// Public theme preview read (spec §10), no credential: `GET /v1/themes/preview/:token`.
// The token is the whole credential and expires after 15 minutes. It shares the public payment
// link read limits, is never cached and never indexed, and never creates a session.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readPreview } from '../themes/preview.js';

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type ThemePreviewPublicRouteOptions = { readRateLimit: Hook };

export const themePreviewPublicRoutes: FastifyPluginAsync<ThemePreviewPublicRouteOptions> = async (
  app,
  opts,
) => {
  const headers: Hook = async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
  };
  app.get<{ Params: { token: string } }>(
    '/v1/themes/preview/:token',
    {
      config: { auth: 'public' as const, publicLimit: 'route' as const },
      onRequest: [headers, opts.readRateLimit],
    },
    async (req) => readPreview(req.params.token),
  );
};
