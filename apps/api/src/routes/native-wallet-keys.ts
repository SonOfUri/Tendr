import type { FastifyPluginAsync } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { requireDashboardUser } from '../gateway/principal.js';
import {
  cancelNativeKeyOperation,
  getNativeKeyOperation,
  listNativeWalletKeys,
  nativeKeyOperationChallenge,
  proveNativeCandidate,
  registerNativeCandidate,
  StartKeyOperation,
  startNativeKeyOperation,
  submitNativeKeyOperation,
} from '../accounts/native-key-operations.js';

const auth = {
  principals: ['dashboard_user' as const],
  permission: 'security:propose' as const,
  stepUp: true,
};
const response = z.object({ id: z.string().min(1).max(1024) }).passthrough();
const proof = z.union([
  z.object({ response }).strict(),
  z.object({ signatureB64: z.string().min(1).max(128) }).strict(),
]);
type Params = { Params: { id: string } };
const base = '/v1/account/native/keys';

export const nativeWalletKeyRoutes: FastifyPluginAsync = async (app) => {
  app.get(base, { config: { auth: { ...auth, stepUp: false } } }, (req) =>
    listNativeWalletKeys(requireDashboardUser(req)),
  );
  app.post(`${base}/operations`, { config: { auth } }, async (req, reply) =>
    reply
      .code(201)
      .send(
        await startNativeKeyOperation(requireDashboardUser(req), StartKeyOperation.parse(req.body)),
      ),
  );
  app.get<Params>(`${base}/operations/:id`, { config: { auth } }, (req) =>
    getNativeKeyOperation(requireDashboardUser(req), req.params.id),
  );
  app.post<Params>(`${base}/operations/:id/register`, { config: { auth } }, (req) => {
    const input = z.object({ response }).strict().parse(req.body);
    return registerNativeCandidate(
      requireDashboardUser(req),
      req.params.id,
      input.response as unknown as RegistrationResponseJSON,
    );
  });
  app.post<Params>(`${base}/operations/:id/prove`, { config: { auth } }, (req) =>
    proveNativeCandidate(
      requireDashboardUser(req),
      req.params.id,
      proof.parse(req.body) as { response?: AuthenticationResponseJSON; signatureB64?: string },
    ),
  );
  app.post<Params>(`${base}/operations/:id/challenge`, { config: { auth } }, (req) =>
    nativeKeyOperationChallenge(requireDashboardUser(req), req.params.id),
  );
  app.post<Params>(`${base}/operations/:id/submit`, { config: { auth } }, async (req, reply) =>
    reply
      .code(202)
      .send(
        await submitNativeKeyOperation(
          requireDashboardUser(req),
          req.params.id,
          proof.parse(req.body) as { response?: AuthenticationResponseJSON; signatureB64?: string },
        ),
      ),
  );
  app.post<Params>(`${base}/operations/:id/cancel`, { config: { auth } }, (req) =>
    cancelNativeKeyOperation(requireDashboardUser(req), req.params.id),
  );
};
