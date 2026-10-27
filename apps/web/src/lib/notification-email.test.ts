import { describe, expect, it } from 'vitest';
import {
  keepUnsavedEdits,
  maskEmail,
  notificationEmailStatus,
  verifyCopy,
} from './notification-email';

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

describe('C13: the verify page', () => {
  it('an invalid or used link gets a neutral heading, not "expired"', () => {
    expect(verifyCopy('invalid').heading).toBe('This link can’t be used');
    expect(verifyCopy('invalid').heading).not.toContain('expired');
    expect(verifyCopy('error').heading).toBe('We couldn’t confirm your email');
  });
});

describe('C13: saving one form keeps the other form’s unsaved edits', () => {
  it('fields the person changed keep their value; untouched ones follow the server', () => {
    const before = { domains: 'https://a.example', fee: 'merchant', gas: 'shopper' };
    const after = { domains: 'https://a.example', fee: 'shopper', gas: 'shopper' };
    const form = {
      domains: 'https://a.example\nhttps://b.example',
      fee: 'merchant',
      gas: 'shopper',
    };
    expect(keepUnsavedEdits(form, before, after)).toEqual({
      domains: 'https://a.example\nhttps://b.example',
      fee: 'shopper',
      gas: 'shopper',
    });
  });
});
