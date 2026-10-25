// The store's merchant account: its state in the caller's mode, balances, the go-live checklist
// and go-live itself, the recovery key, and retrying a failed provisioning.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  accountJson,
  accountView,
  getBalances,
  goLiveOutcome,
  goLiveStatus,
  registerRecoveryKey,
  retryProvisioning,
} from '../accounts/accounts.js';
import { requireDashboardUser } from '../gateway/principal.js';

const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };
/** Owner only (`security:propose`), with a fresh passkey assertion. */
const owner = {
  principals: ['dashboard_user' as const],
  permission: 'security:propose' as const,
  stepUp: true,
};

const Threshold = z.coerce.number().int().min(0).max(255);

export const accountRoutes: FastifyPluginAsync = async (app) => {
  // Only the caller's mode: a test-mode principal never sees the live account, and vice versa.
  app.get('/v1/account', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    return accountView({ merchantId: p.merchantId, livemode: p.livemode });
  });

  app.get('/v1/account/balances', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    return getBalances(p.merchantId, p.livemode);
  });

  app.get('/v1/account/go-live', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    const { threshold } = z.object({ threshold: Threshold.optional() }).strict().parse(req.query);
    return goLiveStatus(p.merchantId, threshold);
  });

  app.post('/v1/account/go-live', { config: { auth: owner } }, async (req, reply) => {
    const p = requireDashboardUser(req);
    const { threshold } = z
      .object({ threshold: Threshold.optional() })
      .strict()
      .parse(req.body ?? {});
    const { created } = await goLiveOutcome(
      { merchantId: p.merchantId, userId: p.userId },
      { threshold },
    );
    // The same trimmed shape as the GET: the live account's status and id only.
    return reply.status(created ? 202 : 200).send(await goLiveStatus(p.merchantId, threshold));
  });

  app.post('/v1/account/recovery-key', { config: { auth: owner } }, async (req, reply) => {
    const p = requireDashboardUser(req);
    const { publicKey } = z
      .object({ publicKey: z.string().min(1).max(256) })
      .strict()
      .parse(req.body);
    const res = await registerRecoveryKey(
      { merchantId: p.merchantId, userId: p.userId },
      publicKey,
    );
    return reply.status(201).send(res);
  });

  // Re-queues a failed provisioning of the caller's mode account.
  app.post('/v1/account/retry', { config: { auth: owner } }, async (req, reply) => {
    const p = requireDashboardUser(req);
    const account = await retryProvisioning({ merchantId: p.merchantId, livemode: p.livemode });
    return reply.status(202).send(accountJson(account));
  });
};
