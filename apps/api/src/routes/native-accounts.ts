import type { FastifyPluginAsync } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { accountJson } from '../accounts/accounts.js';
import {
  activateNativeWallet,
  nativeActivationOptions,
  nativeRegistrationOptions,
  registerNativeWallet,
  setNativeSettlement,
} from '../accounts/native-accounts.js';
import {
  createNativePayout,
  getNativePayout,
  listNativePayouts,
  NativePayoutInput,
  nativePayoutChallenge,
  submitNativePayout,
} from '../accounts/native-payouts.js';
import { requireDashboardUser } from '../gateway/principal.js';

const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };
const owner = {
  principals: ['dashboard_user' as const],
  permission: 'security:propose' as const,
  stepUp: true,
};
const Assertion = z
  .object({ response: z.object({ id: z.string().min(1).max(1024) }).passthrough() })
  .strict();

export const nativeAccountRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/account/native/passkey/options', { config: { auth: owner } }, (req) =>
    nativeRegistrationOptions(requireDashboardUser(req)),
  );
  app.post('/v1/account/native/passkey/verify', { config: { auth: owner } }, (req) => {
    const { response } = Assertion.parse(req.body);
    return registerNativeWallet(
      requireDashboardUser(req),
      response as unknown as RegistrationResponseJSON,
    );
  });
  app.post('/v1/account/native/activate/options', { config: { auth: owner } }, (req) =>
    nativeActivationOptions(requireDashboardUser(req)),
  );
  app.post('/v1/account/native/activate', { config: { auth: owner } }, async (req) => {
    const { response } = Assertion.parse(req.body);
    return accountJson(
      await activateNativeWallet(
        requireDashboardUser(req),
        response as unknown as AuthenticationResponseJSON,
      ),
    );
  });
  app.put('/v1/account/native/settlement', { config: { auth: owner } }, async (req) => {
    const { asset } = z
      .object({ asset: z.string().min(1).max(256) })
      .strict()
      .parse(req.body);
    await setNativeSettlement(requireDashboardUser(req), asset);
    return { asset, payoutMode: 'intents' };
  });
  app.get('/v1/account/native/payouts', { config: { auth: read } }, async (req) => ({
    payouts: await listNativePayouts(requireDashboardUser(req)),
  }));
  app.post('/v1/account/native/payouts', { config: { auth: owner } }, async (req, reply) =>
    reply
      .status(201)
      .send(await createNativePayout(requireDashboardUser(req), NativePayoutInput.parse(req.body))),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/account/native/payouts/:id',
    { config: { auth: read } },
    (req) => getNativePayout(requireDashboardUser(req), req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/v1/account/native/payouts/:id/challenge',
    { config: { auth: owner } },
    (req) => nativePayoutChallenge(requireDashboardUser(req), req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/v1/account/native/payouts/:id/submit',
    { config: { auth: owner } },
    async (req, reply) => {
      const { response } = Assertion.parse(req.body);
      return reply
        .status(202)
        .send(
          await submitNativePayout(
            requireDashboardUser(req),
            req.params.id,
            response as unknown as AuthenticationResponseJSON,
          ),
        );
    },
  );
};
