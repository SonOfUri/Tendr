import type { FastifyPluginAsync } from 'fastify';
import { requireMerchantPrincipal } from '../gateway/principal.js';

/** Authenticated echo of the caller's principal, for testing the gateway end to end. */
export const pingRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/ping',
    { config: { auth: { principals: ['secret_key', 'publishable_key'] } } },
    async (req) => {
      const p = requireMerchantPrincipal(req);
      return {
        merchantId: p.merchantId,
        livemode: p.livemode,
        principal: p.kind,
        ...(p.kind === 'secret_key' ? { scopes: p.scopes } : {}),
      };
    },
  );
};
