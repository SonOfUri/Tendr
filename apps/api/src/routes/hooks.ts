// Integrator hook calls (project 5a, spec §4.3, §5), per mode.
// - `GET /v1/hook-calls` (filters `payment`, `session`, `status`; cursor `starting_after`): a
//   secret key with `payments:read`, or a dashboard user with `account:read`.
// - `POST /v1/payments/:id/hook/resend`: a secret key with `sessions:write`, or a dashboard user
//   with `webhooks:resend`. Allowed only after the call failed; refused (409) while one is in
//   flight, while it is still retrying by itself, or after it succeeded.
// Connected sites' keys (WooCommerce connections) are refused: hooks are an integrator feature.
// Publishable keys and session clients are refused by the gateway. Reads and writes go through
// the request's scoped client, so another store's or the other mode's calls are NOT_FOUND.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requirePrincipal } from '../gateway/principal.js';
import { HookCallListQuerySchema, listHookCalls, resendHookCall } from '../hooks/hooks.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { denied } from './merchant-settings.js';

const storeOrKey = { principals: ['dashboard_user' as const, 'secret_key' as const] };
const read = { ...storeOrKey, scope: 'payments:read' as const };
const resend = { ...storeOrKey, scope: 'sessions:write' as const };

/** The caller's tenant, after the per-principal permission checks the gateway leaves to us. */
function caller(req: FastifyRequest, permission: 'account:read' | 'webhooks:resend') {
  const p = requirePrincipal(req);
  if (p.kind === 'dashboard_user') {
    if (!p.permissions.includes(permission)) {
      throw denied(req, forbidden(`Missing permission ${permission}`));
    }
  } else if (p.kind !== 'secret_key') {
    throw unauthorized();
  } else if (p.connectionId) {
    throw denied(req, forbidden('A connected site cannot use integrator hooks'));
  }
  if (!req.db) throw unauthorized();
  return { merchantId: p.merchantId, livemode: p.livemode, db: req.db };
}

export const hookRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/hook-calls', { config: { auth: read } }, async (req) => {
    const c = caller(req, 'account:read');
    return listHookCalls(c.db, HookCallListQuerySchema.parse(req.query ?? {}));
  });

  app.post<{ Params: { id: string } }>(
    '/v1/payments/:id/hook/resend',
    { config: { auth: resend } },
    async (req) => resendHookCall(caller(req, 'webhooks:resend'), req.params.id),
  );
};
