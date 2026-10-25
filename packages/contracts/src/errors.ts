import { z } from 'zod';

export const ErrorCodes = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'UNAUTHORIZED',
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
