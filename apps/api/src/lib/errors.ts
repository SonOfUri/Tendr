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
