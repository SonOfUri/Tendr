// Dashboard sign-in: email magic links, passkeys, logout and the signed-in person.
import type { WebauthnCredential } from '@prisma/client';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeEmailLink, EmailSchema, startEmailSignIn } from '../auth/magic-link.js';
import {
  clearedSessionCookies,
  createDashboardSession,
  markPasskeyVerified,
  revokeDashboardSession,
  sessionCookies,
} from '../auth/session.js';
import {
  activeCredentials,
  authenticationOptions,
  registrationOptions,
  revokeCredential,
  stepUpOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../auth/webauthn.js';
import { requirePerson, requirePrincipal, requireStepUp } from '../gateway/principal.js';
import { unauthorized } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { storesFor } from '../merchants/team.js';

const person = { principals: ['user_session' as const] };

/** The dashboard session behind a cookie-authenticated request. */
function sessionOf(req: FastifyRequest): string {
  const p = requirePrincipal(req);
  if (p.kind !== 'user_session' && p.kind !== 'dashboard_user') throw unauthorized();
  return p.sessionId;
}

/** A WebAuthn response object from the browser; its contents are checked by the verifier. */
const WebauthnResponse = z.object({ id: z.string().min(1).max(1024) }).passthrough();

const publicPasskey = (c: WebauthnCredential) => ({
  id: c.id,
  deviceLabel: c.deviceLabel,
  transports: c.transports,
  createdAt: c.createdAt,
  lastUsedAt: c.lastUsedAt,
});

async function startSession(reply: FastifyReply, userId: string, passkeyVerified: boolean) {
  const session = await createDashboardSession(userId, { passkeyVerified });
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
    // Only for a person with no active passkey (signup / first-passkey bootstrap).
    const { userId } = await consumeEmailLink(token);
    return startSession(reply, userId, false);
  });

  // The first passkey is the bootstrap (an email-verified session may add it). Every further
  // passkey needs a recent assertion from an existing one, checked again at verify time.
  app.post('/v1/auth/passkeys/register/options', { config: { auth: person } }, async (req) => {
    const { userId } = requirePerson(req);
    if ((await activeCredentials(userId)).length > 0) requireStepUp(req);
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
    const first = (await activeCredentials(userId)).length === 0;
    if (!first) requireStepUp(req);
    const credential = await verifyRegistration(
      { id: userId },
      body.response as unknown as RegistrationResponseJSON,
      body.deviceLabel ?? null,
    );
    // Registering the first passkey is itself a fresh passkey assertion (user-verified).
    if (first) await markPasskeyVerified(sessionOf(req));
    return { credential: publicPasskey(credential) };
  });

  app.post('/v1/auth/passkeys/login/options', { config: { auth: 'public' } }, async (req) => {
    // No email parameter: always a discoverable login, so nothing about accounts is disclosed.
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return authenticationOptions();
  });

  app.post('/v1/auth/passkeys/login/verify', { config: { auth: 'public' } }, async (req, reply) => {
    const { response } = z.object({ response: WebauthnResponse }).strict().parse(req.body);
    const { userId } = await verifyAuthentication(
      response as unknown as AuthenticationResponseJSON,
    );
    return startSession(reply, userId, true);
  });

  // Step-up: re-prove a passkey on the current session (sensitive actions need one ≤ 10 min old).
  app.post('/v1/auth/passkeys/step-up/options', { config: { auth: person } }, async (req) =>
    stepUpOptions(requirePerson(req).userId),
  );

  app.post('/v1/auth/passkeys/step-up/verify', { config: { auth: person } }, async (req) => {
    const { userId } = requirePerson(req);
    const { response } = z.object({ response: WebauthnResponse }).strict().parse(req.body);
    const result = await verifyAuthentication(response as unknown as AuthenticationResponseJSON);
    if (result.userId !== userId) throw unauthorized('That passkey belongs to someone else');
    await markPasskeyVerified(sessionOf(req));
    return { ok: true };
  });

  app.get('/v1/auth/passkeys', { config: { auth: person } }, async (req) => {
    const { userId } = requirePerson(req);
    return { passkeys: (await activeCredentials(userId)).map(publicPasskey) };
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/auth/passkeys/:id',
    { config: { auth: { ...person, stepUp: true } } },
    async (req, reply) => {
      const { userId } = requirePerson(req);
      // Ends the person's other sessions too; this one stays.
      await revokeCredential(userId, req.params.id, sessionOf(req));
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
