// Account proposals: drafts, the approvals inbox, passkey challenges, relayed approvals and
// cancels. Every change to the account (money out, saved addresses, limits, signers, settlement)
// goes through here as a proposal; no route writes the mirrored settings directly.
import { ProposalKindSchema, ProposalStatusSchema } from '@tendr/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  cancelProposal,
  challengeFor,
  createDraft,
  getProposal,
  listProposals,
  submitApproval,
} from '../accounts/proposals.js';
import { requireDashboardUser } from '../gateway/principal.js';

/** A WebAuthn response object from the browser; only its assertion fields are used. */
const WebauthnResponse = z.object({ id: z.string().min(1).max(1024) }).passthrough();

const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };
// Drafting needs at least `money:request`; the service then requires the kind's own permission
// (`security:propose` for signer/key/threshold/origin/recovery/upgrade changes, `settings:manage`
// for limits, sweep and settlement).
const draft = { principals: ['dashboard_user' as const], permission: 'money:request' as const };

export const proposalRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/account/proposals', { config: { auth: draft } }, async (req, reply) => {
    const actor = requireDashboardUser(req);
    const body = z
      .object({ kind: ProposalKindSchema.optional(), action: z.record(z.unknown()) })
      .strict()
      .parse(req.body);
    return reply.status(201).send(await createDraft(actor, body));
  });

  app.get('/v1/account/proposals', { config: { auth: read } }, async (req) => {
    const actor = requireDashboardUser(req);
    const { status } = z
      .object({ status: ProposalStatusSchema.optional() })
      .strict()
      .parse(req.query);
    return { proposals: await listProposals(actor, { status }) };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/account/proposals/:id',
    { config: { auth: read } },
    async (req) => getProposal(requireDashboardUser(req), req.params.id),
  );

  // Signer checks (is_signer, an active passkey) are in the service.
  app.post<{ Params: { id: string } }>(
    '/v1/account/proposals/:id/challenge',
    { config: { auth: read } },
    async (req) => {
      const actor = requireDashboardUser(req);
      const { intent } = z
        .object({ intent: z.enum(['approve', 'cancel']).default('approve') })
        .strict()
        .parse(req.body ?? {});
      return challengeFor(actor, req.params.id, intent);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/account/proposals/:id/approve',
    { config: { auth: read } },
    async (req) => {
      const actor = requireDashboardUser(req);
      const { response } = z.object({ response: WebauthnResponse }).strict().parse(req.body);
      return submitApproval(actor, req.params.id, response);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/account/proposals/:id/cancel',
    { config: { auth: read } },
    async (req) => {
      const actor = requireDashboardUser(req);
      const { response } = z
        .object({ response: WebauthnResponse.optional() })
        .strict()
        .parse(req.body ?? {});
      return cancelProposal(actor, req.params.id, response);
    },
  );
};
