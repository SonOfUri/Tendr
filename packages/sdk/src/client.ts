import { HttpClient, paginate, queryString, resourceId } from './http.js';
import type { RequestOptions, WriteOptions, TendrClientOptions } from './http.js';
import type {
  CheckoutSession,
  CreatedCheckoutSession,
  GasPolicyInput,
  GasPolicyView,
  GasUsageView,
  GasSponsorship,
  GasSponsorshipListQuery,
  GasSponsorshipPage,
  HookCall,
  HookCallListQuery,
  HookCallPage,
  LinkSettlementOptions,
  PaymentLinkCreateInput,
  PaymentLinkListQuery,
  PaymentLinkObject,
  PaymentLinkPage,
  PaymentLinkUpdate,
  PingResponse,
  RefundCreateInput,
  RefundObject,
  SessionCreateInput,
  ThemeAssetKind,
  ThemeAssetObject,
  ThemeCreate,
  ThemeDeleted,
  ThemeFromStore,
  ThemeFromWebsite,
  ThemeListQuery,
  ThemeObject,
  ThemePage,
  ThemePresetList,
  ThemePreview,
  ThemePreviewLink,
  ThemeUpdate,
  ThemeValidation,
} from './types.js';
export type { TendrClientOptions, RequestOptions, WriteOptions } from './http.js';
export type { PaymentLinkCreateInput, PaymentLinkListQuery, ThemeListQuery } from './types.js';

/** Server-side merchant SDK. The key selects the store and test/live mode. No automatic retries. */
export class TendrClient {
  readonly #http: HttpClient;
  constructor(opts: TendrClientOptions) {
    this.#http = new HttpClient(opts);
  }

  /** Check the selected store/mode and the key's scopes. */
  ping = (opts?: RequestOptions) => this.#http.request<PingResponse>('GET', '/v1/ping', opts);

  readonly checkoutSessions = {
    create: (input: SessionCreateInput, opts?: WriteOptions) =>
      this.#http.request<CreatedCheckoutSession>('POST', '/v1/checkout/sessions', {
        ...opts,
        body: input,
      }),
    retrieve: (id: string, opts?: RequestOptions) =>
      this.#http.request<CheckoutSession>('GET', `/v1/checkout/sessions/${resourceId(id)}`, opts),
    /** Cancels an unpaid session. Does not refund an already settled payment. */
    expire: (id: string, opts?: WriteOptions) =>
      this.#http.request<CheckoutSession>(
        'POST',
        `/v1/checkout/sessions/${resourceId(id)}/expire`,
        opts,
      ),
  };

  /** Refund requests need refunds:write. Wallet approval/execution remain separate. */
  readonly refunds = {
    create: (input: RefundCreateInput, opts?: WriteOptions) =>
      this.#http.request<RefundObject>('POST', '/v1/refunds', { ...opts, body: input }),
    /** Available only before a refund proposal exists. Read progress through the session. */
    cancel: (id: string, opts?: WriteOptions) =>
      this.#http.request<RefundObject>('POST', `/v1/refunds/${resourceId(id)}/cancel`, opts),
  };

  /** Requires payment_links:read / payment_links:write. */
  readonly paymentLinks = {
    settlementOptions: (opts?: RequestOptions) =>
      this.#http.request<LinkSettlementOptions>(
        'GET',
        '/v1/payment_links/settlement-options',
        opts,
      ),
    create: (input: PaymentLinkCreateInput, opts?: WriteOptions) =>
      this.#http.request<PaymentLinkObject>('POST', '/v1/payment_links', { ...opts, body: input }),
    list: (query: PaymentLinkListQuery = {}, opts?: RequestOptions) =>
      this.#http.request<PaymentLinkPage>('GET', `/v1/payment_links${queryString(query)}`, opts),
    iterate: (
      query: PaymentLinkListQuery = {},
      opts?: RequestOptions,
    ): AsyncGenerator<PaymentLinkObject> =>
      paginate(async (cursor) => {
        const page = await this.paymentLinks.list({ ...query, starting_after: cursor }, opts);
        return { items: page.data, more: page.has_more };
      }, query.starting_after),
    retrieve: (id: string, opts?: RequestOptions) =>
      this.#http.request<PaymentLinkObject>('GET', `/v1/payment_links/${resourceId(id)}`, opts),
    /** Null clears an optional field; omission preserves it. Slugs cannot change. */
    update: (id: string, input: PaymentLinkUpdate, opts?: RequestOptions) =>
      this.#http.request<PaymentLinkObject>('PATCH', `/v1/payment_links/${resourceId(id)}`, {
        ...opts,
        body: input,
      }),
    archive: (id: string, opts?: RequestOptions) =>
      this.#http.request<PaymentLinkObject>('DELETE', `/v1/payment_links/${resourceId(id)}`, opts),
  };

  /** Requires themes:read / themes:write. Publishing/default changes need a live key. */
  readonly themes = {
    presets: (opts?: RequestOptions) =>
      this.#http.request<ThemePresetList>('GET', '/v1/themes/presets', opts),
    list: (query: ThemeListQuery = {}, opts?: RequestOptions) =>
      this.#http.request<ThemePage>('GET', `/v1/themes${queryString(query)}`, opts),
    iterate: (query: ThemeListQuery = {}, opts?: RequestOptions): AsyncGenerator<ThemeObject> =>
      paginate(async (cursor) => {
        const page = await this.themes.list({ ...query, starting_after: cursor }, opts);
        return { items: page.data, more: page.has_more };
      }, query.starting_after),
    create: (input: ThemeCreate, opts?: WriteOptions) =>
      this.#http.request<ThemeObject>('POST', '/v1/themes', { ...opts, body: input }),
    retrieve: (id: string, opts?: RequestOptions) =>
      this.#http.request<ThemeObject>('GET', `/v1/themes/${resourceId(id)}`, opts),
    update: (id: string, input: ThemeUpdate, opts?: RequestOptions) =>
      this.#http.request<ThemeObject>('PATCH', `/v1/themes/${resourceId(id)}`, {
        ...opts,
        body: input,
      }),
    delete: (id: string, opts?: RequestOptions) =>
      this.#http.request<ThemeDeleted>('DELETE', `/v1/themes/${resourceId(id)}`, opts),
    publish: (id: string, opts?: WriteOptions) =>
      this.#http.request<ThemeObject>('POST', `/v1/themes/${resourceId(id)}/publish`, opts),
    setDefault: (id: string, opts?: WriteOptions) =>
      this.#http.request<ThemeObject>('POST', `/v1/themes/${resourceId(id)}/default`, opts),
    validate: (document: unknown, opts?: WriteOptions) =>
      this.#http.request<ThemeValidation>('POST', '/v1/themes/validate', {
        ...opts,
        body: { document },
      }),
    preview: (id: string, input: ThemePreview, opts?: WriteOptions) =>
      this.#http.request<ThemePreviewLink>('POST', `/v1/themes/${resourceId(id)}/preview`, {
        ...opts,
        body: input,
      }),
    fromWebsite: (input: ThemeFromWebsite, opts?: WriteOptions) =>
      this.#http.request<ThemeObject>('POST', '/v1/themes/from-website', { ...opts, body: input }),
    fromStore: (input: ThemeFromStore, opts?: WriteOptions) =>
      this.#http.request<ThemeObject>('POST', '/v1/themes/from-store', { ...opts, body: input }),
  };

  readonly themeAssets = {
    /** Fetch supplies the multipart boundary; upload requires themes:write. */
    upload: (
      input: { kind: ThemeAssetKind; file: Blob; filename: string },
      opts?: WriteOptions,
    ) => {
      const form = new FormData();
      form.set('kind', input.kind);
      form.set('file', input.file, input.filename);
      return this.#http.request<ThemeAssetObject>('POST', '/v1/theme-assets', { ...opts, form });
    },
    list: (opts?: RequestOptions) =>
      this.#http.request<{ data: ThemeAssetObject[] }>('GET', '/v1/theme-assets', opts),
    delete: (id: string, opts?: RequestOptions) =>
      this.#http.request<{ id: string; object: 'theme_asset'; deleted: true }>(
        'DELETE',
        `/v1/theme-assets/${resourceId(id)}`,
        opts,
      ),
  };

  readonly gasPolicy = {
    retrieve: (opts?: RequestOptions) =>
      this.#http.request<GasPolicyView>('GET', '/v1/gas-policy', opts),
    /** Changes the store's sponsorship budget. Requires sessions:write; connection keys refused. */
    update: (input: GasPolicyInput, opts?: RequestOptions) =>
      this.#http.request<GasPolicyView>('PUT', '/v1/gas-policy', { ...opts, body: input }),
    usage: (query: { month?: string } = {}, opts?: RequestOptions) =>
      this.#http.request<GasUsageView>('GET', `/v1/gas-policy/usage${queryString(query)}`, opts),
  };
  readonly gasSponsorships = {
    list: (query: GasSponsorshipListQuery = {}, opts?: RequestOptions) =>
      this.#http.request<GasSponsorshipPage>(
        'GET',
        `/v1/gas-sponsorships${queryString(query)}`,
        opts,
      ),
    iterate: (
      query: GasSponsorshipListQuery = {},
      opts?: RequestOptions,
    ): AsyncGenerator<GasSponsorship> =>
      paginate(async (cursor) => {
        const page = await this.gasSponsorships.list({ ...query, starting_after: cursor }, opts);
        return { items: page.gas_sponsorships, more: page.has_more, cursor: page.next_cursor };
      }, query.starting_after),
  };
  readonly hookCalls = {
    list: (query: HookCallListQuery = {}, opts?: RequestOptions) =>
      this.#http.request<HookCallPage>('GET', `/v1/hook-calls${queryString(query)}`, opts),
    iterate: (query: HookCallListQuery = {}, opts?: RequestOptions): AsyncGenerator<HookCall> =>
      paginate(async (cursor) => {
        const page = await this.hookCalls.list({ ...query, starting_after: cursor }, opts);
        return { items: page.hook_calls, more: page.has_more, cursor: page.next_cursor };
      }, query.starting_after),
    /** Retries a failed contract hook, identified by PAYMENT ID. May spend gas; not a payment retry. */
    resend: (paymentId: string, opts?: WriteOptions) =>
      this.#http.request<HookCall>(
        'POST',
        `/v1/payments/${resourceId(paymentId)}/hook/resend`,
        opts,
      ),
  };
}
