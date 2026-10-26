// Mails for the store's notification email (W16), sent AFTER the settings change commits, from
// the internal events merchants/notification-email.ts records:
// - `merchant.notification_email.requested` → `notification_email_change_requested` to the
//   addresses pinned in the event (the address current at request time, or the verified owners),
//   and `notification_email_verify` (the link) to the pending address — while that request is still
//   the pending one. The raw token is decrypted from KeyVault for the send and deleted after it.
// - `merchant.notification_email.verified` / `.cleared` → `notification_email_changed` to the
//   addresses pinned in the event (the previous address, or the owners).
//
// Recipients here are pinned in the event, not re-read: a warning about a change must reach the
// address that was in effect when the change was asked for, even if the change has since taken
// effect. Each recipient is claimed in `event_notices` (event, template, recipient) and sent
// independently; a failure rethrows after the others are tried, so the job retries only the
// recipients still unsent.
import type { Event } from '@prisma/client';
import type { MailMessage } from '../auth/mailer.js';
import { prisma } from '../lib/prisma.js';
import {
  maskEmail,
  NOTIFICATION_EMAIL_CLEARED,
  NOTIFICATION_EMAIL_REQUESTED,
  NOTIFICATION_EMAIL_VERIFIED,
  verifyLink,
} from '../merchants/notification-email.js';
import { oneLine, sendOncePerEvent } from '../merchants/store-notices.js';
import { deleteSecret, getSecret } from '../secrets/secrets.js';
import { handlerNamesFor, registerEventHandler } from './handlers.js';

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

type Body = Omit<MailMessage, 'to' | 'template'>;

export function verifyMessage(storeName: string, email: string, url: string): Body {
  return {
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
  };
}

export function changeRequestedMessage(storeName: string, newEmail: string, from: string): Body {
  const masked = maskEmail(newEmail);
  return {
    data: { store_name: storeName, masked_new_email: masked, requested_from: from },
    subject: `A new notification email was requested for ${storeName}`,
    text: [
      `A change of notification email to ${masked} was requested from ${from}.`,
      "If this wasn't you, disconnect the site or contact support.",
      '',
      `Payment and refund notices for ${storeName} keep coming here until the new address is`,
      'confirmed from a link sent to it.',
    ].join('\n'),
  };
}

export function changedMessage(storeName: string, newEmail: string | null): Body {
  const where = newEmail ?? "the store owners' emails";
  return {
    data: { store_name: storeName, new_email: newEmail ?? '' },
    subject: `Notices for ${storeName} now go to ${where}`,
    text: [
      `Payment and refund notices for ${storeName} on tendr now go to ${where}.`,
      '',
      'If you did not make this change, sign in to your tendr dashboard and set the address',
      'under Settings → Checkout, and check your connected sites.',
    ].join('\n'),
  };
}

const storeName = async (merchantId: string) => {
  const m = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { name: true } });
  return m ? oneLine(m.name) : null;
};

/** `requested` → the warning to the pinned addresses, and the verify link to the pending one. */
export async function onNotificationEmailRequested(e: Event): Promise<void> {
  if (!e.merchantId) return;
  const p = (e.payload ?? {}) as Payload;
  const pending = str(p.pending_email);
  const name = await storeName(e.merchantId);
  if (!name || !pending) return;
  let failure: unknown = null;

  try {
    await sendOncePerEvent(
      e.id,
      'notification_email_change_requested',
      list(p.notify),
      changeRequestedMessage(name, pending, oneLine(str(p.requested_from)) || 'an unknown source'),
    );
  } catch (err) {
    failure = err;
  }

  // The link only while this request is still the pending one (a newer request, a verify, a
  // clear or a revoke ended it and deleted its token).
  const m = await prisma.merchant.findUnique({
    where: { id: e.merchantId },
    select: {
      notificationEmailPending: true,
      notificationEmailTokenHash: true,
      notificationEmailLinkSecretRef: true,
    },
  });
  const ref = m?.notificationEmailLinkSecretRef;
  if (
    ref &&
    m.notificationEmailPending === pending &&
    m.notificationEmailTokenHash === str(p.token_hash)
  ) {
    try {
      const raw = await getSecret(ref);
      await sendOncePerEvent(e.id, 'notification_email_verify', [pending], {
        ...verifyMessage(name, pending, verifyLink(raw)),
      });
      // Sent: the raw token is no longer needed anywhere (the row keeps only its hash).
      await prisma.$transaction(async (tx) => {
        await tx.merchant.updateMany({
          where: { id: e.merchantId!, notificationEmailLinkSecretRef: ref },
          data: { notificationEmailLinkSecretRef: null },
        });
        await deleteSecret(ref, tx);
      });
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
}

/** `verified` / `cleared` → "notices now go to …" to the pinned previous address (or owners). */
export async function onNotificationEmailChanged(e: Event): Promise<void> {
  if (!e.merchantId) return;
  const p = (e.payload ?? {}) as Payload;
  const name = await storeName(e.merchantId);
  if (!name) return;
  const after = str((p.after as Payload | undefined)?.notification_email) || null;
  await sendOncePerEvent(
    e.id,
    'notification_email_changed',
    list(p.notify),
    changedMessage(name, after),
  );
}

const HANDLERS = [
  [
    NOTIFICATION_EMAIL_REQUESTED,
    'notify-notification-email-requested',
    onNotificationEmailRequested,
  ],
  [NOTIFICATION_EMAIL_VERIFIED, 'notify-notification-email-changed', onNotificationEmailChanged],
  [NOTIFICATION_EMAIL_CLEARED, 'notify-notification-email-changed', onNotificationEmailChanged],
] as const;

/** Registers the notification-email mails (once). */
export function registerNotificationEmailNotices(): void {
  for (const [type, name, fn] of HANDLERS) {
    if (!handlerNamesFor(type).includes(name)) registerEventHandler(type, name, fn);
  }
}
