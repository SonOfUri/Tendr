import { usesTidepool } from '../lib/testnet.js';
// A link can pick a different asset, never a different owner or payout address. 1Click credits
// the chosen asset to the same merchant Intents account. Source-chain metadata is for display.
import { SettlementAssetIdSchema, type LinkSettlementOptions } from '@tendr/contracts';
import { tokenInfo, tokenList } from '../checkout/tokens.js';
import { AppError } from '../lib/errors.js';
import type { ScopedDb } from '../db/scoped.js';

export async function settlementAssetData(livemode: boolean, asset: string | null | undefined) {
  if (asset === undefined) return {};
  if (asset === null)
    return {
      settlementAssetId: null,
      settlementAssetSymbol: null,
      settlementAssetChain: null,
    };
  if (!SettlementAssetIdSchema.safeParse(asset).success) {
    throw new AppError('UNSUPPORTED_ASSET', 'Choose a supported fungible settlement token', 400, {
      field: 'settlement_asset',
    });
  }
  // Prefer the mode's catalog; fall back to live 1Click so test-mode links can settle into the
  // same Intents assets the dashboard picker shows (saved addresses / withdrawals already do).
  let token;
  try {
    token = await tokenInfo(livemode, asset);
  } catch (err) {
    if (
      livemode ||
      usesTidepool(livemode) ||
      !(err instanceof AppError) ||
      err.code !== 'UNSUPPORTED_ASSET'
    )
      throw err;
    token = await tokenInfo(true, asset);
  }
  return {
    settlementAssetId: token.assetId,
    settlementAssetSymbol: token.symbol,
    settlementAssetChain: token.blockchain,
  };
}

export async function linkSettlementOptions(ctx: {
  livemode: boolean;
  db: ScopedDb;
}): Promise<LinkSettlementOptions> {
  const [catalog, config] = await Promise.all([
    tokenList(ctx.livemode),
    ctx.db.settlementConfig.findFirst({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  const current = config ? catalog.get(config.destAssetId) : undefined;
  return {
    livemode: ctx.livemode,
    chains: [
      ...new Set(
        [...catalog.values()]
          .map((t) => t.blockchain)
          .filter((chain) => /^[a-z0-9]{1,16}$/.test(chain)),
      ),
    ].sort((a, b) => a.localeCompare(b)),
    tokens: [...catalog.values()]
      .filter((t) => SettlementAssetIdSchema.safeParse(t.assetId).success)
      .map((t) => ({
        asset: t.assetId,
        symbol: t.symbol,
        chain: t.blockchain,
        decimals: t.decimals,
      }))
      .sort(
        (a, b) =>
          a.chain.localeCompare(b.chain) ||
          a.symbol.localeCompare(b.symbol) ||
          a.asset.localeCompare(b.asset),
      ),
    store_default: config
      ? {
          asset: config.destAssetId,
          symbol: current?.symbol ?? null,
          chain: current?.blockchain ?? null,
          payout_mode: config.payoutMode,
        }
      : null,
  };
}
