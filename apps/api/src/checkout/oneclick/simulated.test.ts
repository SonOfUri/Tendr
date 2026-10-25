import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../env.js';
import { closeRedis, getRedis, whenReady } from '../../lib/redis.js';
import { fakeNearClient, resetNearClients } from '../../near/client.js';
import type { FakeNearClient } from '../../near/fake.js';
import { MemorySimStore, SIM_KEY_PREFIX, SIM_TTL_MS } from './sim-store.js';
import { SimulatedOneClick, simulatedDestinationTxHash } from './simulated.js';
import { OneClickError, type QuoteRequest } from './types.js';

const USDC = 'nep141:usdc.test';
const ETH = 'nep141:eth.test';
const T0 = new Date('2026-10-25T12:00:00.000Z');
const DEADLINE = new Date(T0.getTime() + 12 * 60_000);

function request(over: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    dry: false,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: 100,
    originAsset: ETH,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDC,
    amount: '25000000', // 25 USDC
    refundTo: '0x1111111111111111111111111111111111111111',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'shop.tendr.testnet',
    recipientType: 'INTENTS',
    deadline: DEADLINE.toISOString(),
    appFees: [{ recipient: 'fees.tendr.testnet', fee: 50 }],
    ...over,
  };
}

let clock: Date;
let fake: FakeNearClient;
let sim: SimulatedOneClick;

function depositsTo(accountId: string) {
  return fake
    .callsTo('deposit')
    .filter(
      (c) => c.kind === 'call' && (c.args as { account_id: string }).account_id === accountId,
    );
}

/** Deletes every simulated deposit (deposit addresses are deterministic across tests). */
async function clearSimKeys(): Promise<void> {
  const redis = getRedis();
  await whenReady(redis);
  const keys = await redis.keys(`${SIM_KEY_PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await clearSimKeys();
  resetNearClients();
  fake = fakeNearClient(false);
  clock = T0;
  // Default store: Redis, as in the API and the worker.
  sim = new SimulatedOneClick({ now: () => clock });
});

afterAll(async () => {
  await clearSimKeys();
  await closeRedis();
});

describe('SimulatedOneClick quotes', () => {
  it('is deterministic for the same request', async () => {
    const a = await sim.quote(request());
    const b = await new SimulatedOneClick({ now: () => clock }).quote(request());
    expect(a).toEqual(b);
    expect(a.quote.amountOut).toBe('25000000');
    expect(a.quote.amountOutUsd).toBe('25');
    // 25 USD + 10 bps simulated 1Click fee + 50 bps app fee = 25.15 USD of ETH at 2500 USD.
    expect(a.quote.amountInUsd).toBe('25.15');
    expect(a.quote.amountIn).toBe('10060000000000000');
    expect(a.quote.minAmountIn).toBe(a.quote.amountIn);
    expect(a.quote.deadline).toBe(DEADLINE.toISOString());
    expect(a.quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(a.correlationId).toBeTruthy();
  });

  it('gives a different deposit address to a different request', async () => {
    const a = await sim.quote(request());
    const b = await sim.quote(request({ recipient: 'other.tendr.testnet' }));
    expect(a.quote.depositAddress).not.toBe(b.quote.depositAddress);
  });

  it('allocates no deposit address on a dry quote', async () => {
    const q = await sim.quote(request({ dry: true }));
    expect(q.quote.depositAddress).toBeUndefined();
    expect(q.quote.amountIn).toBe('10060000000000000');
  });

  it('prices EXACT_INPUT with fees taken from the output', async () => {
    const q = await sim.quote(
      request({ swapType: 'EXACT_INPUT', amount: '10000000000000000', appFees: [] }),
    );
    // 0.01 ETH = 25 USD, less 10 bps.
    expect(q.quote.amountInUsd).toBe('25');
    expect(q.quote.amountOut).toBe('24975024');
  });

  it('refuses an unknown asset with a 400', async () => {
    const err = await sim.quote(request({ originAsset: 'nep141:nope' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ status: 400, code: 'UNSUPPORTED_ASSET' });
  });

  it('lists the fixture tokens with prices', async () => {
    const tokens = await sim.tokens();
    expect(tokens).toContainEqual({
      assetId: USDC,
      decimals: 6,
      blockchain: 'near',
      symbol: 'USDC',
      priceUsd: '1',
    });
  });
});

describe('SimulatedOneClick status and scenarios', () => {
  it('reports PENDING_DEPOSIT for a fresh quote and 404 for an unknown address', async () => {
    const { quote } = await sim.quote(request());
    expect((await sim.status(quote.depositAddress!)).status).toBe('PENDING_DEPOSIT');
    await expect(sim.status('0xnope')).rejects.toMatchObject({ status: 404 });
  });

  it('exact: SUCCESS, credits the merchant and the fee account through the mock verifier', async () => {
    const { quote } = await sim.quote(request());
    const res = await sim.simulate(quote.depositAddress!, 'exact');
    expect(res.status).toBe('SUCCESS');
    expect(res.swapDetails).toMatchObject({
      amountIn: quote.amountIn,
      amountOut: '25000000',
      depositedAmount: quote.amountIn,
      refundedAmount: '0',
    });
    expect(res.swapDetails.originChainTxHashes).toHaveLength(1);
    expect(res.swapDetails.destinationChainTxHashes).toEqual([
      { hash: simulatedDestinationTxHash(quote.depositAddress!) },
    ]);
    expect(res.swapDetails.senderAddress).toMatch(/^0x[0-9a-f]{40}$/);

    const intents = env().INTENTS_CONTRACT_TEST;
    expect(depositsTo('shop.tendr.testnet')).toEqual([
      expect.objectContaining({
        signer: 'relayer-accounts',
        contractId: intents,
        method: 'deposit',
        args: { account_id: 'shop.tendr.testnet', token_id: USDC, amount: '25000000' },
      }),
    ]);
    expect(depositsTo('fees.tendr.testnet')).toEqual([
      expect.objectContaining({
        contractId: intents,
        args: { account_id: 'fees.tendr.testnet', token_id: USDC, amount: '125000' },
      }),
    ]);
    // Status reads stay SUCCESS and credit nothing more.
    expect(await sim.status(quote.depositAddress!)).toEqual(res);
    expect(fake.callsTo('deposit')).toHaveLength(2);
  });

  it('overpay: SUCCESS with the excess refunded', async () => {
    const { quote } = await sim.quote(request());
    const res = await sim.simulate(quote.depositAddress!, 'overpay');
    expect(res.status).toBe('SUCCESS');
    const deposited = BigInt(res.swapDetails.depositedAmount!);
    const refunded = BigInt(res.swapDetails.refundedAmount!);
    expect(refunded).toBeGreaterThan(0n);
    expect(deposited - refunded).toBe(BigInt(quote.amountIn));
    expect(depositsTo('shop.tendr.testnet')).toHaveLength(1);
  });

  it('underpay before the deadline: INCOMPLETE_DEPOSIT, nothing credited; top-up settles', async () => {
    const { quote } = await sim.quote(request());
    const addr = quote.depositAddress!;
    const under = await sim.simulate(addr, 'underpay');
    expect(under.status).toBe('INCOMPLETE_DEPOSIT');
    expect(BigInt(under.swapDetails.depositedAmount!)).toBeLessThan(BigInt(quote.amountIn));
    expect(fake.callsTo('deposit')).toHaveLength(0);

    const topped = await sim.simulate(addr, 'topup');
    expect(topped.status).toBe('SUCCESS');
    expect(topped.swapDetails.depositedAmount).toBe(quote.amountIn);
    expect(topped.swapDetails.originChainTxHashes).toHaveLength(2);
    expect(depositsTo('shop.tendr.testnet')).toHaveLength(1);
  });

  it('underpay left past the deadline becomes REFUNDED', async () => {
    const { quote } = await sim.quote(request());
    const addr = quote.depositAddress!;
    const under = await sim.simulate(addr, 'underpay');
    clock = new Date(DEADLINE.getTime() + 1000);
    const res = await sim.status(addr);
    expect(res.status).toBe('REFUNDED');
    expect(res.swapDetails.refundedAmount).toBe(under.swapDetails.depositedAmount);
    expect(res.swapDetails.refundReason).toBeTruthy();
    // A top-up after the deadline is refused.
    await expect(sim.simulate(addr, 'topup')).rejects.toMatchObject({ status: 409 });
    expect(fake.callsTo('deposit')).toHaveLength(0);
  });

  it('topup without an incomplete deposit is refused', async () => {
    const { quote } = await sim.quote(request());
    await expect(sim.simulate(quote.depositAddress!, 'topup')).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_STATE',
    });
  });

  it('late: after the deadline the deposit is REFUNDED and never credited', async () => {
    const { quote } = await sim.quote(request());
    clock = new Date(DEADLINE.getTime() + 60_000);
    const res = await sim.simulate(quote.depositAddress!, 'late');
    expect(res.status).toBe('REFUNDED');
    expect(res.swapDetails.refundedAmount).toBe(quote.amountIn);
    expect(res.swapDetails.destinationChainTxHashes).toEqual([]);
    expect(fake.callsTo('deposit')).toHaveLength(0);
  });

  it('an exact deposit after the deadline is treated as late', async () => {
    const { quote } = await sim.quote(request());
    clock = new Date(DEADLINE.getTime() + 1);
    expect((await sim.simulate(quote.depositAddress!, 'exact')).status).toBe('REFUNDED');
    expect(fake.callsTo('deposit')).toHaveLength(0);
  });

  it('failed: FAILED and nothing credited', async () => {
    const { quote } = await sim.quote(request());
    const res = await sim.simulate(quote.depositAddress!, 'failed');
    expect(res.status).toBe('FAILED');
    expect(fake.callsTo('deposit')).toHaveLength(0);
  });

  it('a terminal deposit address cannot be simulated again', async () => {
    const { quote } = await sim.quote(request());
    await sim.simulate(quote.depositAddress!, 'exact');
    await expect(sim.simulate(quote.depositAddress!, 'exact')).rejects.toMatchObject({
      status: 409,
    });
    expect(depositsTo('shop.tendr.testnet')).toHaveLength(1);
  });

  it('uses a provided sender address', async () => {
    const { quote } = await sim.quote(request());
    const res = await sim.simulate(quote.depositAddress!, 'exact', {
      senderAddress: '0x2222222222222222222222222222222222222222',
    });
    expect(res.swapDetails.senderAddress).toBe('0x2222222222222222222222222222222222222222');
  });

  it('a failed mock-verifier credit leaves the deposit unsettled', async () => {
    const { quote } = await sim.quote(request());
    fake.failNext('deposit', 'Smart contract panicked');
    await expect(sim.simulate(quote.depositAddress!, 'exact')).rejects.toThrow(/deposit/);
    expect((await sim.status(quote.depositAddress!)).status).toBe('PENDING_DEPOSIT');
  });

  it('wallet payout (DESTINATION_CHAIN) settles without an intents credit', async () => {
    const { quote } = await sim.quote(
      request({
        recipientType: 'DESTINATION_CHAIN',
        recipient: '0x3333333333333333333333333333333333333333',
      }),
    );
    const res = await sim.simulate(quote.depositAddress!, 'exact');
    expect(res.status).toBe('SUCCESS');
    expect(depositsTo('0x3333333333333333333333333333333333333333')).toHaveLength(0);
  });

  it('submitDeposit records the tx and marks it KNOWN_DEPOSIT_TX', async () => {
    const { quote } = await sim.quote(request());
    await sim.submitDeposit('0xtx', quote.depositAddress!);
    const res = await sim.status(quote.depositAddress!);
    expect(res.status).toBe('KNOWN_DEPOSIT_TX');
    expect(res.swapDetails.originChainTxHashes).toEqual([{ hash: '0xtx' }]);
    await expect(sim.submitDeposit('0xtx', '0xnope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('SimulatedOneClick shared state (Redis)', () => {
  it('two provider instances (API and worker processes) see the same deposits', async () => {
    const api = new SimulatedOneClick({ now: () => clock });
    const worker = new SimulatedOneClick({ now: () => clock });
    const { quote } = await api.quote(request());
    const addr = quote.depositAddress!;

    expect((await worker.status(addr)).status).toBe('PENDING_DEPOSIT');
    await api.simulate(addr, 'underpay');
    expect((await worker.status(addr)).status).toBe('INCOMPLETE_DEPOSIT');
    await worker.simulate(addr, 'topup');
    expect(await api.status(addr)).toEqual(await worker.status(addr));
    expect((await api.status(addr)).status).toBe('SUCCESS');
    expect(depositsTo('shop.tendr.testnet')).toHaveLength(1);
  });

  it('stores each deposit as JSON under sim1click:<address> with a 48 h TTL', async () => {
    const { quote } = await sim.quote(request());
    const redis = getRedis();
    const key = `${SIM_KEY_PREFIX}${quote.depositAddress!}`;
    const stored = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
    expect(stored).toMatchObject({
      status: 'PENDING_DEPOSIT',
      amountIn: quote.amountIn,
      amountOut: '25000000',
      deadline: DEADLINE.toISOString(),
      req: request(),
    });
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(SIM_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(SIM_TTL_MS);
  });

  it('a concurrent simulate on the same address is refused, so it settles once', async () => {
    const a = new SimulatedOneClick({ now: () => clock });
    const b = new SimulatedOneClick({ now: () => clock });
    const { quote } = await a.quote(request());
    const results = await Promise.allSettled([
      a.simulate(quote.depositAddress!, 'exact'),
      b.simulate(quote.depositAddress!, 'exact'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) }),
    ]);
    expect(depositsTo('shop.tendr.testnet')).toHaveLength(1);
  });

  it('the in-memory store (unit tests only) keeps state per instance', async () => {
    const mem = new SimulatedOneClick({ now: () => clock, store: new MemorySimStore() });
    const { quote } = await mem.quote(request({ recipient: 'mem.tendr.testnet' }));
    expect((await mem.simulate(quote.depositAddress!, 'exact')).status).toBe('SUCCESS');
    await expect(sim.status(quote.depositAddress!)).rejects.toMatchObject({ status: 404 });
  });
});
