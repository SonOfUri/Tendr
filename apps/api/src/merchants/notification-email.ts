// The store's notification email (WooCommerce plugin spec §3 "Builder's call (security)").
//
// A new address — from the dashboard or a connected site — never takes effect directly. It is
// stored as `notification_email_pending` with the sha256 of a single-use token (24 h), and only
// that address is mailed: a link to `<WEB_URL>/settings/notification-email/verify?t=<token>`. A new
// request replaces the token, so earlier links stop working. Using the link
// (`POST /v1/settings/notification-email/verify`, public) makes the address effective and tells the
// previous address — or, when there was none, the owners — about the change.
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getMailer } from '../auth/mailer.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { ownerEmails } from './store-notices.js';

export const NOTIFICATION_EMAIL_LINK_TTL_MS = 24 * 60 * 60_000;
/** Internal audit event (never a webhook): a pending address took effect through its link. */
export const NOTIFICATION_EMAIL_VERIFIED = 'merchant.notification_email.verified';
export const VERIFY_PATH = '/settings/notification-email/verify';

/** Who changed a store setting, as recorded in the audit log. */
export type SettingsActor =
  { by: 'user'; userId: string } | { by: 'connection'; connectionId: string };
type PendingRequest = SettingsActor & { livemode: boolean };

/** 32 random bytes, base64url: exactly 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const invalidLink = () =>
  new AppError(
    'INVALID_LINK',
    'This link is invalid, used, expired or replaced by a newer one',
    400,
  );

export const verifyLink = (raw: string): string => {
  const url = new URL(VERIFY_PATH, env().WEB_URL);
  url.searchParams.set('t', raw);
  return url.toString();
};

/**
 * The columns that start a pending change to `email`, plus the verify mail to send once they are
 * written (inside the caller's transaction, so a failed send rolls the request back).
 */
export function pendingNotificationEmail(
  email: string,
  storeName: string,
  request: PendingRequest,
  now = new Date(),
): { data: Prisma.MerchantUpdateInput; send: () => Promise<void> } {
  const raw = randomBytes(32).toString('base64url');
  const url = verifyLink(raw);
  return {
    data: {
      notificationEmailPending: email,
      notificationEmailTokenHash: sha256(raw),
      notificationEmailTokenExpiresAt: new Date(now.getTime() + NOTIFICATION_EMAIL_LINK_TTL_MS),
      notificationEmailRequest: request,
    },
    send: () =>
      getMailer().send({
        to: email,
        template: 'notification_email_verify',
        data: { url, store_name: storeName, email },
        subject: `Confirm the email for ${storeName} on tendr`,
        text: [
          `Someone asked for payment and refund notices for ${storeName} to be sent to ${email}.`,
          '',
          `Confirm this address: ${url}`,
          '',
          'The link works once and expires in 24 hours. Nothing is sent here until you confirm.',
          'If you did not expect this, ignore this email.',
        ].join('\n'),
      }),
  };
}

/** Clearing a pending change (the address went back to the current one, or to the owners). */
export const NO_PENDING: Prisma.MerchantUpdateInput = {
  notificationEmailPending: null,
  notificationEmailTokenHash: null,
  notificationEmailTokenExpiresAt: null,
  notificationEmailRequest: Prisma.DbNull,
};

/** Tells `to` (each) that the store's notices now go to `newEmail` (null: back to the owners). */
export async function sendNotificationEmailChanged(
  to: string[],
  storeName: string,
  newEmail: string | null,
): Promise<void> {
  const where = newEmail ?? "the store owners' emails";
  for (const address of new Set(to)) {
    await getMailer().send({
      to: address,
      template: 'notification_email_changed',
      data: { store_name: storeName, new_email: newEmail ?? '' },
      subject: `Notices for ${storeName} now go to ${where}`,
      text: [
        `Payment and refund notices for ${storeName} on tendr now go to ${where}.`,
        '',
        'If you did not make this change, sign in to your tendr dashboard and set the address',
        'under Settings → Checkout, and check your connected sites.',
      ].join('\n'),
    });
  }
}

/**
 * Uses a verify link: the pending address takes effect, the previous address (or the owners when
 * there was none) is told, and the change is in the audit log. Every failure is INVALID_LINK.
 */
export async function verifyNotificationEmail(
  body: unknown,
): Promise<{ notification_email: string; store_name: string }> {
  const parsed = z
    .object({ token: z.string() })
    .strict()
    .safeParse(body ?? {});
  if (!parsed.success || !TOKEN.test(parsed.data.token)) throw invalidLink();
  const hash = sha256(parsed.data.token);
  const found = await prisma.merchant.findUnique({
    where: { notificationEmailTokenHash: hash },
    select: { id: true, notificationEmailRequest: true },
  });
  const request = found?.notificationEmailRequest as PendingRequest | null | undefined;
  if (!found || !request) throw invalidLink();
  const ctx = { merchantId: found.id, livemode: request.livemode === true };
  return tenantTransaction(ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${ctx.merchantId} FOR UPDATE`;
    const m = await tx.merchant.findUniqueOrThrow({ where: { id: ctx.merchantId } });
    // Re-checked under the lock: a concurrent use or a newer request wins.
    if (
      m.notificationEmailTokenHash !== hash ||
      !m.notificationEmailPending ||
      !m.notificationEmailTokenExpiresAt ||
      m.notificationEmailTokenExpiresAt.getTime() <= Date.now() ||
      m.status !== 'active'
    ) {
      throw invalidLink();
    }
    const email = m.notificationEmailPending;
    await tx.merchant.update({
      where: { id: m.id },
      data: { notificationEmail: email, ...NO_PENDING },
    });
    const { livemode: _mode, ...requestedBy } = request;
    await recordEvent(tx, ctx, {
      aggregateType: 'merchant',
      aggregateId: m.id,
      type: NOTIFICATION_EMAIL_VERIFIED,
      payload: {
        actor: { by: 'verify_link' },
        requested_by: requestedBy,
        before: { notification_email: m.notificationEmail },
        after: { notification_email: email },
      },
    });
    const told = m.notificationEmail ? [m.notificationEmail] : await ownerEmails(m.id);
    await sendNotificationEmailChanged(told, m.name, email);
    return { notification_email: email, store_name: m.name };
  });
}
