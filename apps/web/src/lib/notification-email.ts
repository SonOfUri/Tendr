// The store's notification email in the dashboard (WooCommerce plugin spec §3, §8): the verified
// address (or the owners by default) and any change still waiting for its verify link.

/** `alice@x.com` → `a…@x.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '…';
  return `${email.charAt(0)}…${email.slice(at)}`;
}

export const OWNERS_DEFAULT = "Your store's owners";

export function notificationEmailStatus(s: {
  notification_email: string | null;
  notification_email_pending: string | null;
}): { current: string; pending: string | null } {
  return {
    current: s.notification_email ?? OWNERS_DEFAULT,
    pending: s.notification_email_pending
      ? `Waiting for confirmation at ${maskEmail(s.notification_email_pending)}`
      : null,
  };
}

/** The verify page's heading and message for a link that did not work. */
export function verifyCopy(kind: 'invalid' | 'error'): { heading: string; message: string | null } {
  return kind === 'invalid'
    ? {
        heading: 'This link can’t be used',
        message: 'This link is invalid, already used, expired, or replaced by a newer one.',
      }
    : { heading: 'We couldn’t confirm your email', message: null };
}

/**
 * A form's values after the server's copy changed from `before` to `after` (C13: another form on
 * the page saved): a field the person edited keeps their value; an untouched one follows the
 * server.
 */
export function keepUnsavedEdits<T extends Record<string, unknown>>(
  form: T,
  before: T,
  after: T,
): T {
  const out = { ...after };
  for (const k of Object.keys(form) as (keyof T)[]) {
    if (form[k] !== before[k]) out[k] = form[k];
  }
  return out;
}
