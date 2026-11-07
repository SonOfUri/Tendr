type MailEnvironment = Record<string, string | undefined>;
const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/** Mail logs contain sign-in links. Only the explicitly enabled local console may expose them. */
export function localMailEnabled(env: MailEnvironment): boolean {
  if (
    env.NODE_ENV !== 'development' ||
    env.API_CONSOLE_ENABLED !== 'true' ||
    env.MAIL_DRIVER !== 'log'
  )
    return false;
  try {
    const web = new URL(env.WEB_URL ?? '');
    const api = new URL(env.NEXT_PUBLIC_API_BASE_URL ?? env.API_BASE_URL ?? '');
    return [web, api].every(
      (url) => ['http:', 'https:'].includes(url.protocol) && loopback(url.hostname),
    );
  } catch {
    return false;
  }
}

export function localMailRequestAllowed(request: Request, env: MailEnvironment): boolean {
  if (!localMailEnabled(env)) return false;
  const expected = new URL(env.WEB_URL!);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  return (
    new URL(request.url).origin === expected.origin &&
    (request.headers.get('host') ?? expected.host) === expected.host &&
    (!origin || origin === expected.origin) &&
    (!site || site === 'same-origin' || site === 'none')
  );
}

export interface LocalMailMessage {
  id: string;
  to: string;
  template: string;
  createdAt: string;
  subject?: string;
  text?: string;
  data: Record<string, string>;
}

/** Render only links belonging to this local app, never arbitrary message HTML or URLs. */
export function localMailLink(raw: string | undefined, origin: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
