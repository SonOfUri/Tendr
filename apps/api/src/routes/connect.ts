// Connect routes (WooCommerce plugin spec §2, §3 "Go live"):
// - `POST /v1/connect/authorize` — the approval screen: owner/admin (`settings:manage`) with a fresh
//   passkey (step-up). Creates the connection and a single-use code; the response is the redirect.
// - `POST /v1/connect/token` — public, server to server, 10 / minute / IP. Code + PKCE verifier +
//   site → the connection's credentials, once. Every failure is the same INVALID_GRANT.
// - `GET /v1/connect/status`, `POST /v1/connect/disconnect`, `POST /v1/connect/replace` — a
//   connection key only (ruling W1: a `secret_key` whose api key row has `connection_id`; any other
//   secret key is 403). `replace` is called with the OLD connection's key after a re-connect at a
//   new site address (A3).
// - `GET /v1/connections`, `DELETE /v1/connections/:id` — the dashboard's Connected sites
//   (`settings:manage`; removing needs step-up).
import { ConnectAuthorizeRequestSchema } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  authorize,
  connectStatus,
  disconnect,
  invalidGrant,
  listConnections,
  redeem,
  removeConnection,
  replaceConnection,
} from '../connect/authorize.js';
import { requireDashboardUser, requirePrincipal } from '../gateway/principal.js';
import { AppError, forbidden, prismaErrorFor, unauthorized } from '../lib/errors.js';
import { log } from '../lib/logger.js';

const manage = {
  principals: ['dashboard_user' as const],
  permission: 'settings:manage' as const,
};
const manageStepUp = { ...manage, stepUp: true };
const connectionKey = { principals: ['secret_key' as const] };

/** The request's connection key; 403 for a secret key the store created by hand. */
function connectionCtx(req: FastifyRequest) {
  const p = requirePrincipal(req);
  if (p.kind !== 'secret_key' || !req.db) throw unauthorized();
  if (!p.connectionId) throw forbidden('This endpoint needs a connection key');
  return {
    merchantId: p.merchantId,
    livemode: p.livemode,
    db: req.db,
    connectionId: p.connectionId,
  };
}

export const TOKEN_BODY_LIMIT = 16_384;

/**
 * `/v1/connect/token` answers every client failure with the same INVALID_GRANT, transport-level
 * ones included (unparseable JSON, a missing or wrong content type, a body over the limit), so
 * nothing distinguishes one cause from another; so are the Prisma errors the global handler maps
 * to a 4xx (`PRISMA_ERRORS`). A rate limit stays 429 (RATE_LIMITED); server
 * errors are logged without the body and stay 500.
 */
function tokenErrorHandler(error: unknown, req: FastifyRequest, reply: FastifyReply) {
  const requestId = req.id;
  // C8: a Prisma error a request can cause by itself (PRISMA_ERRORS) is a client failure too.
  const status =
    error instanceof AppError
      ? error.status
      : (prismaErrorFor(error)?.status ?? (error as { statusCode?: number }).statusCode);
  if (status === 429) {
    return reply.status(429).send({
      error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId },
    });
  }
  if (error instanceof ZodError || (status !== undefined && status >= 400 && status < 500)) {
    const e = invalidGrant();
    return reply.status(e.status).send({ error: { code: e.code, message: e.message, requestId } });
  }
  log('error', 'connect token failed', { requestId, err: String(error) });
  return reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
  });
}

export type ConnectRouteOptions = {
  /** Per-IP limiter for `/v1/connect/token` (`createRateLimiters().connectToken`). */
  tokenRateLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const connectRoutes: FastifyPluginAsync<ConnectRouteOptions> = async (app, opts) => {
  app.post('/v1/connect/authorize', { config: { auth: manageStepUp } }, async (req) => {
    const p = requireDashboardUser(req);
    const input = ConnectAuthorizeRequestSchema.parse(req.body);
    return authorize({ merchantId: p.merchantId, userId: p.userId }, input);
  });

  // Limited before the body is read (`onRequest`), instead of the generic per-IP public limit.
  app.post(
    '/v1/connect/token',
    {
      config: { auth: 'public', publicLimit: 'route' },
      onRequest: opts.tokenRateLimit,
      // The request is a few hundred bytes; anything larger is not a grant.
      bodyLimit: TOKEN_BODY_LIMIT,
      errorHandler: tokenErrorHandler,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return redeem(req.body);
    },
  );

  app.get('/v1/connect/status', { config: { auth: connectionKey } }, async (req) =>
    connectStatus(connectionCtx(req)),
  );

  app.post('/v1/connect/disconnect', { config: { auth: connectionKey } }, async (req, reply) => {
    await disconnect(connectionCtx(req).connectionId);
    return reply.status(204).send();
  });

  // A3: the site re-connected at a new address; its OLD connection key hands its orders over.
  app.post('/v1/connect/replace', { config: { auth: connectionKey } }, async (req) =>
    replaceConnection(connectionCtx(req), req.body),
  );

  app.get('/v1/connections', { config: { auth: manage } }, async (req) => ({
    connections: await listConnections(requireDashboardUser(req).merchantId),
  }));

  app.delete<{ Params: { id: string } }>(
    '/v1/connections/:id',
    { config: { auth: manageStepUp } },
    async (req) => removeConnection(requireDashboardUser(req).merchantId, req.params.id),
  );
};
