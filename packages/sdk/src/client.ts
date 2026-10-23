import {
  CheckoutSessionSchema,
  CreateCheckoutSessionRequestSchema,
  CreateQuoteRequestSchema,
  CreateWebhookEndpointRequestSchema,
  PaymentSchema,
  QuoteSchema,
  type CreateCheckoutSessionRequest,
  type CreateQuoteRequest,
  type CreateWebhookEndpointRequest,
  type CheckoutSession,
  type Payment,
  type Quote,
} from '@tendr/contracts';
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

  async createCheckoutSession(
    body: CreateCheckoutSessionRequest,
    opts?: { idempotencyKey?: string },
  ): Promise<CheckoutSession> {
    const parsed = CreateCheckoutSessionRequestSchema.parse(body);
    return this.request('POST', '/v1/checkout/sessions', CheckoutSessionSchema, {
      body: parsed,
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  async getCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    return this.request('GET', `/v1/checkout/sessions/${sessionId}`, CheckoutSessionSchema);
  }

  async createQuote(sessionId: string, body: CreateQuoteRequest = {}): Promise<Quote> {
    const parsed = CreateQuoteRequestSchema.parse(body);
    return this.request('POST', `/v1/checkout/sessions/${sessionId}/quote`, QuoteSchema, {
      body: parsed,
    });
  }

  async confirmCheckout(
    sessionId: string,
    quoteId: string,
  ): Promise<{ session: CheckoutSession; payment: Payment }> {
    const data = await this.requestRaw('POST', `/v1/checkout/sessions/${sessionId}/confirm`, {
      body: { quoteId },
    });
    return {
      session: CheckoutSessionSchema.parse(data.session),
      payment: PaymentSchema.parse(data.payment),
    };
  }

  async getPayment(paymentId: string): Promise<Payment> {
    return this.request('GET', `/v1/payments/${paymentId}`, PaymentSchema);
  }

  async createWebhookEndpoint(body: CreateWebhookEndpointRequest) {
    const parsed = CreateWebhookEndpointRequestSchema.parse(body);
    return this.requestRaw('POST', '/v1/webhooks/endpoints', { body: parsed });
  }

  async listWebhookEndpoints() {
    return this.requestRaw('GET', '/v1/webhooks/endpoints');
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
  ): Promise<any> {
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
