import { describe, expect, it } from 'vitest';
import { MailTemplateValues, type MailTemplate } from './mailer.js';
import { renderMail } from './mail-render.js';

const URL1 = 'https://app.usetendr.tech/dashboard/approvals/prop_1';
const action = {
  kind: 'withdraw',
  summary: 'Withdraw 5 usdc to near:abc',
  asset: 'usdc',
  amount: '5',
  proposalId: 'prop_1',
  livemode: 'true',
};
const review = {
  payment_id: 'pay_1',
  session_id: 'cs_1',
  external_ref: 'order-9',
  livemode: 'true',
  url: 'https://app.usetendr.tech/dashboard/review',
};

/** The real `data` keys of each template, read from its call site. */
const DATA: Record<MailTemplate, Record<string, string>> = {
  invoice_notice: { message: 'Invoice update', url: 'https://app.example.com/dashboard/invoices' },
  invoice_verify: {
    url: 'https://invoice.example.com/business#token=secret',
    business: 'Business',
  },
  verify_email: { url: 'https://app.usetendr.tech/verify?token=a' },
  login_link: { url: 'https://app.usetendr.tech/verify?token=b' },
  login_recovery_link: { url: 'https://app.usetendr.tech/recover/login#token=secret' },
  login_recovery_codes_changed: {
    at: '2026-11-11T10:00:00.000Z',
    url: 'https://app.usetendr.tech/settings/login-recovery',
  },
  login_recovery_completed: {
    at: '2026-11-11T10:00:00.000Z',
    url: 'https://app.usetendr.tech/settings/login-recovery',
  },
  invite: {
    url: 'https://app.usetendr.tech/invite/tok',
    storeName: 'Acme',
    role: 'admin',
  },
  proposal_needs_approval: { ...action, url: URL1 },
  timelock_started: { ...action, readyAt: '2026-11-02T10:00:00.000Z', cancelUrl: URL1 },
  recovery_started: {
    recoveryId: 'rec_1',
    executesAt: '2026-11-03T10:00:00.000Z',
    newSignerIds: 'u1,u2',
    livemode: 'true',
    cancelUrl: 'https://app.usetendr.tech/dashboard/recovery',
  },
  recovery_executes_soon: {
    recoveryId: 'rec_1',
    executesAt: '2026-11-03T10:00:00.000Z',
    livemode: 'true',
    cancelUrl: 'https://app.usetendr.tech/dashboard/recovery',
  },
  proposal_executed: { ...action, url: URL1 },
  recovery_register_link: {
    url: 'https://app.usetendr.tech/recover/passkey?token=c',
    store: 'acme',
  },
  recovery_session_opened: { person: 'a@b.co (usr_1)', at: '2026-11-01T10:00:00.000Z' },
  recovery_passkey_registered: { person: 'a@b.co (usr_1)', at: '2026-11-01T10:00:00.000Z' },
  refund_needs_address: {
    merchant_name: 'Acme',
    amount: '5 USDC',
    refund_id: 'ref_1',
    refund_address_url: 'https://pay.usetendr.tech/cs_1/refund-address?t=abc',
  },
  payment_held: { ...review, held_reason: 'sanctions', notice: 'Funds are in your contract.' },
  payment_screening_unresolved: { ...review, attempts: '3' },
  refund_needs_review: {
    ...review,
    refund_id: 'ref_1',
    proposal_id: 'prop_1',
    review_reason: 'no address',
  },
  notification_email_verify: {
    url: 'https://app.usetendr.tech/verify-notification-email?token=d',
    store_name: 'Acme',
    email: 'n@acme.co',
  },
  notification_email_change_requested: {
    store_name: 'Acme',
    masked_new_email: 'n***@acme.co',
    requested_from: 'a site',
  },
  notification_email_changed: { store_name: 'Acme', new_email: 'n@acme.co' },
  payment_received: {
    store_name: 'Acme',
    livemode: 'true',
    payment_id: 'pay_1',
    tx_url: 'https://nearblocks.io/txns/abc',
    dashboard_url: 'https://app.usetendr.tech/dashboard/payments/pay_1',
  },
  refund_sent: {
    store_name: 'Acme',
    livemode: 'true',
    refund_id: 'ref_1',
    tx_url: 'https://nearblocks.io/txns/abc',
    dashboard_url: 'https://app.usetendr.tech/dashboard/payments/pay_1',
  },
  hook_failed: {
    store_name: 'Acme',
    livemode: 'true',
    payment_id: 'pay_1',
    contract: 'hook.near',
    chain: 'near',
    attempts: '5',
    last_error: 'boom',
    dashboard_url: 'https://app.usetendr.tech/dashboard/payments/pay_1',
  },
};

describe('renderMail', () => {
  it('has fixture data for every template', () => {
    expect(Object.keys(DATA).sort()).toEqual([...MailTemplateValues].sort());
  });

  for (const template of MailTemplateValues) {
    it(`renders ${template} from its data`, () => {
      const data = DATA[template];
      const { subject, text } = renderMail({ to: 'x@y.co', template, data });
      expect(subject.trim()).not.toBe('');
      expect(text.trim()).not.toBe('');
      for (const s of [subject, text]) {
        expect(s).not.toMatch(/[{}]/);
        expect(s).not.toContain('undefined');
        expect(s).not.toContain('null');
        expect(s).not.toMatch(/<[a-z]+>/i);
      }
      expect(text).toContain('Tendr');
      for (const v of Object.values(data)) {
        if (/^https?:\/\//.test(v)) expect(text).toContain(v);
      }
    });
  }

  it('puts the action link on its own line', () => {
    const { text } = renderMail({
      to: 'x@y.co',
      template: 'login_link',
      data: DATA.login_link!,
    });
    expect(text.split('\n')).toContain(DATA.login_link!.url);
  });

  it('uses the given subject and text unchanged when both are set', () => {
    const out = renderMail({
      to: 'x@y.co',
      template: 'payment_received',
      data: DATA.payment_received!,
      subject: '[Test] You got paid',
      text: 'body\nline',
    });
    expect(out).toEqual({ subject: '[Test] You got paid', text: 'body\nline' });
  });

  it('marks test-mode notices in the subject', () => {
    const live = renderMail({
      to: 'x@y.co',
      template: 'payment_held',
      data: DATA.payment_held!,
    });
    const test = renderMail({
      to: 'x@y.co',
      template: 'payment_held',
      data: { ...DATA.payment_held!, livemode: 'false' },
    });
    expect(live.subject).not.toMatch(/^\[Test\]/);
    expect(test.subject).toBe(`[Test] ${live.subject}`);
  });
});

describe('renderMail: proposal_executed after a delayed change', () => {
  // Summaries as jobs/account-notices.ts summarizeAction writes them: written for approval, with
  // a delay or an approval warning that no longer holds once the change was carried out.
  it.each([
    [
      'Add signer a@b.co (usr_1) with keys ed25519:ab12 (takes effect 24 h after approval)',
      'Add signer a@b.co (usr_1) with keys ed25519:ab12',
    ],
    [
      'Add saved address near:abc.near (usable 24 h after approval)',
      'Add saved address near:abc.near',
    ],
    [
      'Upgrade the account contract to code 9xYz (NOT a Tendr release — do not approve unless you expected this)',
      'Upgrade the account contract to code 9xYz (NOT a Tendr release)',
    ],
    [
      'Upgrade the account contract to code 9xYz (matches the Tendr release)',
      'Upgrade the account contract to code 9xYz (matches the Tendr release)',
    ],
    ['Withdraw 5 usdc to near:abc', 'Withdraw 5 usdc to near:abc'],
  ])('states "%s" as carried out, without its approval-time qualifier', (summary, done) => {
    const { subject, text } = renderMail({
      to: 'a@b.co',
      template: 'proposal_executed',
      data: { ...action, summary, url: URL1 },
    });
    expect(subject).toBe('A change on your Tendr account was carried out');
    expect(text.split('\n')[0]).toBe(`This approved change was carried out: ${done}.`);
    expect(text).not.toMatch(/after approval|do not approve|takes effect|usable/);
  });
});
