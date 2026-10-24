import { TendrApiError } from './errors.js';

export interface TendrClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class TendrClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TendrClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: { parse: (data: unknown) => T },
    opts?: { body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const data = await this.requestRaw(method, path, opts);
    return schema.parse(data);
  }

  private async requestRaw(
    method: string,
    path: string,
    opts?: { body?: unknown; idempotencyKey?: string },
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json.error ?? {}) as Record<string, unknown>;
        throw new TendrApiError({
          code: (err.code as TendrApiError['code']) ?? 'INTERNAL_ERROR',
          message: String(err.message ?? res.statusText),
          requestId: String(err.requestId ?? ''),
          status: res.status,
          details: err.details,
        });
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}
