// Store membership: listing the team, the stores a person belongs to, and role changes.
//
// People (`users`) are identity rows outside tenant scoping, so the joins from memberships to
// emails live here and nowhere else, and every one of them filters by `merchant_id` (or by the
// person) explicitly.
//
// `is_signer` is never changed here: adding or removing a signer is an on-chain proposal
// (AddSigner / RemoveSigner), mirrored into `merchant_users` when it executes.
import type { MerchantUserRole } from '@tendr/contracts';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export type TeamMember = {
  id: string;
  userId: string;
  email: string;
  role: MerchantUserRole;
  isSigner: boolean;
  createdAt: Date;
};

/** The members of one store, with their emails, oldest first. */
export async function listMembers(merchantId: string): Promise<TeamMember[]> {
  const rows = await prisma.merchantUser.findMany({
    where: { merchantId },
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    email: r.user.email,
    role: r.role,
    isSigner: r.isSigner,
    createdAt: r.createdAt,
  }));
}

export type StoreSummary = {
  id: string;
  name: string;
  slug: string;
  status: string;
  membershipId: string;
  role: MerchantUserRole;
  isSigner: boolean;
};

/** Every store the person belongs to (the dashboard's store switcher). */
export async function storesFor(userId: string, merchantId?: string): Promise<StoreSummary[]> {
  const rows = await prisma.merchantUser.findMany({
    where: { userId, ...(merchantId ? { merchantId } : {}) },
    include: { merchant: { select: { id: true, name: true, slug: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    ...r.merchant,
    membershipId: r.id,
    role: r.role,
    isSigner: r.isSigner,
  }));
}

/** One store, if the person belongs to it; otherwise 404 (no hint that it exists). */
export async function storeFor(userId: string, merchantId: string): Promise<StoreSummary> {
  const [store] = await storesFor(userId, merchantId);
  if (!store) throw notFound('Store not found');
  return store;
}

/**
 * Changes a member's role. Only owners may touch an owner or make someone an owner; the last
 * owner cannot be demoted; a signer cannot become a viewer (viewers can never be signers —
 * remove the signer by proposal first). Serialised per store so concurrent demotions cannot
 * leave it without an owner.
 */
export async function changeRole(
  actor: { merchantId: string; role: MerchantUserRole },
  membershipId: string,
  role: MerchantUserRole,
): Promise<TeamMember> {
  await tenantTransaction({ merchantId: actor.merchantId, livemode: false }, async (tx, ctx) => {
    await tx.$queryRaw`SELECT id FROM merchant_users WHERE merchant_id = ${ctx.merchantId} FOR UPDATE`;
    const target = await tx.merchantUser.findFirst({
      where: { id: membershipId, merchantId: ctx.merchantId },
    });
    if (!target) throw notFound('Team member not found');
    if ((target.role === 'owner' || role === 'owner') && actor.role !== 'owner') {
      throw forbidden('Only an owner can change an owner or make someone an owner');
    }
    if (target.role === role) return;
    if (
      role !== 'owner' &&
      (await tx.nativeWallet.findFirst({
        where: { merchantId: ctx.merchantId, ownerUserId: target.userId },
      }))
    ) {
      throw conflict(
        'The native wallet owner cannot be demoted; wallet ownership must be migrated first',
      );
    }
    if (target.role === 'owner') {
      const owners = await tx.merchantUser.count({
        where: { merchantId: ctx.merchantId, role: 'owner' },
      });
      if (owners < 2) throw conflict('A store needs at least one owner');
    }
    if (role === 'viewer' && target.isSigner) {
      throw conflict('A signer cannot be a viewer; remove them as a signer first');
    }
    await tx.merchantUser.updateMany({
      where: { id: target.id, merchantId: ctx.merchantId },
      data: { role },
    });
  });
  const member = (await listMembers(actor.merchantId)).find((m) => m.id === membershipId);
  if (!member) throw notFound('Team member not found');
  return member;
}
