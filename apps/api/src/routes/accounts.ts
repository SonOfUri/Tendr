// The store's merchant account: its state in the caller's mode, balances, the go-live checklist
// and go-live itself, where payments settle, the recovery key, and retrying a failed provisioning.
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
import { settlementView } from '../accounts/settlement.js';
import { requireDashboardUser } from '../gateway/principal.js';
import { assertLiveModeOpen } from '../lib/live-mode.js';
import { prisma } from '../lib/prisma.js';

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

  // Where payments settle in this mode, an open change, and the tokens offered (USDC first).
  // Changing it is a `set_settlement` proposal (POST /v1/account/proposals).
  app.get('/v1/account/settlement', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    return settlementView({ merchantId: p.merchantId, livemode: p.livemode });
  });

  app.get('/v1/account/balances', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    return getBalances(p.merchantId, p.livemode);
  });

  // Saved addresses (the `payout_allowlist` mirror): `pending` until `activeFrom`, then usable
  // for withdrawals; `revoked` once removed on chain. Display only; the contract decides.
  app.get('/v1/account/saved-addresses', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    const rows = await prisma.payoutAllowlistEntry.findMany({
      where: { merchantId: p.merchantId, livemode: p.livemode },
      orderBy: { createdAt: 'asc' },
    });
    const now = new Date();
    return {
      savedAddresses: rows.map((r) => ({
        id: r.id,
        chain: r.chain,
        address: r.address,
        status: r.status === 'revoked' ? 'revoked' : r.activeFrom > now ? 'pending' : 'active',
        activeFrom: r.activeFrom,
        createdAt: r.createdAt,
      })),
    };
  });

  // Per-asset limits, refund cap and auto-sweep (the `account_limits` mirror of the contract).
  app.get('/v1/account/limits', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    const rows = await prisma.accountLimit.findMany({
      where: { merchantId: p.merchantId, livemode: p.livemode },
      orderBy: { asset: 'asc' },
    });
    const n = (d: { toFixed(dp: number): string } | null) => (d === null ? null : d.toFixed(0));
    return {
      limits: rows.map((r) => ({
        asset: r.asset,
        perTx: n(r.perTx),
        perDay: n(r.perDay),
        refundCap: n(r.refundCap),
        autoSweep:
          r.sweepTriggerAbove === null
            ? null
            : {
                triggerAbove: n(r.sweepTriggerAbove),
                keep: n(r.sweepKeep),
                savedAddressId: r.sweepSavedAddressId,
                chain: r.sweepChain,
                address: r.sweepAddress,
              },
      })),
    };
  });

  app.get('/v1/account/go-live', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    const { threshold } = z.object({ threshold: Threshold.optional() }).strict().parse(req.query);
    return goLiveStatus(p.merchantId, threshold);
  });

  app.post('/v1/account/go-live', { config: { auth: owner } }, async (req, reply) => {
    // The live-mode switch: refused before anything is read, written or queued.
    assertLiveModeOpen();
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
