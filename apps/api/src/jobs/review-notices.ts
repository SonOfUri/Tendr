// Signer emails for the merchant review queue (Ruling C23): `payment.held` (with the verbatim
// non-custodial notice), `payment.screening_unresolved` and `refund.needs_review`. These are
// internal ops events — never webhooks (checkout/webhooks.ts fans out only the spec §8 list).
//
// Handlers run at least once per event, so each send is claimed first in `event_notices`
// (unique per event and recipient): a replayed job skips everyone already mailed, and a failed
// send releases its claim so the retry mails that signer only.
import { Prisma, type Event } from '@prisma/client';
import { HOLD_NOTICE } from '@tendr/contracts';
import { getMailer, type MailTemplate } from '../auth/mailer.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { listMembers } from '../merchants/team.js';
import { handlerNamesFor, registerEventHandler } from './handlers.js';

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

const reviewUrl = () => new URL('/dashboard/review', env().WEB_URL).toString();

/**
 * Mails every current signer of the event's store, at most once per (event, signer). Throws if any
 * send fails (after releasing that signer's claim), so the job is retried.
 */
async function notifySignersOnce(
  e: Event,
  template: MailTemplate,
  data: Record<string, string>,
): Promise<number> {
  if (!e.merchantId || e.livemode === null) return 0;
  const signers = (await listMembers(e.merchantId)).filter((m) => m.isSigner).map((m) => m.email);
  const mailer = getMailer();
  let sent = 0;
  let failure: unknown = null;
  for (const to of new Set(signers)) {
    const id = newId('ntc');
    try {
      await prisma.eventNotice.create({ data: { id, eventId: e.id, recipient: to, template } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
    try {
      await mailer.send({ to, template, data });
      sent++;
    } catch (err) {
      await prisma.eventNotice.deleteMany({ where: { id } });
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return sent;
}

const common = (e: Event, p: Payload) => ({
  payment_id: str(p.payment_id),
  session_id: str(p.session_id),
  external_ref: str(p.external_ref),
  livemode: String(e.livemode),
  url: reviewUrl(),
});

/** `payment.held` → `payment_held`, carrying the non-custodial notice verbatim. */
export async function onPaymentHeldNotice(e: Event): Promise<void> {
  const p = (e.payload ?? {}) as Payload;
  await notifySignersOnce(e, 'payment_held', {
    ...common(e, p),
    held_reason: str(p.held_reason) || 'sanctions',
    notice: HOLD_NOTICE,
  });
}

/** `payment.screening_unresolved` → `payment_screening_unresolved` (a review item, not a hold). */
export async function onScreeningUnresolvedNotice(e: Event): Promise<void> {
  const p = (e.payload ?? {}) as Payload;
  await notifySignersOnce(e, 'payment_screening_unresolved', {
    ...common(e, p),
    attempts: str(p.attempts),
  });
}

/** `refund.needs_review` → `refund_needs_review`. */
export async function onRefundNeedsReviewNotice(e: Event): Promise<void> {
  const p = (e.payload ?? {}) as Payload;
  await notifySignersOnce(e, 'refund_needs_review', {
    ...common(e, p),
    refund_id: str(p.refund_id),
    proposal_id: str(p.proposal_id),
    review_reason: str(p.review_reason),
  });
}

const HANDLERS = [
  ['payment.held', 'notify-payment-held', onPaymentHeldNotice],
  ['payment.screening_unresolved', 'notify-screening-unresolved', onScreeningUnresolvedNotice],
  ['refund.needs_review', 'notify-refund-needs-review', onRefundNeedsReviewNotice],
] as const;

/** Registers the review-item signer notices (once). */
export function registerReviewNotices(): void {
  for (const [type, name, fn] of HANDLERS) {
    if (!handlerNamesFor(type).includes(name)) registerEventHandler(type, name, fn);
  }
}
