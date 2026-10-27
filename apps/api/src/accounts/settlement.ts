// Where a store's payments settle (WooCommerce plugin spec §2 "choose payout", user decision
// "Settlement: USDC by default"): the mode's mirrored `settlement_configs` row, an open
// `set_settlement` proposal, and the tokens the dashboard and the Connect popup offer. Read only:
// changing it is always a `set_settlement` proposal that the store's signers approve.
import { prisma } from '../lib/prisma.js';

export interface SettlementChoice {
  asset: string;
  symbol: string;
  chain: 'near';
  /** USDC: preselected. */
  default: boolean;
}

const choice = (asset: string, symbol: string, isDefault = false): SettlementChoice => ({
  asset,
  symbol,
  chain: 'near',
  default: isDefault,
});

/**
 * The settlement tokens offered per mode, USDC first. Intents settlement into the store's own
 * account (`payout_mode: intents`, chain `near`); each is a 1Click destination in its mode
 * (test: the simulated provider's table; live: 1Click mainnet ids).
 */
export const SETTLEMENT_CHOICES: Readonly<Record<'test' | 'live', readonly SettlementChoice[]>> = {
  test: [choice('nep141:usdc.fakes.testnet', 'USDC', true), choice('nep141:wrap.testnet', 'wNEAR')],
  live: [
    // Native USDC on NEAR (Circle).
    choice('nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'USDC', true),
    choice('nep141:usdt.tether-token.near', 'USDT'),
    choice('nep141:wrap.near', 'wNEAR'),
  ],
};

const OPEN_STATUSES = ['draft', 'pending', 'timelocked', 'executing'] as const;

/** The store's payout in one mode, for the dashboard and the Connect popup. */
export async function settlementView(ctx: { merchantId: string; livemode: boolean }) {
  const choices = SETTLEMENT_CHOICES[ctx.livemode ? 'live' : 'test'];
  const where = { merchantId: ctx.merchantId, livemode: ctx.livemode };
  const [account, config, open] = await Promise.all([
    prisma.merchantAccount.findFirst({ where, orderBy: { createdAt: 'desc' } }),
    prisma.settlementConfig.findFirst({
      where,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.accountProposal.findFirst({
      where: { ...where, kind: 'set_settlement', status: { in: [...OPEN_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return {
    livemode: ctx.livemode,
    account_status: account?.status ?? null,
    settlement: config
      ? {
          asset: config.destAssetId,
          symbol: choices.find((c) => c.asset === config.destAssetId)?.symbol ?? null,
          chain: config.destChain,
          payout_mode: config.payoutMode,
        }
      : null,
    pending: open ? { id: open.id, status: open.status } : null,
    choices,
  };
}
