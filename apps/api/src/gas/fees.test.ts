import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import {
  estimateHookFeeUsd,
  HOOK_GAS_UNITS,
  nativeUnitsForUsd,
  estimateNetworkFeeUsd,
  feeInToken,
  gaslessMethodSupported,
  resetFeeCache,
  setFeeDeps,
  SIMULATED_FEE_USD,
  withFeeMargin,
} from './fees.js';

const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ETH_BASE = 'nep141:base.omft.near';

const TOKENS: TokenInfo[] = [
  { assetId: USDC_BASE, symbol: 'USDC', blockchain: 'base', decimals: 6, priceUsd: '1.00' },
  { assetId: ETH_BASE, symbol: 'ETH', blockchain: 'base', decimals: 18, priceUsd: '2500' },
  {
    assetId: 'nep141:eth.omft.near',
    symbol: 'ETH',
    blockchain: 'eth',
    decimals: 18,
    priceUsd: '2000',
  },
  {
    assetId: 'nep141:sol.omft.near',
    symbol: 'SOL',
    blockchain: 'sol',
    decimals: 9,
    priceUsd: '150',
  },
  { assetId: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24, priceUsd: '3' },
  {
    assetId: 'nep141:tron.omft.near',
    symbol: 'TRX',
    blockchain: 'tron',
    decimals: 6,
    priceUsd: '0.25',
  },
  { assetId: 'nep141:unpriced.near', symbol: 'ODD', blockchain: 'near', decimals: 8 },
  { assetId: 'nep141:zero.near', symbol: 'ZERO', blockchain: 'near', decimals: 8, priceUsd: '0' },
];

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

/** A fetch that answers JSON-RPC / HTTP by method or path, recording every call. */
function rpc(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const key = (body?.method as string | undefined) ?? new URL(url).pathname;
    if (!(key in answers)) return new Response('no', { status: 500 });
    return new Response(JSON.stringify(answers[key]), { status: 200 });
  };
  return { f, calls };
}

const tokens = async () => new Map(TOKENS.map((t) => [t.assetId, t]));

/** Answers RPCs with `f` and prices from TOKENS. */
function useFetch(f: ReturnType<typeof rpc>['f']) {
  setFeeDeps({ fetch: f, tokens });
}

describe('network fees', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetFeeCache();
    setFeeDeps({ tokens });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    setFeeDeps(null);
    resetFeeCache();
    logSpy.mockRestore();
  });

  describe('feeInToken', () => {
    it('$0.08 at $1.00 for USDC (6 dp) with the default 2000 bps margin is 96000', async () => {
      expect(env().GAS_FEE_MARGIN_BPS).toBe(2000);
      expect(await feeInToken(USDC_BASE, '0.08', { livemode: true })).toEqual({
        amount: '96000',
        symbol: 'USDC',
        decimals: 6,
      });
    });

    it('rounds up to the base unit, exactly', async () => {
      // 0.01 × 1.2 / 2500 ETH = 4.8e-6 ETH = 4800000000000 wei exactly; 0.000001 → 4.8e-10 → 480000000.
      expect((await feeInToken(ETH_BASE, '0.01', { livemode: true })).amount).toBe('4800000000000');
      expect((await feeInToken(ETH_BASE, '0.000001', { livemode: true })).amount).toBe('480000000');
      // $0.000001 × 1.2 in USDC = 1.2 base units → 2.
      expect((await feeInToken(USDC_BASE, '0.000001', { livemode: true })).amount).toBe('2');
    });

    it('applies GAS_FEE_MARGIN_BPS', async () => {
      const saved = env().GAS_FEE_MARGIN_BPS;
      env().GAS_FEE_MARGIN_BPS = 0;
      try {
        expect((await feeInToken(USDC_BASE, '0.08', { livemode: true })).amount).toBe('80000');
      } finally {
        env().GAS_FEE_MARGIN_BPS = saved;
      }
    });

    it('an unpriced (or zero-priced) token is FEE_TOKEN_UNPRICED', async () => {
      for (const id of ['nep141:unpriced.near', 'nep141:zero.near']) {
        const err = await feeInToken(id, '0.08', { livemode: true }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('FEE_TOKEN_UNPRICED');
      }
    });

    it('an unknown token is UNSUPPORTED_ASSET', async () => {
      const err = await feeInToken('nep141:nope', '1', { livemode: true }).catch((e) => e);
      expect((err as AppError).code).toBe('UNSUPPORTED_ASSET');
    });
  });

  it('withFeeMargin adds the margin and rounds up to the micro-dollar', () => {
    expect(withFeeMargin('0.08')).toBe('0.096');
    expect(withFeeMargin('0.000001')).toBe('0.000002');
    expect(withFeeMargin('0')).toBe('0');
  });

  it('gaslessMethodSupported follows the chain rules', () => {
    for (const m of ['eip3009', 'permit', 'paymaster', 'forwarder'] as const) {
      expect(gaslessMethodSupported('base', m)).toBe(true);
    }
    expect(gaslessMethodSupported('sol', 'kora')).toBe(true);
    expect(gaslessMethodSupported('near', 'meta_tx')).toBe(true);
    expect(gaslessMethodSupported('tron', 'forwarder')).toBe(true);
    expect(gaslessMethodSupported('tron', 'eip3009')).toBe(false);
    expect(gaslessMethodSupported('base', 'kora')).toBe(false);
    expect(gaslessMethodSupported('btc', 'eip3009')).toBe(false);
    expect(gaslessMethodSupported('near', 'native')).toBe(true);
  });

  describe('test mode', () => {
    it('uses the simulated table and never calls an RPC', async () => {
      const { f, calls } = rpc({});
      setFeeDeps({
        fetch: f,
        tokens: async () => {
          throw new Error('token list must not be read in test mode');
        },
      });
      expect(await estimateNetworkFeeUsd('base', 'eip3009', { livemode: false })).toBe(
        SIMULATED_FEE_USD.base,
      );
      expect(await estimateNetworkFeeUsd('sol', 'kora', { livemode: false })).toBe(
        SIMULATED_FEE_USD.sol,
      );
      expect(await estimateNetworkFeeUsd('btc', 'native', { livemode: false })).toBe('2');
      expect(await estimateHookFeeUsd('base', { livemode: false })).toBe(SIMULATED_FEE_USD.base);
      expect(calls).toEqual([]);
    });
  });

  describe('live mode', () => {
    it('EVM: eth_gasPrice × the method gas units × the native price', async () => {
      // 1 gwei; eip3009 one leg = 90k gas = 9e13 wei = 0.00009 ETH × $2500 = $0.225.
      const { f, calls } = rpc({ eth_gasPrice: { jsonrpc: '2.0', id: 1, result: '0x3b9aca00' } });
      useFetch(f);
      expect(await estimateNetworkFeeUsd('base', 'eip3009', { livemode: true })).toBe('0.225');
      // The fee leg doubles the EIP-3009 legs.
      expect(await estimateNetworkFeeUsd('base', 'eip3009', { livemode: true, feeLeg: true })).toBe(
        '0.45',
      );
      expect(await estimateNetworkFeeUsd('base', 'permit', { livemode: true })).toBe('0.35');
      expect(await estimateNetworkFeeUsd('base', 'paymaster', { livemode: true })).toBe('0.45');
      expect(await estimateNetworkFeeUsd('base', 'native', { livemode: true })).toBe('0.1625');
      expect(
        await estimateNetworkFeeUsd('base', 'native', { livemode: true, nativeAsset: true }),
      ).toBe('0.0525');
      // Cached for 30 s: one RPC call for all of the above.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://mainnet.base.org');
    });

    it('EVM: honours EVM_RPC_URLS', async () => {
      const saved = env().EVM_RPC_URLS;
      env().EVM_RPC_URLS = { base: 'https://base.example/rpc' };
      try {
        const { f, calls } = rpc({ eth_gasPrice: { result: '0x1' } });
        useFetch(f);
        await estimateNetworkFeeUsd('base', 'eip3009', { livemode: true });
        expect(calls[0]!.url).toBe('https://base.example/rpc');
      } finally {
        env().EVM_RPC_URLS = saved;
      }
    });

    it('Solana: base fee per signature + priority fee (+ the deposit account rent for kora)', async () => {
      // 2 signatures × 5000 + median priority 1_000_000 µlamports/CU × 200k CU / 1e6 = 200000
      // + the deposit address's new token account rent 2 039 280 (the paymaster pays it)
      // → 2 249 280 lamports × $150 / 1e9 = $0.337392.
      const { f, calls } = rpc({
        getRecentPrioritizationFees: {
          result: [
            { slot: 1, prioritizationFee: 0 },
            { slot: 2, prioritizationFee: 1_000_000 },
            { slot: 3, prioritizationFee: 5_000_000 },
          ],
        },
      });
      useFetch(f);
      expect(await estimateNetworkFeeUsd('sol', 'kora', { livemode: true })).toBe('0.337392');
      // A normal send: one signature, no rent counted.
      expect(await estimateNetworkFeeUsd('sol', 'native', { livemode: true })).toBe('0.03075');
      expect(calls[0]!.url).toBe(env().SOLANA_RPC_URL);
    });

    it('NEAR: gas price × units, plus the deposit address registration for meta_tx', async () => {
      // 100_000_000 yocto/gas × (50 Tgas + 10 Tgas storage_deposit) = 6e21 yocto, + 1.25e21
      // storage deposit = 0.00725 NEAR × $3 = $0.02175.
      const { f } = rpc({ gas_price: { result: { gas_price: '100000000' } } });
      useFetch(f);
      expect(await estimateNetworkFeeUsd('near', 'meta_tx', { livemode: true })).toBe('0.02175');
      // A normal send: 15 Tgas = 1.5e21 yocto × $3 = $0.0045.
      expect(await estimateNetworkFeeUsd('near', 'native', { livemode: true })).toBe('0.0045');
    });

    it('Tron: energy price × energy units + bandwidth', async () => {
      // Approve + payWithApproval into a fresh deposit address: 210 sun/energy × 235k = 49.35 TRX
      // + 0.35 TRX bandwidth = 49.7 TRX × $0.25 = $12.425; the shopper's fee leg adds a second
      // transferFrom (65k): 300k → 63.35 TRX → $15.8375.
      const { f } = rpc({
        '/wallet/getchainparameters': {
          chainParameter: [
            { key: 'getEnergyFee', value: 210 },
            { key: 'other', value: 1 },
          ],
        },
      });
      useFetch(f);
      expect(await estimateNetworkFeeUsd('tron', 'forwarder', { livemode: true })).toBe('12.425');
      expect(
        await estimateNetworkFeeUsd('tron', 'forwarder', { livemode: true, feeLeg: true }),
      ).toBe('15.8375');
    });

    it('an RPC failure is NETWORK_FEE_UNAVAILABLE and is not cached', async () => {
      useFetch(rpc({}).f);
      const err = await estimateNetworkFeeUsd('base', 'eip3009', { livemode: true }).catch(
        (e: unknown) => e,
      );
      expect((err as AppError).code).toBe('NETWORK_FEE_UNAVAILABLE');
      useFetch(rpc({ eth_gasPrice: { result: '0x3b9aca00' } }).f);
      expect(await estimateNetworkFeeUsd('base', 'eip3009', { livemode: true })).toBe('0.225');
    });

    it('an unpriced native coin is NETWORK_FEE_UNAVAILABLE', async () => {
      setFeeDeps({
        fetch: rpc({ eth_gasPrice: { result: '0x1' } }).f,
        tokens: async () => new Map(),
      });
      const err = await estimateNetworkFeeUsd('base', 'eip3009', { livemode: true }).catch(
        (e: unknown) => e,
      );
      expect((err as AppError).code).toBe('NETWORK_FEE_UNAVAILABLE');
    });

    it('a method the chain does not support is refused', async () => {
      await expect(
        estimateNetworkFeeUsd('base', 'kora', { livemode: true }),
      ).rejects.toBeInstanceOf(AppError);
    });

    it('a chain gasless payments do not cover falls back to the static estimate for native sends', async () => {
      const { f, calls } = rpc({});
      useFetch(f);
      expect(await estimateNetworkFeeUsd('btc', 'native', { livemode: true })).toBe('2');
      expect(calls).toEqual([]);
    });

    it('the hook estimate prices the chain own HOOK_GAS_UNITS', async () => {
      // 1 gwei × 90k gas (onTendrDeposit on the reference receiver) = 0.00009 ETH × $2500 = $0.225.
      useFetch(rpc({ eth_gasPrice: { result: '0x3b9aca00' } }).f);
      expect(HOOK_GAS_UNITS.base).toBe(90_000n);
      expect(await estimateHookFeeUsd('base', { livemode: true })).toBe('0.225');
    });

    it('nativeUnitsForUsd inverts nativeUsd, rounding down', async () => {
      // $0.225 at $2500 per ETH = 0.00009 ETH = 9e13 wei; $1 at $3 per NEAR = 0.333… NEAR.
      expect(await nativeUnitsForUsd('base', '0.225', true)).toBe(90_000_000_000_000n);
      expect(await nativeUnitsForUsd('near', '1', true)).toBe(333_333_333_333_333_333_333_333n);
      await expect(nativeUnitsForUsd('base', 'x', true)).rejects.toBeInstanceOf(AppError);
    });

    it('the NEAR hook estimate prices its gas (call + ft_balance_of + callback)', async () => {
      // 100_000_000 yocto/gas × 30 Tgas = 3e21 yocto = 0.003 NEAR × $3 = $0.009.
      useFetch(rpc({ gas_price: { result: { gas_price: '100000000' } } }).f);
      expect(HOOK_GAS_UNITS.near).toBe(30_000_000_000_000n);
      expect(await estimateHookFeeUsd('near', { livemode: true })).toBe('0.009');
    });

    it('every gas chain with hooks has its own units; others have no hook', async () => {
      for (const chain of ['eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera']) {
        expect(HOOK_GAS_UNITS[chain]).toBe(90_000n);
      }
      expect(HOOK_GAS_UNITS.sol).toBeUndefined();
      expect(HOOK_GAS_UNITS.tron).toBeUndefined();
      const err = await estimateHookFeeUsd('sol', { livemode: true }).catch((e: unknown) => e);
      expect((err as AppError).code).toBe('NETWORK_FEE_UNAVAILABLE');
    });
  });
});
