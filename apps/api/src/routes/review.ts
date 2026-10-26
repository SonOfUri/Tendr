// The merchant review queue (checkout Task 10). Reading it needs `account:read`. The legal
// acknowledgement is owner-only (gateway: `security:propose`, which only owners hold; the service
// checks the role too) with a fresh passkey (step-up) and the exact typed phrase. Drafting a return
// needs `money:request` plus step-up: it names where money goes, and signers still approve the
// proposal with their passkeys. There is no "release" route: held funds only leave by a refund.
import type { FastifyPluginAsync } from 'fastify';
import {
  acknowledgeLegal,
  AcknowledgeLegalSchema,
  RefundFromReviewSchema,
  refundFromReview,
  reviewQueue,
} from '../checkout/review.js';
import { requireDashboardUser } from '../gateway/principal.js';

const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };
const ownerStepUp = {
  principals: ['dashboard_user' as const],
  permission: 'security:propose' as const,
  stepUp: true,
};
const refund = {
  principals: ['dashboard_user' as const],
  permission: 'money:request' as const,
  stepUp: true,
};

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/review', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    return reviewQueue({ merchantId: p.merchantId, livemode: p.livemode });
  });

  app.post<{ Params: { paymentId: string } }>(
    '/v1/review/:paymentId/acknowledge-legal',
    { config: { auth: ownerStepUp } },
    async (req) =>
      acknowledgeLegal(
        requireDashboardUser(req),
        req.params.paymentId,
        AcknowledgeLegalSchema.parse(req.body ?? {}),
      ),
  );

  app.post<{ Params: { paymentId: string } }>(
    '/v1/review/:paymentId/refund',
    { config: { auth: refund } },
    async (req) =>
      refundFromReview(
        requireDashboardUser(req),
        req.params.paymentId,
        RefundFromReviewSchema.parse(req.body ?? {}),
      ),
  );
};
