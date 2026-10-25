// The store's team: members, invites and roles. Signer changes are proposals, not routes here.
import { MerchantUserRoleSchema, SignerKeySchema } from '@tendr/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireDashboardUser, requirePerson } from '../gateway/principal.js';
import { EmailSchema } from '../auth/magic-link.js';
import { acceptInvite, createInvite, pendingInvites } from '../merchants/invites.js';
import { changeRole, listMembers } from '../merchants/team.js';
import { activeCredentials } from '../auth/webauthn.js';
import { notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/team',
    { config: { auth: { principals: ['dashboard_user'], permission: 'account:read' } } },
    async (req) => {
      const { merchantId } = requireDashboardUser(req);
      return { members: await listMembers(merchantId), invites: await pendingInvites(merchantId) };
    },
  );

  // A member's active passkey keys in the contract's SignerKey form, for drafting `add_signer`
  // ("Make signer") or a recovery's new signer set. Owner/admin only (`team:manage`); public
  // keys are not secret, but the list is a team-management view.
  app.get<{ Params: { membershipId: string } }>(
    '/v1/team/:membershipId/signer-keys',
    { config: { auth: { principals: ['dashboard_user'], permission: 'team:manage' } } },
    async (req) => {
      const { merchantId } = requireDashboardUser(req);
      const m = await prisma.merchantUser.findFirst({
        where: { id: req.params.membershipId, merchantId },
        select: { id: true, userId: true, role: true, isSigner: true },
      });
      if (!m) throw notFound('Team member not found');
      const keys = (await activeCredentials(m.userId)).flatMap((c) => {
        const k = SignerKeySchema.safeParse(c.publicKey);
        return k.success ? [k.data] : [];
      });
      return { membershipId: m.id, userId: m.userId, role: m.role, isSigner: m.isSigner, keys };
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
