// `POST /v1/refunds` (WooCommerce plugin spec §7): a store refund, drafted as a signer-approved
// `refund` proposal (checkout/merchant-refunds.ts). Secret keys with `refunds:write` only;
// idempotent through the gateway's `Idempotency-Key` layer, and per `external_ref`.
// `POST /v1/refunds/:id/cancel` (W14) cancels one that has no proposal yet.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  cancelMerchantRefund,
  MerchantRefundInputSchema,
  merchantRefundView,
  requestMerchantRefund,
  type MerchantRefundCtx,
} from '../checkout/merchant-refunds.js';
import { requirePrincipal } from '../gateway/principal.js';
import { unauthorized } from '../lib/errors.js';

const write = { principals: ['secret_key' as const], scope: 'refunds:write' as const };

function ctxOf(req: FastifyRequest): MerchantRefundCtx {
  const p = requirePrincipal(req);
  if (p.kind !== 'secret_key') throw unauthorized();
  return { merchantId: p.merchantId, livemode: p.livemode, connectionId: p.connectionId };
}

export const refundRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/refunds', { config: { auth: write } }, async (req, reply) => {
    const ctx = ctxOf(req);
    const input = MerchantRefundInputSchema.parse(req.body);
    const { refund, created } = await requestMerchantRefund(ctx, input);
    return reply.status(created ? 201 : 200).send(merchantRefundView(refund));
  });

  app.post<{ Params: { id: string } }>(
    '/v1/refunds/:id/cancel',
    { config: { auth: write } },
    async (req) => merchantRefundView(await cancelMerchantRefund(ctxOf(req), req.params.id)),
  );
};
