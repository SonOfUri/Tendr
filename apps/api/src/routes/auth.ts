// Dashboard sign-in: email magic links, passkeys, logout and the signed-in person.
import type { WebauthnCredential } from '@prisma/client';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { consumeEmailLink, EmailSchema, startEmailSignIn } from '../auth/magic-link.js';
import {
  clearedSessionCookies,
  createDashboardSession,
  revokeDashboardSession,
  sessionCookies,
} from '../auth/session.js';
import {
  activeCredentials,
  authenticationOptions,
  registrationOptions,
  revokeCredential,
  verifyAuthentication,
  verifyRegistration,
} from '../auth/webauthn.js';
import { requirePerson, requirePrincipal } from '../gateway/principal.js';
import { prisma } from '../lib/prisma.js';
import { storesFor } from '../merchants/team.js';

const person = { principals: ['user_session' as const] };

/** A WebAuthn response object from the browser; its contents are checked by the verifier. */
const WebauthnResponse = z.object({ id: z.string().min(1).max(1024) }).passthrough();

const publicPasskey = (c: WebauthnCredential) => ({
  id: c.id,
  deviceLabel: c.deviceLabel,
  transports: c.transports,
  createdAt: c.createdAt,
  lastUsedAt: c.lastUsedAt,
});

async function startSession(reply: FastifyReply, userId: string) {
  const session = await createDashboardSession(userId);
  reply.header('set-cookie', sessionCookies(session.token, session.expiresAt));
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const passkeys = await activeCredentials(userId);
  return {
    user: { id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt },
    hasPasskey: passkeys.length > 0,
  };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/auth/email/start', { config: { auth: 'public' } }, async (req, reply) => {
    const { email } = z.object({ email: EmailSchema }).strict().parse(req.body);
    await startEmailSignIn(email);
    // Same answer whether or not the person exists.
    return reply.status(202).send({ ok: true });
  });

  app.post('/v1/auth/email/verify', { config: { auth: 'public' } }, async (req, reply) => {
    const { token } = z
      .object({ token: z.string().min(1).max(256) })
      .strict()
      .parse(req.body);
    const { userId } = await consumeEmailLink(token);
    return startSession(reply, userId);
  });

  app.post('/v1/auth/passkeys/register/options', { config: { auth: person } }, async (req) => {
    const { userId } = requirePerson(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return registrationOptions(user);
  });

  app.post('/v1/auth/passkeys/register/verify', { config: { auth: person } }, async (req) => {
    const { userId } = requirePerson(req);
    const body = z
      .object({
        response: WebauthnResponse,
        deviceLabel: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .parse(req.body);
    const credential = await verifyRegistration(
      { id: userId },
      body.response as unknown as RegistrationResponseJSON,
      body.deviceLabel ?? null,
    );
    return { credential: publicPasskey(credential) };
  });

  app.post('/v1/auth/passkeys/login/options', { config: { auth: 'public' } }, async (req) => {
    const { email } = z
      .object({ email: EmailSchema.optional() })
      .strict()
      .parse(req.body ?? {});
    return authenticationOptions(email);
  });

  app.post('/v1/auth/passkeys/login/verify', { config: { auth: 'public' } }, async (req, reply) => {
    const { response } = z.object({ response: WebauthnResponse }).strict().parse(req.body);
    const { userId } = await verifyAuthentication(
      response as unknown as AuthenticationResponseJSON,
    );
    return startSession(reply, userId);
  });

  app.get('/v1/auth/passkeys', { config: { auth: person } }, async (req) => {
    const { userId } = requirePerson(req);
    return { passkeys: (await activeCredentials(userId)).map(publicPasskey) };
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/auth/passkeys/:id',
    { config: { auth: person } },
    async (req, reply) => {
      const { userId } = requirePerson(req);
      await revokeCredential(userId, req.params.id);
      return reply.status(204).send();
    },
  );

  app.post('/v1/auth/logout', { config: { auth: person } }, async (req, reply) => {
    const p = requirePrincipal(req);
    if (p.kind === 'user_session') await revokeDashboardSession(p.sessionId);
    reply.header('set-cookie', clearedSessionCookies());
    return reply.status(204).send();
  });

  app.get('/v1/me', { config: { auth: person } }, async (req) => {
    const { userId } = requirePerson(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      user: { id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt },
      stores: await storesFor(userId),
      passkeys: (await activeCredentials(userId)).map(publicPasskey),
    };
  });
};
