// The 1Click token list per mode, cached in-process for TOKEN_CACHE_TTL_MS. Session creation reads
// settlement-asset decimals from it; quotes can reuse `tokenInfo` / `tokenList`.
// A provider failure is 503 PROVIDER_UNAVAILABLE (never cached); an asset missing from the list is
// 400 UNSUPPORTED_ASSET.
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { providerFor, type TokenInfo } from './oneclick/index.js';

export const TOKEN_CACHE_TTL_MS = 5 * 60_000;

type Entry = { at: number; tokens: Map<string, TokenInfo> };
const cache = new Map<boolean, Entry>();
/** One in-flight fetch per mode, so a burst of requests calls 1Click once. */
const inflight = new Map<boolean, Promise<Map<string, TokenInfo>>>();

/** The mode's token list by asset id. Throws PROVIDER_UNAVAILABLE (503) when 1Click fails. */
export async function tokenList(livemode: boolean): Promise<Map<string, TokenInfo>> {
  const hit = cache.get(livemode);
  if (hit && Date.now() - hit.at < TOKEN_CACHE_TTL_MS) return hit.tokens;
  let p = inflight.get(livemode);
  if (!p) {
    p = providerFor(livemode)
      .tokens()
      .then(
        (list) => {
          const tokens = new Map(list.map((t) => [t.assetId, t]));
          cache.set(livemode, { at: Date.now(), tokens });
          return tokens;
        },
        (err: unknown) => {
          log('error', '1Click token list unavailable', { livemode, err: String(err) });
          throw new AppError(
            'PROVIDER_UNAVAILABLE',
            'The swap provider is unavailable; try again shortly',
            503,
          );
        },
      )
      .finally(() => inflight.delete(livemode));
    inflight.set(livemode, p);
  }
  return p;
}

/** One asset's info. Throws UNSUPPORTED_ASSET (400) when the provider does not list it. */
export async function tokenInfo(livemode: boolean, assetId: string): Promise<TokenInfo> {
  const token = (await tokenList(livemode)).get(assetId);
  if (!token) {
    throw new AppError(
      'UNSUPPORTED_ASSET',
      `Asset ${assetId} is not supported by the swap provider`,
      400,
      { asset: assetId },
    );
  }
  return token;
}

/** Drops the cache (tests). */
export function resetTokenCache(): void {
  cache.clear();
  inflight.clear();
}
