// The store's notification email (WooCommerce plugin spec §3 "Builder's call (security)", W16).
//
// A new address — from the dashboard or a connected site — never takes effect directly. It is
// stored as `notification_email_pending` with the sha256 of a single-use token (24 h); a new
// request replaces the token, so earlier links stop working. Using the link
// (`POST /v1/settings/notification-email/verify`, public) makes the address effective.
//
// Mail never goes out inside the settings transaction (W16.3). The transaction records an internal
// event; the handlers in jobs/notification-email-notices.ts send after commit, once per (event,
// template, recipient), so a mail failure never rolls a settings change back:
// - `merchant.notification_email.requested` → the verify link to the pending address, and a
//   "change requested" warning to the CURRENT address (or the verified owners when there is none);
// - `merchant.notification_email.verified` / `.cleared` → "notices now go to …" to the previous
//   address (or the owners).
// Recipients of the warnings are pinned in the event when it is recorded, so a quick verify can
// never redirect the warning to the new address.
//
// The raw token (needed for the link) never reaches a log, an event or a plaintext column: it is
// envelope-encrypted with KeyVault (`putSecret`, in the same transaction), referenced from
// `notification_email_link_secret_ref`, and deleted as soon as the link is sent or the pending
// change ends (verified, replaced, cleared, or its connection revoked).
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { deleteSecret, putSecret } from '../secrets/secrets.js';
import { ownerEmails } from './store-notices.js';

type Tx = Prisma.TransactionClient;

export const NOTIFICATION_EMAIL_LINK_TTL_MS = 24 * 60 * 60_000;
export const VERIFY_PATH = '/settings/notification-email/verify';
export const LINK_SECRET_PURPOSE = 'notification_email_link';

/** Internal events (never webhooks). */
export const NOTIFICATION_EMAIL_REQUESTED = 'merchant.notification_email.requested';
export const NOTIFICATION_EMAIL_VERIFIED = 'merchant.notification_email.verified';
export const NOTIFICATION_EMAIL_CLEARED = 'merchant.notification_email.cleared';
export const NOTIFICATION_EMAIL_REQUEST_CANCELLED = 'merchant.notification_email.request_cancelled';

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

export const noOneToNotify = () =>
  new AppError(
    'NO_ONE_TO_NOTIFY',
    'No one could be told about this change: the store has no notification email and no owner with a verified email. Set it from the tendr dashboard.',
    409,
  );

export const verifyLink = (raw: string): string => {
  const url = new URL(VERIFY_PATH, env().WEB_URL);
  url.searchParams.set('t', raw);
  return url.toString();
};

/** `orders@shop.example` → `o***@shop.example`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.charAt(0)}***${email.slice(at)}`;
}

/** The merchant columns the pending-change helpers read (lock the row first). */
export const PENDING_SELECT = {
  id: true,
  name: true,
  notificationEmail: true,
  notificationEmailPending: true,
  notificationEmailRequest: true,
  notificationEmailLinkSecretRef: true,
} as const;
type PendingRow = Prisma.MerchantGetPayload<{ select: typeof PENDING_SELECT }>;

const NO_PENDING = {
  notificationEmailPending: null,
  notificationEmailTokenHash: null,
  notificationEmailTokenExpiresAt: null,
  notificationEmailRequest: Prisma.DbNull,
  notificationEmailLinkSecretRef: null,
} satisfies Prisma.MerchantUncheckedUpdateInput;

/** Ends any pending change: the columns to write, after deleting its encrypted token. */
export async function endPending(
  tx: Tx,
  m: PendingRow,
): Promise<Prisma.MerchantUncheckedUpdateInput> {
  if (m.notificationEmailLinkSecretRef) await deleteSecret(m.notificationEmailLinkSecretRef, tx);
  return NO_PENDING;
}

/** The current address, else the verified owners: who is warned about a change. */
const currentRecipients = async (m: PendingRow) =>
  m.notificationEmail ? [m.notificationEmail] : await ownerEmails(m.id);

async function requestedFrom(tx: Tx, merchantId: string, actor: SettingsActor): Promise<string> {
  if (actor.by === 'user') return 'the tendr dashboard';
  const c = await tx.connection.findFirst({
    where: { id: actor.connectionId, merchantId },
    select: { siteUrl: true },
  });
  return c ? `the connected site ${c.siteUrl}` : 'a connected site';
}

/**
 * Starts a pending change to `email` (inside the caller's transaction, merchant row locked):
 * a new token (its hash on the row, the raw token encrypted for the mailer) replacing any earlier
 * one, and the `requested` event. Returns the columns to write.
 */
export async function requestNotificationEmail(
  tx: Tx,
  ctx: ScopeContext,
  m: PendingRow,
  email: string,
  actor: SettingsActor,
  now = new Date(),
): Promise<Prisma.MerchantUncheckedUpdateInput> {
  const notify = await currentRecipients(m);
  // C12: the warning to the current address (or the owners) is what makes a change by a
  // connected site visible. With no one to warn, a site cannot change it; a signed-in member
  // can, from the dashboard.
  if (notify.length === 0 && actor.by === 'connection') throw noOneToNotify();
  await endPending(tx, m);
  const raw = randomBytes(32).toString('base64url');
  const tokenHash = sha256(raw);
  const secretRef = await putSecret(raw, LINK_SECRET_PURPOSE, tx);
  const request: PendingRequest = { ...actor, livemode: ctx.livemode };
  await recordEvent(tx, ctx, {
    aggregateType: 'merchant',
    aggregateId: m.id,
    type: NOTIFICATION_EMAIL_REQUESTED,
    payload: {
      pending_email: email,
      // The hash only identifies the request; the token itself is never in an event.
      token_hash: tokenHash,
      requested_by: actor,
      requested_from: await requestedFrom(tx, m.id, actor),
      notify,
    },
  });
  return {
    notificationEmailPending: email,
    notificationEmailTokenHash: tokenHash,
    notificationEmailTokenExpiresAt: new Date(now.getTime() + NOTIFICATION_EMAIL_LINK_TTL_MS),
    notificationEmailRequest: request,
    notificationEmailLinkSecretRef: secretRef,
  };
}

/** Back to the owners: ends any pending change and, when an address was set, tells it. */
export async function clearNotificationEmail(
  tx: Tx,
  ctx: ScopeContext,
  m: PendingRow,
  actor: SettingsActor,
): Promise<Prisma.MerchantUncheckedUpdateInput> {
  const data = await endPending(tx, m);
  if (m.notificationEmail) {
    await recordEvent(tx, ctx, {
      aggregateType: 'merchant',
      aggregateId: m.id,
      type: NOTIFICATION_EMAIL_CLEARED,
      payload: {
        actor,
        before: { notification_email: m.notificationEmail },
        after: { notification_email: null },
        notify: [m.notificationEmail],
      },
    });
  }
  return { ...data, notificationEmail: null };
}

/**
 * Revoking a connection (W16.2, from `revokeConnection`, merchant row already locked) ends a
 * pending change that connection requested, so a disconnected site's address never takes effect.
 */
export async function cancelPendingForConnection(
  tx: Tx,
  merchantId: string,
  connectionId: string,
): Promise<void> {
  const m = await tx.merchant.findUnique({ where: { id: merchantId }, select: PENDING_SELECT });
  const request = m?.notificationEmailRequest as PendingRequest | null | undefined;
  if (!m || request?.by !== 'connection' || request.connectionId !== connectionId) return;
  await tx.merchant.update({ where: { id: merchantId }, data: await endPending(tx, m) });
  await recordEvent(
    tx,
    { merchantId, livemode: request.livemode === true },
    {
      aggregateType: 'merchant',
      aggregateId: merchantId,
      type: NOTIFICATION_EMAIL_REQUEST_CANCELLED,
      payload: {
        reason: 'connection_revoked',
        connection_id: connectionId,
        pending_email: m.notificationEmailPending,
      },
    },
  );
}

/**
 * Uses a verify link: the pending address takes effect, its encrypted token is deleted, and the
 * `verified` event (whose handler tells the previous address, or the owners) is recorded. Every
 * failure is INVALID_LINK.
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
    const data = await endPending(tx, m);
    await tx.merchant.update({ where: { id: m.id }, data: { ...data, notificationEmail: email } });
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
        notify: await currentRecipients(m),
      },
    });
    return { notification_email: email, store_name: m.name };
  });
}

/** An unreferenced link token is deleted only once it is this old (never one still committing). */
export const ORPHAN_LINK_SECRET_AGE_MS = 60 * 60_000;

/**
 * Notification-email housekeeping (C12, worker, every minute):
 * - a pending change whose link expired is ended (its encrypted token deleted, the columns
 *   cleared), so an expired token never lingers in KeyVault;
 * - a link token no store refers to (left by an interrupted cleanup) is deleted once it is older
 *   than ORPHAN_LINK_SECRET_AGE_MS.
 * Returns how many of each it removed.
 */
export async function sweepNotificationEmailLinks(
  now = new Date(),
): Promise<{ expired: number; orphans: number }> {
  let expired = 0;
  const due = await prisma.merchant.findMany({
    where: {
      notificationEmailPending: { not: null },
      notificationEmailTokenExpiresAt: { lte: now },
    },
    select: { id: true },
    take: 500,
  });
  for (const d of due) {
    const ended = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${d.id} FOR UPDATE`;
      const m = await tx.merchant.findUnique({
        where: { id: d.id },
        select: { ...PENDING_SELECT, notificationEmailTokenExpiresAt: true },
      });
      const at = m?.notificationEmailTokenExpiresAt;
      if (!m || !m.notificationEmailPending || !at || at > now) return false;
      await tx.merchant.update({ where: { id: m.id }, data: await endPending(tx, m) });
      return true;
    });
    if (ended) expired += 1;
  }

  const referenced = await prisma.merchant.findMany({
    where: { notificationEmailLinkSecretRef: { not: null } },
    select: { notificationEmailLinkSecretRef: true },
  });
  const keep = referenced.map((r) => r.notificationEmailLinkSecretRef!);
  const { count: orphans } = await prisma.secret.deleteMany({
    where: {
      purpose: LINK_SECRET_PURPOSE,
      id: { notIn: keep },
      createdAt: { lte: new Date(now.getTime() - ORPHAN_LINK_SECRET_AGE_MS) },
    },
  });
  if (expired > 0 || orphans > 0) {
    log('info', 'swept notification email links', { expired, orphans });
  }
  return { expired, orphans };
}
