import type { ErrorCode } from './contracts.generated.js';

/** An HTTP error from Tendr. Unknown future API codes are preserved. */
export class TendrApiError extends Error {
  readonly code: ErrorCode | (string & Record<never, never>);
  readonly requestId: string;
  readonly status: number;
  readonly details?: unknown;
  /** The raw Retry-After header, when the server provides one. No automatic retries occur. */
  readonly retryAfter: string | null;
  constructor(opts: {
    code: string;
    message: string;
    requestId: string;
    status: number;
    details?: unknown;
    retryAfter?: string | null;
  }) {
    super(opts.message);
    this.name = 'TendrApiError';
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.status = opts.status;
    this.details = opts.details;
    this.retryAfter = opts.retryAfter ?? null;
  }
}

/** The result of a write may be unknown. Reconcile or retry with the SAME idempotency key. */
export class TendrConnectionError extends Error {
  constructor(message = 'Could not reach Tendr', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TendrConnectionError';
  }
}
export class TendrTimeoutError extends TendrConnectionError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Tendr request timed out after ${timeoutMs}ms`);
    this.name = 'TendrTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
export class TendrAbortError extends Error {
  constructor() {
    super('Tendr request was cancelled');
    this.name = 'TendrAbortError';
  }
}
export class TendrResponseError extends Error {
  readonly status: number;
  readonly requestId: string;
  constructor(message: string, status = 200, requestId = '') {
    super(message);
    this.name = 'TendrResponseError';
    this.status = status;
    this.requestId = requestId;
  }
}
export class TendrWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TendrWebhookError';
  }
}
