import { z } from 'zod';

export const ErrorCodes = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'UNAUTHORIZED',
  /**
   * A cookie-authenticated (dashboard) request with no live session: missing, expired or revoked.
   * The dashboard sends the person to sign in on this code only; `UNAUTHORIZED` stays for API keys
   * and for failed ceremonies (a passkey that did not verify), which must not sign anyone out.
   */
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'SIGNATURE_INVALID',
  'INVALID_STATE_TRANSITION',
  'PROVIDER_NOT_CONFIGURED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'EXPIRED',
  /** A recent passkey assertion is required (`POST /v1/auth/passkeys/step-up/*`). */
  'STEP_UP_REQUIRED',
  /** A checkout quote is worth less than the minimum (USD 0.50) 1Click and Tendr will route. */
  'QUOTE_TOO_SMALL',
  /** The real quote drifted from the dry-quote target past the tolerance; request a new quote. */
  'QUOTE_PRICE_MOVED',
  /** A checkout `amount_currency` that is neither `USD` nor the merchant's settlement asset. */
  'UNSUPPORTED_CURRENCY',
  /** The store cannot take payments in this mode yet: no active merchant account or settlement config. */
  'ACCOUNT_NOT_READY',
  /** An external provider (e.g. 1Click) failed or timed out; retry later. */
  'PROVIDER_UNAVAILABLE',
  /** An asset the provider does not list (e.g. a settlement asset 1Click cannot route). */
  'UNSUPPORTED_ASSET',
  /** The checkout session's lifetime is over (or it was canceled); no new quotes or payments. */
  'SESSION_EXPIRED',
  /** The wallet / refund address failed sanctions screening; it cannot be used to pay. */
  'WALLET_NOT_ALLOWED',
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ErrorCodes),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
