// Who gets a store's own notices (WooCommerce plugin spec §8): its verified `notification_email`,
// else the store's owners whose emails are verified. Mail only ever goes to a verified address:
// a pending `notification_email` is never a recipient.
//
// Event handlers run at least once per event, so each send is claimed first in `event_notices`
// (unique per event, template and recipient): a replayed job skips everyone already mailed, and a
// failed send releases its claim so the retry mails that recipient only.
import { Prisma } from '@prisma/client';
import { getMailer, type MailMessage, type MailTemplate } from '../auth/mailer.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';

/** The store's owners with a verified email, oldest membership first. */
export async function ownerEmails(merchantId: string): Promise<string[]> {
  const rows = await prisma.merchantUser.findMany({
    where: { merchantId, role: 'owner', user: { emailVerifiedAt: { not: null } } },
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return [...new Set(rows.map((r) => r.user.email))];
}

export type StoreNoticeTarget = {
  name: string;
  recipients: string[];
  paymentEmailsEnabled: boolean;
};

/** The store's notice recipients and switches; null for an unknown store. */
export async function storeNoticeTarget(merchantId: string): Promise<StoreNoticeTarget | null> {
  const m = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { name: true, notificationEmail: true, paymentEmailsEnabled: true },
  });
  if (!m) return null;
  return {
    name: m.name,
    recipients: m.notificationEmail ? [m.notificationEmail] : await ownerEmails(merchantId),
    paymentEmailsEnabled: m.paymentEmailsEnabled,
  };
}

/**
 * Sends `message` to each recipient at most once for (event, template). Throws the first send
 * failure (after releasing that recipient's claim) so the job is retried; returns how many sent.
 */
export async function sendOncePerEvent(
  eventId: string,
  template: MailTemplate,
  recipients: string[],
  message: Omit<MailMessage, 'to' | 'template'>,
): Promise<number> {
  const mailer = getMailer();
  let sent = 0;
  let failure: unknown = null;
  for (const to of new Set(recipients)) {
    const id = newId('ntc');
    try {
      await prisma.eventNotice.create({ data: { id, eventId, recipient: to, template } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
    try {
      await mailer.send({ to, template, ...message });
      sent++;
    } catch (err) {
      await prisma.eventNotice.deleteMany({ where: { id } });
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return sent;
}
