// The EVM gasless allow-list (project 5a, spec §2.3): the only tokens the relayer will move, per
// chain, with the methods each supports and the EIP-712 domain its own signatures use.
//
// A token is listed only when it is known to implement the method exactly as the forwarder expects
// (EIP-3009 `transferWithAuthorization` / EIP-2612 `permit`) and moves exactly the signed amount:
// fee-on-transfer and rebasing tokens are never listed (the forwarder and the 1Click deposit both
// assume amount in = amount signed). Anything not listed gets no gasless option: the shopper's
// wallet pays gas itself ("You'll need {coin} for the network fee").
//
// Seeded with Circle's native USDC (FiatTokenV2_2: EIP-3009 and EIP-2612, domain "USD Coin" / "2")
// on Ethereum, Base, Arbitrum, Optimism, Polygon and Avalanche, also for smart-wallet `paymaster`
// payments. The codebase's token tables name no
// other permit token on these chains. Before go-live, read `name()` / `version()` (or
// `eip712Domain()`) of each listed contract on chain (README live checklist).
import type { GaslessMethod } from '@tendr/contracts';

/** The gasless methods the EVM relayer submits itself (through the TendrForwarder). */
export type EvmRelayMethod = Extract<GaslessMethod, 'eip3009' | 'permit'>;
/** Every EVM gasless method: the relayer's own, and Pimlico-sponsored smart-wallet calls. */
export type EvmGaslessMethod = EvmRelayMethod | Extract<GaslessMethod, 'paymaster'>;
export const EVM_RELAY_METHODS: readonly EvmGaslessMethod[] = ['eip3009', 'permit'];

export interface GaslessToken {
  /** 1Click blockchain id. */
  chain: string;
  /** Token contract, lower-case 0x hex. */
  address: string;
  symbol: string;
  decimals: number;
  /**
   * Best first. `paymaster`: a plain `transfer` batched by a smart wallet whose user operation
   * Pimlico sponsors (any listed token qualifies: it moves exactly the amount transferred).
   */
  methods: readonly EvmGaslessMethod[];
  /** The token's own EIP-712 domain (its EIP-3009 and permit signatures). */
  domain: { name: string; version: string };
}

const usdc = (chain: string, address: string): GaslessToken => ({
  chain,
  address,
  symbol: 'USDC',
  decimals: 6,
  methods: ['eip3009', 'permit', 'paymaster'],
  domain: { name: 'USD Coin', version: '2' },
});

export const EVM_GASLESS_TOKENS: readonly GaslessToken[] = [
  usdc('eth', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
  usdc('base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  usdc('arb', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
  usdc('op', '0x0b2c639c533813f4aa9d7837caf62653d097ff85'),
  usdc('pol', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'),
  usdc('avax', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'),
];

/** EIP-155 chain ids of the EVM chains gasless payments cover (1Click blockchain ids). */
export const EVM_CHAIN_IDS: Readonly<Record<string, number>> = {
  eth: 1,
  base: 8453,
  arb: 42161,
  op: 10,
  pol: 137,
  bsc: 56,
  avax: 43114,
  gnosis: 100,
  bera: 80094,
};

/** `nep141:<chain>-0x<address>.omft.near` → the token contract (lower-case), else null. */
export function evmTokenAddress(assetId: string): string | null {
  const m = /^nep141:[a-z0-9]+-(0x[0-9a-fA-F]{40})\.omft\.near$/.exec(assetId);
  return m ? m[1]!.toLowerCase() : null;
}

/** The allow-listed token behind a 1Click asset on `chain`, or null (no gasless option). */
export function gaslessToken(chain: string, assetId: string): GaslessToken | null {
  const address = evmTokenAddress(assetId);
  if (!address) return null;
  return EVM_GASLESS_TOKENS.find((t) => t.chain === chain && t.address === address) ?? null;
}
