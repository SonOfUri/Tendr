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
