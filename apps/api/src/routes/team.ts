// The store's team: members, invites and roles. Signer changes are proposals, not routes here.
import { MerchantUserRoleSchema } from '@tendr/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireDashboardUser, requirePerson } from '../gateway/principal.js';
import { EmailSchema } from '../auth/magic-link.js';
import { acceptInvite, createInvite, pendingInvites } from '../merchants/invites.js';
import { changeRole, listMembers } from '../merchants/team.js';

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/team',
    { config: { auth: { principals: ['dashboard_user'], permission: 'account:read' } } },
    async (req) => {
      const { merchantId } = requireDashboardUser(req);
      return { members: await listMembers(merchantId), invites: await pendingInvites(merchantId) };
    },
  );

  app.post(
    '/v1/team/invites',
    { config: { auth: { principals: ['dashboard_user'], permission: 'team:manage' } } },
    async (req, reply) => {
      const p = requireDashboardUser(req);
      const body = z
        .object({ email: EmailSchema, role: MerchantUserRoleSchema })
        .strict()
        .parse(req.body);
      const invite = await createInvite({ merchantId: p.merchantId, role: p.role }, body);
      return reply.status(201).send(invite);
    },
  );

  app.patch<{ Params: { membershipId: string } }>(
    '/v1/team/:membershipId',
    { config: { auth: { principals: ['dashboard_user'], permission: 'team:manage' } } },
    async (req) => {
      const p = requireDashboardUser(req);
      // Only the role: `is_signer` changes go through AddSigner / RemoveSigner proposals.
      const { role } = z.object({ role: MerchantUserRoleSchema }).strict().parse(req.body);
      return changeRole({ merchantId: p.merchantId, role: p.role }, req.params.membershipId, role);
    },
  );

  // Accepting needs the person, not a store: they are not a member yet.
  app.post(
    '/v1/invites/accept',
    { config: { auth: { principals: ['user_session'] } } },
    async (req) => {
      const { userId } = requirePerson(req);
      const { token } = z
        .object({ token: z.string().min(1).max(256) })
        .strict()
        .parse(req.body);
      const m = await acceptInvite(userId, token);
      return { membershipId: m.id, merchantId: m.merchantId, role: m.role, isSigner: m.isSigner };
    },
  );
};
