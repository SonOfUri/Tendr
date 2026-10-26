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
  /** A checkout `amount_currency` that is neither an ISO 4217 code we support nor the settlement asset. */
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
  /** A deposit for the current quote is on its way; a new quote would orphan its address. */
  'DEPOSIT_IN_PROGRESS',
  /** A deposit transaction was reported for a quote other than the session's current one. */
  'QUOTE_MISMATCH',
  /** Returning a held (sanctions) payment's funds needs the typed legal-clearance acknowledgement. */
  'LEGAL_ACK_REQUIRED',
  /** An earlier refund proposal for this return may still execute on chain; it must end there first. */
  'PROPOSAL_STILL_LIVE',
  /** The amount that reached the merchant account cannot be verified yet (a held return). */
  'AMOUNT_UNKNOWN',
  /** Connecting a site would add its origin past the store's checkout-domain limit (20). */
  'DOMAIN_LIMIT',
  /**
   * `POST /v1/connect/token`: the authorization code is unknown, used, expired, revoked, or does not
   * match the verifier or site. One code and message for every cause, so nothing is revealed.
   */
  'INVALID_GRANT',
  /**
   * A non-USD checkout session cannot be priced: the FX provider failed, or its rate is more than
   * 10 minutes old. Never served from a stale rate; retry shortly or offer another payment method.
   */
  'FX_RATE_UNAVAILABLE',
  /** `POST /v1/refunds`: the payment is not SETTLED or PARTIALLY_REFUNDED (nothing to refund). */
  'PAYMENT_NOT_REFUNDABLE',
  /**
   * `POST /v1/refunds`: the amount is more than what is left to refund on the payment, or its
   * return (with the network cost the merchant pays) is more than the merchant account holds.
   */
  'AMOUNT_EXCEEDS_REFUNDABLE',
  /**
   * Cancelling a merchant refund that already has a proposal: the signers reject it (or let it
   * expire) on the dashboard, and `refund.cancelled` follows.
   */
  'REFUND_HAS_PROPOSAL',
  /**
   * `PATCH /v1/settings/checkout` with a connection key: the body names a setting a connection may
   * not change (only `default_fee_payer`, `default_gas_payer` and `notification_email`).
   */
  'FIELD_NOT_ALLOWED',
  /**
   * `POST /v1/settings/notification-email/verify`: the link is unknown, already used, expired or
   * replaced by a newer request. One code for every cause.
   */
  'INVALID_LINK',
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
