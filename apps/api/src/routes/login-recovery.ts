import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import {
  completeLoginRecovery,
  generateLoginRecoveryCodes,
  loginRecoveryOptions,
  loginRecoveryStatus,
  requestLoginRecovery,
} from '../auth/login-recovery.js';
import { EmailSchema } from '../auth/magic-link.js';
import { clearedSessionCookies } from '../auth/session.js';
import { requirePerson, requirePrincipal } from '../gateway/principal.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, providerNotConfigured } from '../lib/errors.js';
import { getRedis } from '../lib/redis.js';

const person = { principals: ['user_session' as const] };
const proof = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  recoveryCode: z.string().min(1).max(128),
});
const WINDOW = 15 * 60;
// Atomic increment+expiry; recovery fails closed if its abuse protection is unavailable.
const HIT =
  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('TTL',KEYS[1])}";

export const loginRecoveryRoutes: FastifyPluginAsync = async (app) => {
  const ns = `tendr:login-recovery:${process.env.NODE_ENV === 'test' ? randomUUID() + ':' : ''}`;
  async function limit(key: string, max: number, reply: FastifyReply) {
    let hit: number[];
    try {
      hit = (await getRedis().eval(HIT, 1, ns + key, WINDOW)) as number[];
    } catch {
      throw providerNotConfigured('Recovery is temporarily unavailable; try again later');
    }
    if (hit[0]! > max) {
      reply.header('retry-after', Math.max(hit[1]!, 1));
      throw new AppError('RATE_LIMITED', 'Too many recovery attempts; try again later', 429);
    }
  }
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });
  app.get('/v1/auth/login-recovery/codes', { config: { auth: person } }, async (req) =>
    loginRecoveryStatus(requirePerson(req).userId),
  );
  app.post(
    '/v1/auth/login-recovery/codes',
    { config: { auth: { ...person, stepUp: true }, idempotency: false } },
    async (req) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const p = requirePrincipal(req);
      if (p.kind !== 'user_session')
        throw new AppError('FORBIDDEN', 'Use your personal login session', 403);
      return generateLoginRecoveryCodes(p.userId, p.sessionId);
    },
  );
  app.post('/v1/auth/login-recovery/start', { config: { auth: 'public' } }, async (req, reply) => {
    await limit(`start:ip:${req.ip}`, 10, reply);
    const { email } = z.object({ email: EmailSchema }).strict().parse(req.body);
    await limit(`start:email:${sha256(email)}`, 3, reply);
    await requestLoginRecovery(email);
    return reply.status(202).send({ ok: true });
  });
  app.post(
    '/v1/auth/login-recovery/options',
    { config: { auth: 'public' } },
    async (req, reply) => {
      await limit(`proof:ip:${req.ip}`, 20, reply);
      const { token, recoveryCode } = proof.strict().parse(req.body);
      await limit(`proof:token:${sha256(token)}`, 10, reply);
      return loginRecoveryOptions(token, recoveryCode);
    },
  );
  app.post('/v1/auth/login-recovery/verify', { config: { auth: 'public' } }, async (req, reply) => {
    await limit(`verify:ip:${req.ip}`, 20, reply);
    const { token, recoveryCode, response, deviceLabel } = proof
      .extend({
        response: z.object({ id: z.string().min(1).max(1024) }).passthrough(),
        deviceLabel: z.string().trim().min(1).max(64).default('Recovered login passkey'),
      })
      .strict()
      .parse(req.body);
    await limit(`verify:token:${sha256(token)}`, 10, reply);
    const result = await completeLoginRecovery(
      token,
      recoveryCode,
      response as unknown as RegistrationResponseJSON,
      deviceLabel,
    );
    reply.header('set-cookie', clearedSessionCookies());
    return result;
  });
};
