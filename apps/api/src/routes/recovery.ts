// Account recovery: start (authorised by the recovery kit's signature, not by a session), cancel
// (a signer's passkey), status, and the restricted recovery-kit session for people who lost every
// passkey.
//
// The kit-authorised routes are public, so each is strictly rate limited — per client IP and per
// account — on top of the gateway's per-IP limits.
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  cancelRecovery,
  recoveryCancelChallenge,
  recoveryParams,
  recoverySessionOptions,
  recoveryStatus,
  StartRecoverySchema,
  startRecovery,
  verifyRecoverySession,
} from '../accounts/recovery.js';
import { sessionCookies } from '../auth/session.js';
import { requireDashboardUser } from '../gateway/principal.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';

/** Kit-authorised attempts allowed per window, per IP and per account. */
export const RECOVERY_LIMIT = 5;
export const RECOVERY_LIMIT_WINDOW_SECONDS = 3600;

const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };
const WebauthnResponse = z.object({ id: z.string().min(1).max(1024) }).passthrough();

/**
 * A fixed-window counter in Redis: throws 429 once `key` was hit more than `RECOVERY_LIMIT` times
 * in the window. Fails open (logged) when Redis is unavailable, like the gateway's limits: the
 * signature check, not the limit, is what guards these routes.
 */
async function hit(namespace: string, reply: FastifyReply, key: string): Promise<void> {
  let count: number;
  let ttl: number;
  try {
    const redis = getRedis();
    const k = `${namespace}${key}`;
    count = await redis.incr(k);
    if (count === 1) await redis.expire(k, RECOVERY_LIMIT_WINDOW_SECONDS);
    ttl = await redis.ttl(k);
  } catch (err) {
    log('warn', 'recovery rate limit unavailable; failing open', { err: String(err) });
    return;
  }
  if (count > RECOVERY_LIMIT) {
    reply.header('retry-after', Math.max(ttl, 1));
    throw new AppError('RATE_LIMITED', 'Too many recovery attempts; try again later', 429);
  }
}

export const recoveryRoutes: FastifyPluginAsync = async (app) => {
  // Tests get a private keyspace per app instance so counters never leak between them.
  const namespace =
    process.env.NODE_ENV === 'test' ? `tendr:rl:recovery:${randomUUID()}:` : 'tendr:rl:recovery:';
  // Every request is charged to its IP before anything else (body parsing included). The
  // per-account counter is charged only once the kit's signature has verified, so unverified
  // requests can never use up an account's attempts and block its recovery (I2); no counter key
  // is ever created for an account that does not exist.
  const perIp = (req: FastifyRequest, reply: FastifyReply, route: string) =>
    hit(namespace, reply, `${route}:ip:${req.ip}`);
  const perAccount = (reply: FastifyReply, route: string, accountId: string) =>
    hit(namespace, reply, `${route}:acct:${accountId}`);

  // Authorised by the recovery kit's Ed25519 signature over the recovery payload (R19).
  app.post('/v1/account/recovery/start', { config: { auth: 'public' } }, async (req, reply) => {
    await perIp(req, reply, 'start');
    const body = StartRecoverySchema.parse(req.body);
    const result = await startRecovery(body, {
      onVerified: (accountId) => perAccount(reply, 'start', accountId),
    });
    return reply.status(202).send(result);
  });

  app.get('/v1/account/recovery', { config: { auth: read } }, async (req) => {
    const p = requireDashboardUser(req);
    return recoveryStatus({ merchantId: p.merchantId, livemode: p.livemode });
  });

  // What a recovery kit signs over besides the new signers: the account id, the contract's
  // recovery-key epoch and the last nonce it used (read from chain; the browser signs nonce+1).
  app.get('/v1/account/recovery/params', { config: { auth: read } }, async (req) =>
    recoveryParams(requireDashboardUser(req)),
  );

  // Signer checks (is_signer, an active passkey) are in the service.
  app.post('/v1/account/recovery/challenge', { config: { auth: read } }, async (req) =>
    recoveryCancelChallenge(requireDashboardUser(req)),
  );

  app.post('/v1/account/recovery/cancel', { config: { auth: read } }, async (req) => {
    const actor = requireDashboardUser(req);
    const { response } = z.object({ response: WebauthnResponse }).strict().parse(req.body);
    return cancelRecovery(actor, response);
  });

  // Lost every passkey: prove the recovery kit, get a restricted session (see accounts/recovery).
  app.post(
    '/v1/auth/recovery-session/options',
    { config: { auth: 'public' } },
    async (req, reply) => {
      await perIp(req, reply, 'session-options');
      const body = z
        .object({ merchant: z.string().min(1).max(64), email: z.string().email().max(254) })
        .strict()
        .parse(req.body);
      return recoverySessionOptions(body);
    },
  );

  app.post(
    '/v1/auth/recovery-session/verify',
    { config: { auth: 'public' } },
    async (req, reply) => {
      await perIp(req, reply, 'session-verify');
      const body = z
        .object({
          merchant: z.string().min(1).max(64),
          email: z.string().email().max(254),
          challenge: z.string().min(1).max(128),
          signature: z.string().min(1).max(128),
        })
        .strict()
        .parse(req.body);
      const { session, userId, merchantId } = await verifyRecoverySession(body, {
        onKitVerified: (id) => perAccount(reply, 'session-verify', id),
      });
      reply.header('set-cookie', sessionCookies(session.token, session.expiresAt));
      return {
        userId,
        merchantId,
        restricted: true,
        expiresAt: session.expiresAt,
        csrfToken: session.csrf,
        // Registering also needs the single-use link just emailed to the person (R28).
        allowed: [
          'register your first passkey (with the emailed link)',
          'POST /v1/account/recovery/start',
        ],
      };
    },
  );
};
