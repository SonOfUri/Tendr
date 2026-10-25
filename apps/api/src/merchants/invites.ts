// Team invites.
//
// An invite is a single-use link `WEB_URL/invite/<token>` (32 random bytes, base64url) mailed to
// the invitee; only `sha256(token)` is stored. Accepting needs a signed-in person whose VERIFIED
// email equals the invite's email. A person who already has a Tendr login simply gains a
// membership: no new person, and their passkeys carry over to the new store.
//
// Invites never make anyone a signer: that is an AddSigner proposal once they have joined.
import type { MerchantInvite, MerchantUser } from '@prisma/client';
import type { MerchantUserRole } from '@tendr/contracts';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { getMailer } from '../auth/mailer.js';
import { EmailSchema, newLinkToken } from '../auth/magic-link.js';
import { sha256 } from '../lib/crypto.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { listMembers } from './team.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PublicInvite = Pick<
  MerchantInvite,
  'id' | 'email' | 'role' | 'expiresAt' | 'acceptedAt' | 'createdAt'
>;

export const publicInvite = (i: MerchantInvite): PublicInvite => ({
  id: i.id,
  email: i.email,
  role: i.role,
  expiresAt: i.expiresAt,
  acceptedAt: i.acceptedAt,
  createdAt: i.createdAt,
});

/** Pending (unaccepted, unexpired) invites of one store. */
export async function pendingInvites(merchantId: string): Promise<PublicInvite[]> {
  const rows = await prisma.merchantInvite.findMany({
    where: { merchantId, acceptedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(publicInvite);
}

export async function createInvite(
  actor: { merchantId: string; role: MerchantUserRole },
  input: { email: string; role: MerchantUserRole },
): Promise<PublicInvite> {
  const email = EmailSchema.parse(input.email);
  if (input.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner can invite an owner');
  }
  // The membership → email join lives in team.ts only.
  if ((await listMembers(actor.merchantId)).some((m) => m.email === email)) {
    throw conflict('That person is already on the team');
  }
  const { raw, hash } = newLinkToken();
  const { invite, merchantName } = await tenantTransaction(
    { merchantId: actor.merchantId, livemode: false },
    async (tx, ctx) => {
      const now = new Date();
      // A new invite replaces any pending one for the same email: the old link stops working.
      await tx.merchantInvite.updateMany({
        where: { merchantId: ctx.merchantId, email, acceptedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      });
      const invite = await tx.merchantInvite.create({
        data: {
          id: newId('inv'),
          merchantId: ctx.merchantId,
          email,
          role: input.role,
          tokenHash: hash,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        },
      });
      const merchant = await tx.merchant.findUniqueOrThrow({
        where: { id: ctx.merchantId },
        select: { name: true },
      });
      return { invite, merchantName: merchant.name };
    },
  );
  await getMailer().send({
    to: email,
    template: 'invite',
    data: {
      url: new URL(`/invite/${raw}`, env().WEB_URL).toString(),
      storeName: merchantName,
      role: input.role,
    },
  });
  return publicInvite(invite);
}

/**
 * Accepts an invite for the signed-in person. 404 for an unknown, used or expired link; 403 when
 * the person's verified email is not the invited one; 409 if they already belong to the store.
 */
export async function acceptInvite(userId: string, token: string): Promise<MerchantUser> {
  const invite = await prisma.merchantInvite.findUnique({ where: { tokenHash: sha256(token) } });
  const now = new Date();
  if (!invite || invite.acceptedAt || invite.expiresAt <= now) throw notFound('Invite not found');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.emailVerifiedAt || user.email !== invite.email) {
    throw forbidden('This invite was sent to a different email address');
  }
  return tenantTransaction({ merchantId: invite.merchantId, livemode: false }, async (tx, ctx) => {
    // Claim the invite first: single use even under concurrent accepts.
    const { count } = await tx.merchantInvite.updateMany({
      where: {
        id: invite.id,
        merchantId: ctx.merchantId,
        acceptedAt: null,
        expiresAt: { gt: now },
      },
      data: { acceptedAt: now },
    });
    if (count === 0) throw notFound('Invite not found');
    const existing = await tx.merchantUser.findFirst({
      where: { merchantId: ctx.merchantId, userId },
    });
    if (existing) throw conflict('You are already on this team');
    return tx.merchantUser.create({
      data: {
        id: newId('usr'),
        merchantId: ctx.merchantId,
        userId,
        role: invite.role,
        isSigner: false,
      },
    });
  });
}
