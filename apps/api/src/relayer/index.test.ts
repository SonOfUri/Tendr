import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopperCtx } from '../checkout/quotes.js';
import { setGaslessLive } from '../test/helpers.js';
import { assertGaslessAvailable } from '../checkout/quotes.js';
import { handlePaymasterUrl } from './evm/pimlico.js';
import { getRedis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
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

describe('live gasless is refused at quote time and on the paymaster URL', () => {
  afterEach(() => {
    setGaslessLive(undefined);
    resetRelayers();
    vi.restoreAllMocks();
  });

  it('a live quote with a gasless method is GASLESS_NOT_AVAILABLE for every family', () => {
    setGaslessLive(false);
    for (const [chain, m] of [
      ['base', 'paymaster'],
      ['sol', 'kora'],
      ['near', 'meta_tx'],
      ['tron', 'forwarder'],
    ] as const) {
      expect(() => assertGaslessAvailable(true, chain, m)).toThrow(
        expect.objectContaining({ code: 'GASLESS_NOT_AVAILABLE' }),
      );
    }
  });

  it('allows a live quote without a method, test mode, and live with the switch on', () => {
    setGaslessLive(false);
    expect(() => assertGaslessAvailable(true, 'base', undefined)).not.toThrow();
    expect(() => assertGaslessAvailable(false, 'base', 'paymaster')).not.toThrow();
    setGaslessLive(true);
    expect(() => assertGaslessAvailable(true, 'base', 'paymaster')).not.toThrow();
  });

  it('the paymaster URL of a live quote answers not-available and never reaches Pimlico', async () => {
    setGaslessLive(false);
    // The shared Redis client connects lazily; wait until it answers.
    for (let i = 0; i < 50; i++) {
      if (
        await getRedis()
          .ping()
          .then(
            () => true,
            () => false,
          )
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(prisma.quote, 'findUnique').mockResolvedValue({
      id: 'quo_x',
      merchantId: 'mer_x',
      livemode: true,
      sessionId: 'cs_x',
    } as never);
    const res = await handlePaymasterUrl(
      'a'.repeat(43),
      { jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterData', params: [] },
      `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    );
    expect((res as { error?: unknown }).error).toBeDefined();
    expect(JSON.stringify((res as { error?: unknown }).error)).toMatch(/not available/i);
    expect(fetchSpy.mock.calls).toEqual([]);
  });
});
