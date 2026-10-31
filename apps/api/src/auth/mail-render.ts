// Plain-text copy for every mail template. Templates the API already writes (store notices carry
// `subject` and `text`) pass through unchanged; the rest are built here from `msg.data`, short,
// with the action link on its own line and no HTML. Test-mode notices are marked `[Test]` like
// the store notices are (jobs/payment-notices.ts).
import type { MailMessage, MailTemplate } from './mailer.js';

type Data = Record<string, string>;
type Copy = { subject: string; lines: string[] };

const isUrl = (v: string) => /^https?:\/\//.test(v);

/** A value made safe for one line of copy (and a header): whitespace runs become one space. */
const one = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();

const link = (label: string, url: string | undefined) =>
  url ? [`${label}:`, url] : ([] as string[]);

/** The facts an action notice states: the decoded summary, or its kind. */
const what = (d: Data) => one(d.summary) || one(d.kind) || 'a change to the account';

const COPY: Record<MailTemplate, (d: Data) => Copy> = {
  verify_email: (d) => ({
    subject: 'Confirm your email for Tendr',
    lines: [
      'Confirm your email address to finish setting up Tendr.',
      ...link('Confirm your email', d.url),
      'The link works once and expires soon. If you did not ask for it, ignore this email.',
    ],
  }),
  login_link: (d) => ({
    subject: 'Your Tendr sign-in link',
    lines: [
      'Use this link to sign in to Tendr.',
      ...link('Sign in', d.url),
      'The link works once and expires soon. If you did not ask for it, ignore this email.',
    ],
  }),
  invite: (d) => ({
    subject: `You are invited to ${one(d.storeName) || 'a store'} on Tendr`,
    lines: [
      `You were invited to join ${one(d.storeName) || 'a store'} on Tendr${d.role ? ` as ${one(d.role)}` : ''}.`,
      ...link('Accept the invite', d.url),
      'If you did not expect this, ignore this email.',
    ],
  }),
  proposal_needs_approval: (d) => ({
    subject: 'A Tendr account change needs your approval',
    lines: [
      `A change to your Tendr account needs your approval: ${what(d)}.`,
      ...link('Review and approve', d.url),
    ],
  }),
  timelock_started: (d) => ({
    subject: 'A Tendr account change is waiting out its delay',
    lines: [
      `This change is approved and takes effect${d.readyAt ? ` at ${one(d.readyAt)}` : ' after its delay'}: ${what(d)}.`,
      'If you did not expect it, cancel it before then.',
      ...link('Review or cancel', d.cancelUrl),
    ],
  }),
  recovery_started: (d) => ({
    subject: 'Account recovery was started on your Tendr store',
    lines: [
      `Someone started recovery on your Tendr account. It completes at ${one(d.executesAt)}.`,
      'If you did not expect this, cancel it now.',
      ...link('Review or cancel', d.cancelUrl),
    ],
  }),
  recovery_executes_soon: (d) => ({
    subject: 'Account recovery on your Tendr store completes soon',
    lines: [
      `Recovery on your Tendr account completes at ${one(d.executesAt)}.`,
      'If you did not expect this, cancel it now.',
      ...link('Review or cancel', d.cancelUrl),
    ],
  }),
  proposal_executed: (d) => ({
    subject: 'A change to your Tendr account was made',
    lines: [
      `This change to your Tendr account has taken effect: ${what(d)}.`,
      ...link('Details', d.url),
    ],
  }),
  recovery_register_link: (d) => ({
    subject: 'Register a new passkey for Tendr',
    lines: [
      `Use this link to register a new passkey${d.store ? ` for ${one(d.store)}` : ''} on Tendr.`,
      ...link('Register a passkey', d.url),
      'The link works once and expires soon. If you did not ask for it, ignore this email.',
    ],
  }),
  recovery_session_opened: (d) => ({
    subject: 'A recovery session was opened on your Tendr store',
    lines: [
      `${one(d.person)} opened a recovery session on your Tendr account at ${one(d.at)}.`,
      'If this was not expected, sign in to Tendr and review your account.',
    ],
  }),
  recovery_passkey_registered: (d) => ({
    subject: 'A passkey was registered through Tendr recovery',
    lines: [
      `${one(d.person)} registered a new passkey through recovery on your Tendr account at ${one(d.at)}.`,
      'If this was not expected, sign in to Tendr and review your account.',
    ],
  }),
  refund_needs_address: (d) => ({
    subject: `Where should ${one(d.merchant_name) || 'the store'} send your refund?`,
    lines: [
      `${one(d.merchant_name) || 'The store'} is returning ${one(d.amount)} to you through Tendr, and needs an address to send it to.`,
      ...link('Give a refund address', d.refund_address_url),
    ],
  }),
  payment_held: (d) => ({
    subject: 'A Tendr payment is on hold',
    lines: [
      `Payment ${one(d.payment_id)}${d.external_ref ? ` (${one(d.external_ref)})` : ''} is on hold: ${one(d.held_reason)}.`,
      ...(d.notice ? [one(d.notice)] : []),
      ...link('Review it', d.url),
    ],
  }),
  payment_screening_unresolved: (d) => ({
    subject: 'A Tendr payment needs review',
    lines: [
      `Screening could not finish for payment ${one(d.payment_id)}${d.external_ref ? ` (${one(d.external_ref)})` : ''}${d.attempts ? ` after ${one(d.attempts)} attempts` : ''}.`,
      ...link('Review it', d.url),
    ],
  }),
  refund_needs_review: (d) => ({
    subject: 'A Tendr refund needs review',
    lines: [
      `Refund ${one(d.refund_id)} for payment ${one(d.payment_id)} needs review${d.review_reason ? `: ${one(d.review_reason)}` : ''}.`,
      ...link('Review it', d.url),
    ],
  }),
  // The store notices carry their own subject and text; these cover a message without them.
  notification_email_verify: (d) => ({
    subject: `Confirm the email for ${one(d.store_name) || 'your store'} on Tendr`,
    lines: [
      'Confirm this address to receive payment and refund notices from Tendr.',
      ...link('Confirm', d.url),
    ],
  }),
  notification_email_change_requested: (d) => ({
    subject: `A new notification email was requested for ${one(d.store_name) || 'your store'}`,
    lines: [
      `A change of notification email${d.masked_new_email ? ` to ${one(d.masked_new_email)}` : ''} was requested${d.requested_from ? ` from ${one(d.requested_from)}` : ''}.`,
      'If this was not you, disconnect the site or contact support.',
    ],
  }),
  notification_email_changed: (d) => ({
    subject: `Notices for ${one(d.store_name) || 'your store'} now go to a new address`,
    lines: [
      `Payment and refund notices on Tendr now go to ${one(d.new_email) || "the store owners' emails"}.`,
      'If you did not make this change, sign in to Tendr and check your settings.',
    ],
  }),
  payment_received: (d) => ({
    subject: `You got paid on Tendr${d.store_name ? ` (${one(d.store_name)})` : ''}`,
    lines: [
      `${one(d.store_name) || 'Your store'} received a payment.`,
      ...link('See the payment', d.dashboard_url),
    ],
  }),
  refund_sent: (d) => ({
    subject: `A refund was sent on Tendr${d.store_name ? ` (${one(d.store_name)})` : ''}`,
    lines: [
      `${one(d.store_name) || 'Your store'} sent a refund.`,
      ...link('See the payment', d.dashboard_url),
    ],
  }),
  hook_failed: (d) => ({
    subject: 'A Tendr deposit hook keeps failing',
    lines: [
      `Tendr could not call your contract${d.contract ? ` ${one(d.contract)}` : ''} for payment ${one(d.payment_id)}.`,
      'The payment itself is settled: the funds are in your contract.',
      ...link('See the payment', d.dashboard_url),
    ],
  }),
};

/** Any link in `data` the copy did not place itself: appended, each on its own line. */
function missingLinks(data: Data, text: string): string[] {
  return Object.values(data).filter((v) => isUrl(v) && !text.includes(v));
}

export function renderMail(msg: MailMessage): { subject: string; text: string } {
  if (msg.subject && msg.text) return { subject: msg.subject, text: msg.text };
  const copy = COPY[msg.template](msg.data);
  const body = copy.lines.join('\n');
  const extra = missingLinks(msg.data, body);
  const test = msg.data.livemode === 'false';
  return {
    subject: test ? `[Test] ${copy.subject}` : copy.subject,
    text: [body, ...(extra.length ? ['', ...extra] : []), '', '-- Tendr'].join('\n'),
  };
}
