// Public payment link routes (spec §5), no credential:
// - `GET  /v1/payment_links/public/:merchant/:link`          what the payer's page shows
// - `POST /v1/payment_links/public/:merchant/:link/sessions` "Pay": a checkout session,
//   `{ url, expires_at }`
// `?mode=test` addresses a test link; without it only live links resolve. Both bring their own
// rate limits (rate-limit.ts: per payer IP, a global read ceiling, and per IP per link for "Pay")
// and are never cached.
import { PublicLinkSessionInputSchema } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { internalClient } from '../gateway/internal-client.js';
import { createLinkSession, getPublicLink } from '../payment-links/public.js';

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type PaymentLinkPublicRouteOptions = { readRateLimit: Hook; sessionRateLimit: Hook };

type Req = FastifyRequest<{
  Params: { merchant: string; link: string };
  Querystring: { mode?: string };
}>;

const livemodeOf = (req: Req) => req.query?.mode !== 'test';

export const PAYMENT_LINK_PUBLIC_PREFIX = '/v1/payment_links/public/';

export const paymentLinkPublicRoutes: FastifyPluginAsync<PaymentLinkPublicRouteOptions> = async (
  app,
  opts,
) => {
  // Payer-specific (availability, rates) and never shared between payers: never cached, errors
  // included.
  const noStore: Hook = async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  };
  const config = { auth: 'public' as const, publicLimit: 'route' as const };

  app.get<{ Params: { merchant: string; link: string }; Querystring: { mode?: string } }>(
    '/v1/payment_links/public/:merchant/:link',
    { config, onRequest: [noStore, opts.readRateLimit] },
    async (req) => getPublicLink(req.params.merchant, req.params.link, livemodeOf(req)),
  );

  app.post<{ Params: { merchant: string; link: string }; Querystring: { mode?: string } }>(
    '/v1/payment_links/public/:merchant/:link/sessions',
    { config, onRequest: [noStore, opts.sessionRateLimit] },
    async (req, reply) => {
      const input = PublicLinkSessionInputSchema.parse(req.body ?? {});
      const out = await createLinkSession(
        req.params.merchant,
        req.params.link,
        livemodeOf(req),
        input,
        internalClient(req).clientIp,
      );
      return reply.status(201).send(out);
    },
  );
};
