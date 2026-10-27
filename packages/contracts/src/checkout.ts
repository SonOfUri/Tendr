import { z } from 'zod';
import type { ResolvedGasSponsor, StoredFeePayer } from './enums.js';

/**
 * Webhook event types: the checkout spec §8 list, plus the gas budget events (gasless spec §5):
 * `gas.budget_low` (reserved + spent crossed 80 % of the month's budget) and
 * `gas.budget_exhausted` (a sponsorship was refused for budget), each at most once a month.
 */
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
  'refund.cancelled',
  'refund.failed',
  'gas.budget_low',
  'gas.budget_exhausted',
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
/** Default 1Click slippage tolerance (bps); the API overrides it with `CHECKOUT_SLIPPAGE_BPS`. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/**
 * Default per-session cap (USD) on the merchant's gas reimbursement when neither the session nor
 * the payment link sets `gas_max_usd`; the API overrides it with `CHECKOUT_GAS_MAX_USD`.
 */
export const DEFAULT_GAS_MAX_USD = 2;
/** Webhook retries back off exponentially and give up after this long. */
export const WEBHOOK_RETRY_WINDOW_MS = 3 * 24 * 3600_000;

/**
 * The non-custodial hold notice, verbatim (spec "Changes after external plan review" #3): shown on
 * every held payment in the dashboard, in the signer email and in the docs.
 */
export const HOLD_NOTICE =
  'These funds came from a sanctioned address. Tendr cannot freeze them; you are responsible for not using them; get legal advice.';

/** What an owner must type, exactly, before a held payment's funds can be returned. */
export const LEGAL_ACK_PHRASE = 'I have legal clearance to refund this payment';

/** Most checkout domains (origins allowed to frame the checkout) a merchant may register. */
export const MAX_CHECKOUT_DOMAINS = 20;
