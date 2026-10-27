import { Prisma } from '@prisma/client';
import type { ErrorCode } from '@tendr/contracts';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function notFound(message = 'Resource not found') {
  return new AppError('NOT_FOUND', message, 404);
}

export function unauthorized(message = 'Unauthorized') {
  return new AppError('UNAUTHORIZED', message, 401);
}

export function forbidden(message = 'Forbidden') {
  return new AppError('FORBIDDEN', message, 403);
}

export function conflict(message: string, details?: unknown) {
  return new AppError('CONFLICT', message, 409, details);
}

export function invalidState(message: string) {
  return new AppError('INVALID_STATE_TRANSITION', message, 409);
}

export function providerNotConfigured(message: string) {
  return new AppError('PROVIDER_NOT_CONFIGURED', message, 503);
}

/**
 * Prisma errors a route can trigger by input alone, mapped to fixed public messages so a
 * unique-violation or missing-row probe is a 4xx without internal details, never a 500.
 */
export const PRISMA_ERRORS: Partial<
  Record<string, { status: number; code: 'CONFLICT' | 'NOT_FOUND'; message: string }>
> = {
  P2002: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
};

/** The public mapping of a known Prisma error (`PRISMA_ERRORS`), or undefined. */
export function prismaErrorFor(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? PRISMA_ERRORS[error.code]
    : undefined;
}
