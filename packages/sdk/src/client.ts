import type {
  PaymentLinkCreate,
  PaymentLinkUpdate,
  ThemeCreate,
  ThemeFromStore,
  ThemeFromWebsite,
  ThemePreview,
  ThemeUpdate,
} from '@tendr/contracts';
import { TendrApiError } from './errors.js';
import type {
  PaymentLinkObject,
  PaymentLinkPage,
  SessionCreateInput,
  ThemeAssetKind,
  ThemeAssetObject,
  ThemeDeleted,
  ThemeObject,
  ThemePage,
  ThemePresetList,
  ThemePreviewLink,
  ThemeValidation,
} from './types.js';

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

export type ThemeListQuery = { limit?: number; starting_after?: string };

const queryString = (query: object) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
  return qs.size > 0 ? `?${qs.toString()}` : '';
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

  /**
   * Checkout themes (`/v1/themes`). A key needs `themes:read` / `themes:write`. `publish` and
   * `setDefault` change what live shoppers see, so they need a live key.
   */
  readonly themes = {
    presets: () => this.request('GET', '/v1/themes/presets', asIs<ThemePresetList>()),
    list: (query: ThemeListQuery = {}) =>
      this.request('GET', `/v1/themes${queryString(query)}`, asIs<ThemePage>()),
    create: (input: ThemeCreate, opts?: { idempotencyKey?: string }) =>
      this.request('POST', '/v1/themes', asIs<ThemeObject>(), {
        body: input,
        idempotencyKey: opts?.idempotencyKey,
      }),
    retrieve: (id: string) =>
      this.request('GET', `/v1/themes/${encodeURIComponent(id)}`, asIs<ThemeObject>()),
    /** Changes the name and/or the draft; the published version is untouched until `publish`. */
    update: (id: string, input: ThemeUpdate) =>
      this.request('PATCH', `/v1/themes/${encodeURIComponent(id)}`, asIs<ThemeObject>(), {
        body: input,
      }),
    delete: (id: string) =>
      this.request('DELETE', `/v1/themes/${encodeURIComponent(id)}`, asIs<ThemeDeleted>()),
    publish: (id: string) =>
      this.request('POST', `/v1/themes/${encodeURIComponent(id)}/publish`, asIs<ThemeObject>()),
    setDefault: (id: string) =>
      this.request('POST', `/v1/themes/${encodeURIComponent(id)}/default`, asIs<ThemeObject>()),
    /** Checks a document without saving it; `problems` is empty when it is valid. */
    validate: (document: unknown) =>
      this.request('POST', '/v1/themes/validate', asIs<ThemeValidation>(), {
        body: { document },
      }),
    /** A link to a sample checkout or link page showing the draft; valid for 15 minutes. */
    preview: (id: string, opts: ThemePreview) =>
      this.request(
        'POST',
        `/v1/themes/${encodeURIComponent(id)}/preview`,
        asIs<ThemePreviewLink>(),
        { body: opts },
      ),
    /** Creates a draft from a website's brand. Never publishes. */
    fromWebsite: (input: ThemeFromWebsite) =>
      this.request('POST', '/v1/themes/from-website', asIs<ThemeObject>(), { body: input }),
    /** Creates a draft from a connected WooCommerce store's brand. Never publishes. */
    fromStore: (input: ThemeFromStore) =>
      this.request('POST', '/v1/themes/from-store', asIs<ThemeObject>(), { body: input }),
  };

  /** Logos, images and fonts used by themes (`/v1/theme-assets`). Shared by both modes. */
  readonly themeAssets = {
    /** `file` is sent as multipart/form-data; the API checks and re-encodes it. */
    upload: (input: { kind: ThemeAssetKind; file: Blob; filename: string }) => {
      const form = new FormData();
      form.set('kind', input.kind);
      form.set('file', input.file, input.filename);
      return this.request('POST', '/v1/theme-assets', asIs<ThemeAssetObject>(), { form });
    },
    list: () => this.request('GET', '/v1/theme-assets', asIs<{ data: ThemeAssetObject[] }>()),
    delete: (id: string) =>
      this.request(
        'DELETE',
        `/v1/theme-assets/${encodeURIComponent(id)}`,
        asIs<{ id: string; object: 'theme_asset'; deleted: true }>(),
      ),
  };

  /** Checkout sessions (`/v1/checkout/sessions`). */
  readonly checkoutSessions = {
    create: (input: SessionCreateInput, opts?: { idempotencyKey?: string }) =>
      this.request('POST', '/v1/checkout/sessions', asIs<Record<string, unknown>>(), {
        body: input,
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  private async request<T>(
    method: string,
    path: string,
    schema: { parse: (data: unknown) => T },
    opts?: { body?: unknown; form?: FormData; idempotencyKey?: string },
  ): Promise<T> {
    const data = await this.requestRaw(method, path, opts);
    return schema.parse(data);
  }

  private async requestRaw(
    method: string,
    path: string,
    opts?: { body?: unknown; form?: FormData; idempotencyKey?: string },
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      // A FormData body gets its multipart Content-Type (with boundary) from fetch itself.
      if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts?.form ?? (opts?.body !== undefined ? JSON.stringify(opts.body) : undefined),
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
