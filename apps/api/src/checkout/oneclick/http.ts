// The live 1Click client (v0 API). Auth: the JWT goes in `X-API-Key` (the older
// `Authorization: Bearer` form is legacy). Every wire → type mapping lives in this file.
import {
  ONECLICK_STATUSES,
  OneClickError,
  truncateUntrusted,
  type OneClickProvider,
  type OneClickStatus,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
  type SwapDetails,
  type TokenInfo,
  type TxHashRef,
} from './types.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_ONECLICK_TIMEOUT_MS = 15_000;

export interface HttpOneClickOptions {
  baseUrl: string;
  /** JWT. Without one, 1Click serves unauthenticated (higher-fee) pricing. */
  apiKey?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

export class HttpOneClick implements OneClickProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpOneClickOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_ONECLICK_TIMEOUT_MS;
  }

  async tokens(): Promise<TokenInfo[]> {
    const body = await this.request('GET', '/v0/tokens');
    if (!Array.isArray(body)) throw badResponse('/v0/tokens', 'expected an array');
    return body.map((t) => toTokenInfo(asObject(t, '/v0/tokens')));
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return toQuoteResponse(asObject(await this.request('POST', '/v0/quote', req), '/v0/quote'));
  }

  async status(depositAddress: string): Promise<StatusResponse> {
    const qs = new URLSearchParams({ depositAddress }).toString();
    return toStatusResponse(asObject(await this.request('GET', `/v0/status?${qs}`), '/v0/status'));
  }

  async submitDeposit(txHash: string, depositAddress: string): Promise<void> {
    await this.request('POST', '/v0/deposit/submit', { txHash, depositAddress });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: object): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new OneClickError(
          `1Click ${method} ${path} timed out after ${this.timeoutMs} ms`,
          null,
          'TIMEOUT',
        );
      }
      throw new OneClickError(
        `1Click ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        null,
        'NETWORK',
      );
    } finally {
      clearTimeout(timer);
    }

    const parsed = parseJson(text);
    if (!res.ok) {
      const errBody = isObject(parsed) ? parsed : {};
      const message =
        typeof errBody.message === 'string'
          ? errBody.message
          : `1Click ${method} ${path} answered HTTP ${res.status}`;
      const code =
        typeof errBody.code === 'string'
          ? errBody.code
          : typeof errBody.error === 'string' && /^[A-Z][A-Z0-9_]*$/.test(errBody.error)
            ? errBody.error
            : `HTTP_${res.status}`;
      // The provider's message and code are untrusted text bound for API errors and logs (T3).
      throw new OneClickError(
        truncateUntrusted(message),
        res.status,
        truncateUntrusted(code),
        parsed ?? truncateUntrusted(text),
      );
    }
    return parsed;
  }
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asObject(v: unknown, where: string): Json {
  if (!isObject(v)) throw badResponse(where, 'expected an object');
  return v;
}

function badResponse(where: string, why: string): OneClickError {
  // `why` can carry provider text (an unknown status): truncated (T3).
  return new OneClickError(
    `1Click ${where}: unexpected response (${truncateUntrusted(why)})`,
    null,
    'BAD_RESPONSE',
  );
}

/** A string, or a number rendered as its decimal string (1Click mixes the two). */
function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function reqStr(o: Json, key: string, where: string): string {
  const v = str(o[key]);
  if (v === undefined) throw badResponse(where, `missing ${key}`);
  return v;
}

/** Copies the optional string fields present on `from`. */
function optional<K extends string>(from: Json, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = str(from[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toTokenInfo(t: Json): TokenInfo {
  const where = '/v0/tokens';
  if (typeof t.decimals !== 'number') throw badResponse(where, 'missing decimals');
  const price = str(t.priceUsd ?? t.price);
  return {
    assetId: reqStr(t, 'assetId', where),
    decimals: t.decimals,
    blockchain: reqStr(t, 'blockchain', where),
    symbol: reqStr(t, 'symbol', where),
    ...(price !== undefined ? { priceUsd: price } : {}),
  };
}

function toQuoteResponse(body: Json): QuoteResponse {
  const where = '/v0/quote';
  const q = asObject(body.quote, where);
  return {
    quote: {
      ...optional(q, ['depositAddress'] as const),
      amountIn: reqStr(q, 'amountIn', where),
      amountInUsd: reqStr(q, 'amountInUsd', where),
      amountOut: reqStr(q, 'amountOut', where),
      amountOutUsd: reqStr(q, 'amountOutUsd', where),
      ...optional(q, ['minAmountIn', 'deadline', 'timeWhenInactive'] as const),
    },
    correlationId: str(body.correlationId) ?? '',
  };
}

function toTxHashes(v: unknown): TxHashRef[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((h): TxHashRef[] => {
    if (typeof h === 'string') return [{ hash: h }];
    if (isObject(h) && typeof h.hash === 'string') {
      return [
        typeof h.explorerUrl === 'string'
          ? { hash: h.hash, explorerUrl: h.explorerUrl }
          : { hash: h.hash },
      ];
    }
    return [];
  });
}

function toStatusResponse(body: Json): StatusResponse {
  const where = '/v0/status';
  const status = body.status;
  if (typeof status !== 'string' || !(ONECLICK_STATUSES as readonly string[]).includes(status)) {
    throw badResponse(where, `unknown status ${String(status)}`);
  }
  const d = isObject(body.swapDetails) ? body.swapDetails : {};
  const swapDetails: SwapDetails = {
    originChainTxHashes: toTxHashes(d.originChainTxHashes),
    destinationChainTxHashes: toTxHashes(d.destinationChainTxHashes),
    ...optional(d, [
      'amountIn',
      'amountOut',
      'depositedAmount',
      'refundedAmount',
      'refundReason',
    ] as const),
  };
  return { status: status as OneClickStatus, swapDetails };
}
