import { describe, expect, it } from 'vitest';
import { maskEmail, notificationEmailStatus } from './notification-email';

describe('notification email display', () => {
  it('masks an address as a…@x.com', () => {
    expect(maskEmail('alice@x.com')).toBe('a…@x.com');
    expect(maskEmail('broken')).toBe('…');
  });

  it('shows the verified address, or the owners by default', () => {
    expect(
      notificationEmailStatus({
        notification_email: 'orders@shop.example',
        notification_email_pending: null,
      }),
    ).toEqual({ current: 'orders@shop.example', pending: null });
    expect(
      notificationEmailStatus({ notification_email: null, notification_email_pending: null }),
    ).toEqual({ current: "Your store's owners", pending: null });
  });

  it('shows a pending address as waiting for confirmation', () => {
    expect(
      notificationEmailStatus({
        notification_email: null,
        notification_email_pending: 'alice@x.com',
      }),
    ).toEqual({ current: "Your store's owners", pending: 'Waiting for confirmation at a…@x.com' });
  });
});
