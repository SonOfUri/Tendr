import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopperCtx } from '../checkout/quotes.js';
import { setGaslessLive } from '../test/helpers.js';
import { gaslessOptions, gaslessQuote, relayerFor, resetRelayers } from './index.js';
import type { ChainFamily } from './types.js';

vi.mock('../checkout/tokens.js', () => ({
  tokenInfo: async () => ({ blockchain: 'eth', symbol: 'USDC', assetId: 'x', decimals: 6 }),
  tokenList: async () => new Map(),
}));

const FAMILIES: ChainFamily[] = ['evm', 'solana', 'near', 'tron'];

describe('relayerFor and GASLESS_LIVE_ENABLED', () => {
  beforeEach(() => resetRelayers());
  afterEach(() => {
    setGaslessLive(undefined);
    resetRelayers();
  });

  for (const f of FAMILIES) {
    it(`${f}: live is null while the switch is unset`, () => {
      setGaslessLive(undefined);
      expect(relayerFor(f, true)).toBeNull();
    });

    it(`${f}: live is a relayer with the switch on`, () => {
      setGaslessLive(true);
      expect(relayerFor(f, true)).not.toBeNull();
    });

    it(`${f}: test mode is unchanged either way`, () => {
      setGaslessLive(undefined);
      expect(relayerFor(f, false)).not.toBeNull();
      setGaslessLive(true);
      expect(relayerFor(f, false)).not.toBeNull();
    });

    it(`${f}: a cached live relayer is not returned once the switch is off`, () => {
      setGaslessLive(true);
      expect(relayerFor(f, true)).not.toBeNull();
      setGaslessLive(false);
      expect(relayerFor(f, true)).toBeNull();
    });
  }
});

describe('live checkout gasless routes while GASLESS_LIVE_ENABLED is off', () => {
  afterEach(() => {
    setGaslessLive(undefined);
    resetRelayers();
    vi.restoreAllMocks();
  });

  const shopper = {
    livemode: true,
    sessionId: 'cs_x',
    db: {
      session: {
        findFirst: async () => ({
          id: 'cs_x',
          status: 'PENDING_DEPOSIT',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      quote: {
        findFirst: async () => ({
          id: 'quo_x',
          originAssetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
          walletAddress: '0x1111111111111111111111111111111111111111',
        }),
      },
    },
  } as unknown as ShopperCtx;

  it('options are empty and nothing is fetched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await gaslessOptions(shopper, {
      origin_asset: 'x',
      wallet_address: '0x1111111111111111111111111111111111111111',
    });
    expect(res.options).toEqual([]);
    expect(res.fee_recipient).toBeNull();
    expect(fetchSpy.mock.calls).toEqual([]);
  });

  it('prepare/submit on a live quote is GASLESS_NOT_AVAILABLE', async () => {
    await expect(gaslessQuote(shopper, 'quo_x')).rejects.toMatchObject({
      code: 'GASLESS_NOT_AVAILABLE',
    });
  });
});
