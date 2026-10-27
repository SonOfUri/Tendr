// Gas policy, usage and sponsorship records (project 5a, spec §5), per mode.
// - A secret key reads and changes the policy. A connected site's key (a `secret_key` with
//   `connection_id`) reads the policy, usage and records but cannot change the policy (403).
// - A dashboard user reads with `account:read`; changing the policy needs `settings:manage` and
//   step-up (the policy decides how much of the store's money Tendr may spend on gas).
// - The sponsorship list needs `payments:read` of an API key.
// - Publishable keys and session clients are refused by the gateway.
//
// The auth config admits both principal kinds, so the dashboard permission and step-up checks are
// made here (the gateway only checks permissions on dashboard-only routes).
import { GasUsageQuerySchema } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requirePrincipal, requireStepUp } from '../gateway/principal.js';
import {
  type GasPolicyActor,
  currentMonth,
  gasUsage,
  getGasPolicy,
  putGasPolicy,
} from '../gas/policy.js';
import { GasSponsorshipListQuerySchema, listGasSponsorships } from '../gas/sponsorships.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { check, denied } from './merchant-settings.js';

const storeOrKey = { principals: ['dashboard_user' as const, 'secret_key' as const] };
const records = { ...storeOrKey, scope: 'payments:read' as const };

type Caller = { merchantId: string; livemode: boolean };

/** Any dashboard member with `account:read`, or any secret key (connection keys included). */
function reader(req: FastifyRequest): Caller {
  const p = requirePrincipal(req);
  if (p.kind === 'dashboard_user') {
    if (!p.permissions.includes('account:read')) {
      throw denied(req, forbidden('Missing permission account:read'));
    }
    return { merchantId: p.merchantId, livemode: p.livemode };
  }
  if (p.kind !== 'secret_key') throw unauthorized();
  return { merchantId: p.merchantId, livemode: p.livemode };
}

/** A dashboard user with `settings:manage` and step-up, or a secret key the store made. */
function writer(req: FastifyRequest): Caller & { actor: GasPolicyActor } {
  const p = requirePrincipal(req);
  if (p.kind === 'dashboard_user') {
    if (!p.permissions.includes('settings:manage')) {
      throw denied(req, forbidden('Missing permission settings:manage'));
    }
    check(req, () => requireStepUp(req));
    return {
      merchantId: p.merchantId,
      livemode: p.livemode,
      actor: { by: 'user', userId: p.userId },
    };
  }
  if (p.kind !== 'secret_key') throw unauthorized();
  if (p.connectionId) {
    throw denied(req, forbidden('A connected site can read the gas policy but not change it'));
  }
  return {
    merchantId: p.merchantId,
    livemode: p.livemode,
    actor: { by: 'api_key', apiKeyId: p.apiKeyId },
  };
}

export const gasRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/gas-policy', { config: { auth: storeOrKey } }, async (req) => {
    const c = reader(req);
    return getGasPolicy(c.merchantId, c.livemode);
  });

  app.put('/v1/gas-policy', { config: { auth: storeOrKey } }, async (req) => {
    const c = writer(req);
    return putGasPolicy(c, req.body);
  });

  app.get('/v1/gas-policy/usage', { config: { auth: storeOrKey } }, async (req) => {
    const c = reader(req);
    const q = GasUsageQuerySchema.parse(req.query ?? {});
    return gasUsage(c.merchantId, c.livemode, q.month ?? currentMonth());
  });

  app.get('/v1/gas-sponsorships', { config: { auth: records } }, async (req) => {
    reader(req);
    if (!req.db) throw unauthorized();
    return listGasSponsorships(req.db, GasSponsorshipListQuerySchema.parse(req.query ?? {}));
  });
};
