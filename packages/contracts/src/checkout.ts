import { z } from 'zod';
import type { ResolvedGasSponsor, StoredFeePayer } from './enums.js';

/** Webhook event types, exactly the checkout spec §8 list. */
export const WebhookEventTypeValues = [
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
] as const;
export type WebhookEventType = (typeof WebhookEventTypeValues)[number];
export const WebhookEventTypeSchema = z.enum(WebhookEventTypeValues);

/**
 * Who pays fees, as the API speaks it. Stored in the `fee_payer` Postgres enum, whose shopper
 * value is `payer`: map with `feePayerToDb` / `feePayerFromDb` at the API boundary.
 */
export const FeePayerValues = ['merchant', 'shopper'] as const;
export type FeePayer = (typeof FeePayerValues)[number];
export const FeePayerSchema = z.enum(FeePayerValues);

/**
 * Who pays gas, as the API speaks it. Stored in the `resolved_gas_sponsor` Postgres enum, whose
 * shopper value is `buyer`: map with `gasPayerToDb` / `gasPayerFromDb` at the API boundary.
 */
export const GasPayerValues = ['merchant', 'shopper'] as const;
export type GasPayer = (typeof GasPayerValues)[number];
export const GasPayerSchema = z.enum(GasPayerValues);

export function feePayerToDb(p: FeePayer): StoredFeePayer {
  return p === 'shopper' ? 'payer' : 'merchant';
}

export function feePayerFromDb(p: StoredFeePayer): FeePayer {
  return p === 'payer' ? 'shopper' : 'merchant';
}

export function gasPayerToDb(p: GasPayer): ResolvedGasSponsor {
  return p === 'shopper' ? 'buyer' : 'merchant';
}

export function gasPayerFromDb(p: ResolvedGasSponsor): GasPayer {
  return p === 'buyer' ? 'shopper' : 'merchant';
}

/** Returns worth less than this (USD) are kept by the merchant (`kept_small_overpayment`). */
export const SMALL_OVERPAY_USD = 1;
/** Default session lifetime; a store may shorten it with `expires_in`. */
export const SESSION_TTL_MS = 30 * 60_000;
/** Quote deadline from now, never later than the session's `expires_at`. */
export const QUOTE_TTL_MS = 12 * 60_000;
/** Webhook retries back off exponentially and give up after this long. */
export const WEBHOOK_RETRY_WINDOW_MS = 3 * 24 * 3600_000;
