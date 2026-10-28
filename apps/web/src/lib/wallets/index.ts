// Paying the locked quote from the shopper's own wallet. Tendr never signs for the shopper.
//
// - `payTargetFor(assetId)` reads a 1Click asset id: which wallet family pays it, on which chain,
//   and whether it is the chain's native coin or a token (and the token's contract or mint).
//   Anything we cannot read with certainty returns null: that token is paid by manual send only.
// - `adapterFor(assetId)` returns the family and a `load()` that imports the family's module (and
//   through it the wallet SDKs) on demand (./load.ts): no wallet SDK is in the page's first load.
// - Every adapter checks each request against the quote it was made for (`assertDepositMatches`
//   in ./match.ts): the same asset, the exact base-unit amount (BigInt), a well-formed address.

import type { GaslessSigner } from './gasless/index';

export type ChainFamily = 'evm' | 'solana' | 'bitcoin' | 'tron' | 'near';

/** What to send: the locked quote's deposit address, asset and base-unit amount. */
export interface DepositRequest {
  depositAddress: string;
  assetId: string;
  /** Base units, decimal string (the quote's `amount_in`). */
  amount: string;
  decimals: number;
}

export interface SendHooks {
  onSigned?: (txId: string) => void;
}

export interface WalletAdapter {
  chainFamily: ChainFamily;
  /** Gasless signing (project 5a) when this family supports it; see ./gasless/index.ts. */
  gasless?: GaslessSigner;
  connect(): Promise<{ address: string; chainId?: string }>;
  /**
   * Sends exactly `q`. `hooks.onSigned` is called with the tx id when the adapter learns it
   * before broadcasting (Tron), so the payment can be recorded before it may go out.
   */
  sendDeposit(q: DepositRequest, hooks?: SendHooks): Promise<{ txHash: string }>;
  disconnect(): Promise<void>;
}

export interface PayTarget {
  assetId: string;
  family: ChainFamily;
  /** The 1Click `blockchain` id ("eth", "sol", "near"…). */
  blockchain: string;
  kind: 'native' | 'token';
  /** Token contract (EVM 0x…, Tron base58, NEAR account) or SPL mint. */
  contract?: string;
  /** EVM chain id. */
  chainId?: number;
  /** Decimals when the token is from the verified table (checked against the quote). */
  decimals?: number;
}

/** 1Click EVM `blockchain` ids → chain ids. */
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

// Solana and Tron token ids carry a hash, not the mint or contract, so only these are paid by
// wallet. Verified against the bridge's `supported_tokens` (bridge.chaindefuser.com, 2026-10-26).
const KNOWN_TOKENS: Readonly<
  Record<
    string,
    { family: 'solana' | 'tron'; blockchain: string; contract: string; decimals: number }
  >
> = {
  'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near': {
    family: 'solana',
    blockchain: 'sol',
    contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    decimals: 6,
  },
  'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near': {
    family: 'solana',
    blockchain: 'sol',
    contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    decimals: 6,
  },
  'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near': {
    family: 'tron',
    blockchain: 'tron',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT
    decimals: 6,
  },
};

const OMFT_NATIVE = /^nep141:([a-z]+)\.omft\.near$/;
const OMFT_EVM_TOKEN = /^nep141:([a-z]+)-(0x[0-9a-f]{40})\.omft\.near$/;
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** Bridged representations of other chains' assets: never paid as NEAR tokens. */
const BRIDGED = /\.(omft|omdep)\.near$/;

export function payTargetFor(assetId: string): PayTarget | null {
  if (typeof assetId !== 'string') return null;
  const known = KNOWN_TOKENS[assetId];
  if (known) return { assetId, kind: 'token', ...known };

  const native = OMFT_NATIVE.exec(assetId);
  if (native) {
    const chain = native[1]!;
    const chainId = EVM_CHAIN_IDS[chain];
    if (chainId !== undefined)
      return { assetId, family: 'evm', blockchain: chain, kind: 'native', chainId };
    if (chain === 'sol') return { assetId, family: 'solana', blockchain: 'sol', kind: 'native' };
    if (chain === 'btc') return { assetId, family: 'bitcoin', blockchain: 'btc', kind: 'native' };
    if (chain === 'tron') return { assetId, family: 'tron', blockchain: 'tron', kind: 'native' };
    return null;
  }

  const evmToken = OMFT_EVM_TOKEN.exec(assetId);
  if (evmToken) {
    const chainId = EVM_CHAIN_IDS[evmToken[1]!];
    if (chainId === undefined) return null;
    return {
      assetId,
      family: 'evm',
      blockchain: evmToken[1]!,
      kind: 'token',
      contract: evmToken[2]!,
      chainId,
    };
  }

  if (assetId.startsWith('nep141:')) {
    const contract = assetId.slice('nep141:'.length);
    if (
      contract.length < 2 ||
      contract.length > 64 ||
      BRIDGED.test(contract) ||
      !NEAR_ACCOUNT.test(contract)
    ) {
      return null;
    }
    return { assetId, family: 'near', blockchain: 'near', kind: 'token', contract };
  }
  return null;
}

/** Normalises 1Click's chain naming ("solana" → "sol"). */
function sameBlockchain(a: string, b: string): boolean {
  const n = (x: string) => {
    const l = x.toLowerCase();
    if (l === 'solana') return 'sol';
    if (l === 'bitcoin') return 'btc';
    return l;
  };
  return n(a) === n(b);
}

/** What the page passes to the wallet modules when it loads them. */
export interface WalletEnv {
  /** Reown (WalletConnect) project id; null hides EVM, Solana and Bitcoin wallets. */
  reownProjectId: string | null;
  /** NEAR: asks the shopper which wallet to use; null means they closed the list. */
  pickNearWallet: (wallets: { id: string; name: string }[]) => Promise<string | null>;
}

export interface WalletRoute {
  chainFamily: ChainFamily;
  target: PayTarget;
  /** Imports the family's module (and its SDK) and makes the adapter. */
  load(env: WalletEnv): Promise<WalletAdapter>;
}

/** Whether the family needs the Reown project id. */
export const needsReown = (family: ChainFamily) =>
  family === 'evm' || family === 'solana' || family === 'bitcoin';

/**
 * The wallet route for a 1Click asset, or null when it is paid by manual send only. When
 * `blockchain` (the token list's network) is given it must agree with the asset id.
 */
export function adapterFor(assetId: string, blockchain?: string): WalletRoute | null {
  const target = payTargetFor(assetId);
  if (!target) return null;
  if (blockchain !== undefined && !sameBlockchain(blockchain, target.blockchain)) return null;
  return {
    chainFamily: target.family,
    target,
    // One small import here; ./load imports the family's module and SDK in turn.
    load: (env) => import('./load').then((m) => m.loadAdapter(target, env)),
  };
}
