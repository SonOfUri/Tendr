// The NEP-141 tokens gasless NEAR payments accept (project 5a, ruling T8-d). Kept under near/ so
// the `relayer-near` signing guard (near/tx.ts) can restrict registrations to these contracts.

/**
 * The NEP-141 tokens gasless NEAR payments accept (ruling T8-d): Circle's native USDC and Tether's
 * USDT on NEAR mainnet, as the 1Click token list names them. Both are plain NEP-141 contracts (no
 * fee-on-transfer, no rebasing) that need a `storage_deposit` registration per receiver.
 */
export const NEAR_GASLESS_TOKENS = [
  {
    assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    contract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    symbol: 'USDC',
    decimals: 6,
  },
  {
    assetId: 'nep141:usdt.tether-token.near',
    contract: 'usdt.tether-token.near',
    symbol: 'USDT',
    decimals: 6,
  },
] as const;

export type NearGaslessToken = (typeof NEAR_GASLESS_TOKENS)[number];

/** The allow-listed token for a 1Click asset id, or null. */
export function nearGaslessToken(assetId: string): NearGaslessToken | null {
  return NEAR_GASLESS_TOKENS.find((t) => t.assetId === assetId) ?? null;
}
