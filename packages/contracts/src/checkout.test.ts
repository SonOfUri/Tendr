import { describe, expect, it } from 'vitest';
import {
  FeePayerValues,
  GasPayerValues,
  QUOTE_TTL_MS,
  SESSION_TTL_MS,
  SMALL_OVERPAY_USD,
  WEBHOOK_RETRY_WINDOW_MS,
  HOOK_DATA_MAX_BYTES,
  HookDataSchema,
  WebhookEventTypeSchema,
  WebhookEventTypeValues,
  feePayerFromDb,
  feePayerToDb,
  gasPayerFromDb,
  gasPayerToDb,
} from './checkout.js';

describe('checkout contracts', () => {
  it('webhook event types are exactly the spec §8 list', () => {
    expect([...WebhookEventTypeValues]).toEqual([
      'checkout.session.expired',
      'payment.detected',
      'payment.processing',
      'payment.succeeded',
      'payment.refunded',
      'payment.late',
      'payment.held',
      'refund.pending',
      'refund.sent',
      'refund.needs_address',
      'refund.cancelled',
      'refund.failed',
      'gas.budget_low',
      'gas.budget_exhausted',
      'hook.succeeded',
      'hook.failed',
    ]);
    expect(WebhookEventTypeSchema.safeParse('payment.settled').success).toBe(false);
  });

  it('payer values', () => {
    expect([...FeePayerValues]).toEqual(['merchant', 'shopper']);
    expect([...GasPayerValues]).toEqual(['merchant', 'shopper']);
  });

  it('maps shopper to the stored payer/buyer values and back', () => {
    expect(feePayerToDb('shopper')).toBe('payer');
    expect(feePayerToDb('merchant')).toBe('merchant');
    expect(feePayerFromDb('payer')).toBe('shopper');
    expect(feePayerFromDb('merchant')).toBe('merchant');
    expect(gasPayerToDb('shopper')).toBe('buyer');
    expect(gasPayerToDb('merchant')).toBe('merchant');
    expect(gasPayerFromDb('buyer')).toBe('shopper');
    expect(gasPayerFromDb('merchant')).toBe('merchant');
  });

  it('timers and thresholds', () => {
    expect(SMALL_OVERPAY_USD).toBe(1);
    expect(SESSION_TTL_MS).toBe(30 * 60_000);
    expect(QUOTE_TTL_MS).toBe(12 * 60_000);
    expect(WEBHOOK_RETRY_WINDOW_MS).toBe(3 * 24 * 3600_000);
  });

  it('hook_data: any JSON value up to 1 KB serialized (UTF-8 bytes)', () => {
    expect(HOOK_DATA_MAX_BYTES).toBe(1024);
    expect(HookDataSchema.safeParse({ player: 'p-1', nested: [1, true, null] }).success).toBe(true);
    expect(HookDataSchema.safeParse('order-7').success).toBe(true);
    // 1024 bytes exactly: '"' + 1022 x + '"'.
    expect(HookDataSchema.safeParse('x'.repeat(1022)).success).toBe(true);
    expect(HookDataSchema.safeParse('x'.repeat(1023)).success).toBe(false);
    // Multi-byte characters count as their UTF-8 bytes.
    expect(HookDataSchema.safeParse('é'.repeat(511)).success).toBe(true);
    expect(HookDataSchema.safeParse('é'.repeat(512)).success).toBe(false);
    // null is not hook data (omit the field instead); undefined / functions are not JSON.
    expect(HookDataSchema.safeParse(null).success).toBe(false);
    expect(HookDataSchema.safeParse(undefined).success).toBe(false);
  });
});
