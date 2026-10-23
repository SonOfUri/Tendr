import type { ErrorCode } from '@tendr/contracts';

export class TendrApiError extends Error {
  readonly code: ErrorCode;
  readonly requestId: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    requestId: string;
    status: number;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = 'TendrApiError';
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.status = opts.status;
    this.details = opts.details;
  }
}
