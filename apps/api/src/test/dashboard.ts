// Test-only helpers for cookie-authenticated dashboard requests.
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  LIVEMODE_HEADER,
  MERCHANT_HEADER,
  SESSION_COOKIE,
} from '@tendr/contracts';
import { createDashboardSession } from '../auth/session.js';
import { getMailer, MemoryMailer } from '../auth/mailer.js';

export type Login = { token: string; csrf: string; userId: string };

/** A live dashboard session for `userId`, as the cookie login would create it. */
export async function loginAs(userId: string): Promise<Login> {
  const s = await createDashboardSession(userId);
  return { token: s.token, csrf: s.csrf, userId };
}

/**
 * Headers for a cookie-authenticated request: session + CSRF cookies, the CSRF header, and the
 * store/mode headers when a merchant is given.
 */
export function dashHeaders(
  login: Login,
  opts: { merchantId?: string; livemode?: boolean; csrf?: string | null } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE}=${login.token}; ${CSRF_COOKIE}=${login.csrf}`,
  };
  if (opts.csrf !== null) headers[CSRF_HEADER] = opts.csrf ?? login.csrf;
  if (opts.merchantId) {
    headers[MERCHANT_HEADER] = opts.merchantId;
    headers[LIVEMODE_HEADER] = String(opts.livemode ?? false);
  }
  return headers;
}

/** Cookies from a response's `set-cookie` headers, by name. */
export function responseCookies(setCookie: string | string[] | undefined): Record<string, string> {
  const list = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  const out: Record<string, string> = {};
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

export function memoryMailer(): MemoryMailer {
  const m = getMailer();
  if (!(m instanceof MemoryMailer)) throw new Error('tests expect MAIL_DRIVER=memory');
  return m;
}

/** The raw token in the last mail of `template` sent to `to` (from its `url`). */
export function tokenFromMail(to: string, template: string): string {
  const msg = [...memoryMailer().sent]
    .reverse()
    .find((m) => m.to === to && m.template === template);
  if (!msg) throw new Error(`no ${template} mail to ${to}`);
  const url = new URL(msg.data.url!);
  return url.searchParams.get('token') ?? url.pathname.split('/').pop()!;
}
