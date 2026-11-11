import {
  TendrAbortError,
  TendrApiError,
  TendrConnectionError,
  TendrResponseError,
  TendrTimeoutError,
} from './errors.js';

export interface RequestOptions {
  signal?: AbortSignal;
  /** Override the client's deadline, including reading the response body. */
  timeoutMs?: number;
}
export interface WriteOptions extends RequestOptions {
  /** Persist one key per logical operation. Reuse it with identical input when retrying. */
  idempotencyKey?: string;
}
export interface TendrClientOptions {
  apiKey: string;
  /** Defaults to https://api.usetendr.tech (without /v1). */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
interface InternalOptions extends WriteOptions {
  body?: unknown;
  form?: FormData;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const deadline = (value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError('timeoutMs must be a positive integer no greater than 2147483647');
  }
  return value;
};

export class HttpClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  constructor(opts: TendrClientOptions) {
    if ('window' in globalThis && 'document' in globalThis) {
      throw new Error('TendrClient is server-only. Keep secret API keys out of browser code.');
    }
    if (typeof opts.apiKey !== 'string' || !/^tdr_(test|live)_[^\s]+$/.test(opts.apiKey)) {
      throw new TypeError('apiKey must be a Tendr secret key (tdr_test_ or tdr_live_)');
    }
    const url = new URL(opts.baseUrl ?? 'https://api.usetendr.tech');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(
        'baseUrl must be HTTPS (or HTTP on localhost), without credentials, query, or fragment',
      );
    }
    this.#baseUrl = url.toString().replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = deadline(opts.timeoutMs ?? 15_000);
    this.#fetch = opts.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function')
      throw new TypeError('A fetch implementation is required');
  }

  async request<T>(method: string, path: string, opts: InternalOptions = {}): Promise<T> {
    const timeoutMs = deadline(opts.timeoutMs ?? this.#timeoutMs);
    if (opts.signal?.aborted) throw new TendrAbortError();
    if (
      opts.idempotencyKey !== undefined &&
      (!opts.idempotencyKey.length ||
        opts.idempotencyKey.length > 255 ||
        /[\r\n]/.test(opts.idempotencyKey))
    ) {
      throw new TypeError('idempotencyKey must contain 1–255 characters and no newlines');
    }
    // Serialize once, before I/O; preserve the caller's exact operation and monetary strings.
    const body = opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.#apiKey}`,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    opts.signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      const raw = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        /* Handled below without retaining HTML or secrets. */
      }
      const requestId = response.headers.get('x-request-id') ?? '';
      if (!response.ok) {
        const error = object(json) && object(json.error) ? json.error : {};
        throw new TendrApiError({
          code: typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
          message:
            typeof error.message === 'string'
              ? error.message
              : `Tendr returned HTTP ${response.status}`,
          requestId: typeof error.requestId === 'string' ? error.requestId : requestId,
          status: response.status,
          details: error.details,
          retryAfter: response.headers.get('retry-after'),
        });
      }
      if (!object(json))
        throw new TendrResponseError(
          'Tendr returned an invalid JSON object',
          response.status,
          requestId,
        );
      return json as T;
    } catch (error) {
      if (opts.signal?.aborted) throw new TendrAbortError();
      if (timedOut) throw new TendrTimeoutError(timeoutMs);
      if (error instanceof TendrApiError || error instanceof TendrResponseError) throw error;
      // Fetch errors can contain URLs; never retain API credentials or request bodies in an error.
      throw new TendrConnectionError();
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cancel);
    }
  }
}

export function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : '';
}
export function resourceId(id: string): string {
  // Dot path segments would be normalized by fetch even after encodeURIComponent.
  if (!id || id === '.' || id === '..') throw new TypeError('A resource ID is required');
  return encodeURIComponent(id);
}

/** Fetch only when consumed. Breaking the loop does not fetch additional pages. */
export async function* paginate<T extends { id: string }>(
  load: (cursor?: string) => Promise<{ items: T[]; more: boolean; cursor?: string | null }>,
  initialCursor?: string,
): AsyncGenerator<T> {
  let cursor = initialCursor;
  const seen = new Set<string>();
  if (cursor) seen.add(cursor);
  while (true) {
    const page = await load(cursor);
    for (const item of page.items) yield item;
    if (!page.more) return;
    const next = page.cursor === undefined ? page.items.at(-1)?.id : page.cursor;
    if (!next || seen.has(next) || !page.items.length)
      throw new TendrResponseError('Pagination did not advance');
    seen.add(next);
    cursor = next;
  }
}
