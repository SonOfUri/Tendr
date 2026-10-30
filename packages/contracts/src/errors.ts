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
  /**
   * A connected site asked to change the notification email, but no one could be warned about it:
   * the store has no notification email and no owner with a verified email. Set it from the
   * dashboard instead.
   */
  'NO_ONE_TO_NOTIFY',
  /**
   * A shopper-paid network fee cannot be priced in the payment token: the 1Click token list has no
   * price for it. The "pay the fee in the token" option is unavailable for that token.
   */
  'FEE_TOKEN_UNPRICED',
  /** The live network fee for a chain could not be estimated (RPC or price unavailable). */
  'NETWORK_FEE_UNAVAILABLE',
  /**
   * Gasless submit: a signed field (destination, amount, fee, fee recipient, deadline, nonce) or
   * the signer does not match the quote. `details.field` names the first difference. No gas spent.
   */
  'GASLESS_PAYLOAD_MISMATCH',
  /** Gasless prepare/submit: the quote's deadline passed or a newer quote replaced it; re-quote. */
  'QUOTE_EXPIRED',
  /**
   * Gasless prepare/submit: the quote has no gasless method for this wallet and token (a
   * copy-address quote, `fee_mode: native`, or a token off the allow-list).
   */
  'GASLESS_NOT_AVAILABLE',
  /**
   * Gasless submit: the merchant-sponsored quote's budget hold was released (replaced, expired or
   * failed); re-quote to see who pays the fee now.
   */
  'SPONSORSHIP_RELEASED',
  /**
   * Gasless submit: the chain refused the payment before any gas was spent (its dry run reverted:
   * e.g. the balance is too low or the authorization was already used). `details.reason`.
   */
  'GASLESS_SUBMIT_FAILED',
  /**
   * Gasless submit (Solana): the signed transaction's blockhash is too old (over 60 s since it
   * was prepared) or was not issued for this quote. Nothing spent; call prepare again and re-sign.
   */
  'GASLESS_EXPIRED',
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
