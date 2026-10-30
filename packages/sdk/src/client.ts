import type { PaymentLinkCreate, PaymentLinkUpdate } from '@tendr/contracts';
import { TendrApiError } from './errors.js';
import type { PaymentLinkObject, PaymentLinkPage } from './types.js';

export interface TendrClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** `note` defaults to `optional`. */
export type PaymentLinkCreateInput = Omit<PaymentLinkCreate, 'note'> & {
  note?: PaymentLinkCreate['note'];
};
export type PaymentLinkListQuery = {
  status?: 'active' | 'inactive';
  include_archived?: boolean;
  limit?: number;
  starting_after?: string;
};

/** The responses are the API's own JSON; there is no client-side parsing to do. */
const asIs = <T>() => ({ parse: (data: unknown) => data as T });

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

  /** Merchant payment links (`/v1/payment_links`). Needs a key with `payment_links:read` / `:write`. */
  readonly paymentLinks = {
    create: (input: PaymentLinkCreateInput, opts?: { idempotencyKey?: string }) =>
      this.request('POST', '/v1/payment_links', asIs<PaymentLinkObject>(), {
        body: input,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (query: PaymentLinkListQuery = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return this.request('GET', `/v1/payment_links${suffix}`, asIs<PaymentLinkPage>());
    },
    retrieve: (id: string) =>
      this.request('GET', `/v1/payment_links/${encodeURIComponent(id)}`, asIs<PaymentLinkObject>()),
    /** `null` clears an optional field; an omitted key leaves it unchanged. `slug` cannot change. */
    update: (id: string, input: PaymentLinkUpdate) =>
      this.request(
        'PATCH',
        `/v1/payment_links/${encodeURIComponent(id)}`,
        asIs<PaymentLinkObject>(),
        {
          body: input,
        },
      ),
    /** Hides the link and makes it unavailable; `update(id, { archived: false })` restores it. */
    archive: (id: string) =>
      this.request(
        'DELETE',
        `/v1/payment_links/${encodeURIComponent(id)}`,
        asIs<PaymentLinkObject>(),
      ),
  };

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
