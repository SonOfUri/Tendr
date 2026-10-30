// Outgoing email. The driver is chosen by `MAIL_DRIVER`:
//   log           development: one log line per mail, and the full message as JSON in
//                 `apps/api/.mail/` (git-ignored), so magic links can be clicked locally;
//   memory        tests: messages are kept in `MemoryMailer.sent`;
//   unconfigured  production's default until a provider is wired: every send fails loudly.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';
import { providerNotConfigured } from '../lib/errors.js';
import { log } from '../lib/logger.js';

export const MailTemplateValues = [
  'verify_email',
  'login_link',
  'invite',
  'proposal_needs_approval',
  'timelock_started',
  'recovery_started',
  'recovery_executes_soon',
  'proposal_executed',
  'recovery_register_link',
  'recovery_session_opened',
  'recovery_passkey_registered',
  'refund_needs_address',
  'payment_held',
  'payment_screening_unresolved',
  'refund_needs_review',
  // Store notices (WooCommerce plugin spec §3, §8): to the store's verified notification email,
  // or its owners. These carry their rendered `subject` and plain `text`.
  'notification_email_verify',
  'notification_email_change_requested',
  'notification_email_changed',
  'payment_received',
  'refund_sent',
  // Integrator hooks (gasless spec §4.3): the contract call still failing after 3 days.
  'hook_failed',
] as const;
export type MailTemplate = (typeof MailTemplateValues)[number];

export type MailMessage = {
  to: string;
  template: MailTemplate;
  data: Record<string, string>;
  /** The rendered subject, for templates whose copy the API writes (plain text, no HTML). */
  subject?: string;
  /** The rendered plain-text body, alongside `subject`. */
  text?: string;
};

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(structuredClone(msg));
  }
  clear(): void {
    this.sent.length = 0;
  }
}

/** `apps/api/.mail/` regardless of the process's working directory. */
const MAIL_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../.mail');

export class LogMailer implements Mailer {
  constructor(private readonly dir = MAIL_DIR) {}
  async send(msg: MailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = resolve(this.dir, `${Date.now()}-${msg.template}-${process.hrtime.bigint()}.json`);
    await writeFile(file, JSON.stringify(msg, null, 2));
    // The data (which holds one-time links) goes to the file only, never to the log stream.
    log('info', 'mail written', { to: msg.to, template: msg.template, file });
  }
}

export class UnconfiguredMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    log('error', 'mail not sent: no mail provider configured', { template: msg.template });
    throw providerNotConfigured('Email delivery is not configured');
  }
}

let current: Mailer | null = null;

export function getMailer(): Mailer {
  if (!current) {
    const driver = env().MAIL_DRIVER;
    current =
      driver === 'memory'
        ? new MemoryMailer()
        : driver === 'log'
          ? new LogMailer()
          : new UnconfiguredMailer();
  }
  return current;
}

/** Replaces the process mailer (tests); `null` re-reads `MAIL_DRIVER` on next use. */
export function setMailer(mailer: Mailer | null): void {
  current = mailer;
}
