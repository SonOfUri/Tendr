// Production mail driver: one POST per message to Resend's HTTP API (no SDK). The API key is
// sent in the Authorization header only; it is never put in the body, an error or a log line.
import { log } from '../lib/logger.js';
import { renderMail } from './mail-render.js';
import type { Mailer, MailMessage } from './mailer.js';

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export class ResendMailer implements Mailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { apiKey: string; from: string; fetch?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async send(msg: MailMessage): Promise<void> {
    const { subject, text } = renderMail(msg);
    let res: Response;
    try {
      res = await this.fetchFn(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: this.from, to: [msg.to], subject, text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = this.scrub(err instanceof Error ? err.message : String(err));
      log('error', 'mail not sent: Resend request failed', { template: msg.template, reason });
      throw new Error(`Resend request failed: ${reason}`);
    }
    if (!res.ok) {
      const detail = this.scrub((await res.text().catch(() => '')).slice(0, 300));
      log('error', 'mail not sent: Resend rejected the message', {
        template: msg.template,
        status: res.status,
        detail,
      });
      throw new Error(`Resend responded ${res.status}`);
    }
  }

  private scrub(s: string): string {
    return s.split(this.apiKey).join('[redacted]');
  }
}
