import { describe, expect, it, vi } from 'vitest';
import { TIDEPOOL_TOKENS as T } from '@tendr/contracts';
import {
  OneClickError,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
} from '../checkout/oneclick/index.js';
import { quoteTidepoolPayout, tidepoolPayoutStatus } from './tidepool-payout-route.js';

const request = (asset: string = T.baseUsdt.assetId): QuoteRequest => ({
  dry: false,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: asset,
  destinationAsset: asset,
  amount: '1469040',
  depositType: 'INTENTS',
  refundType: 'INTENTS',
  refundTo: `0x${'12'.repeat(20)}`,
  recipientType: 'DESTINATION_CHAIN',
  recipient: `0x${'34'.repeat(20)}`,
  deadline: new Date(Date.now() + 300_000).toISOString(),
});
function provider() {
  let count = 0;
  return {
    quote: vi.fn(async (r: QuoteRequest): Promise<QuoteResponse> => {
      // Actual Tidepool rejects this, unlike the old integration mock.
      if (r.originAsset === r.destinationAsset)
        throw new OneClickError('originAsset and destinationAsset must differ', 400, 'HTTP_400');
      const input = r.swapType === 'EXACT_INPUT' ? BigInt(r.amount) : BigInt(r.amount) + 1000n;
      const output = input - 1000n;
      return {
        correlationId: String(++count),
        quote: {
          amountIn: String(input),
          amountOut: String(output),
          minAmountOut:
            r.swapType === 'EXACT_OUTPUT'
              ? String(output)
              : String((output * BigInt(10_000 - r.slippageTolerance)) / 10_000n),
          amountInUsd: '1.469',
          amountOutUsd: '1.467',
          deadline: r.deadline,
          timeEstimate: 10,
          ...(r.dry ? {} : { depositAddress: String(count).padStart(64, '0') }),
        },
      };
    }),
    status: vi.fn(),
  };
}
const state = (status: StatusResponse['status'], hash: string): StatusResponse => ({
  status,
  swapDetails: {
    amountIn: '1469040',
    amountOut: '1467040',
    originChainTxHashes: [{ hash: `${hash}-debit` }],
    destinationChainTxHashes: [{ hash: `${hash}-credit` }],
  },
});

describe('Tidepool same-token payout routing', () => {
  it.each(Object.values(T).map((t) => [t.assetId, t.symbol]))(
    'routes %s without changing the final asset, address or debit',
    async (asset, symbol) => {
      const p = provider();
      const r = request(asset);
      const result = await quoteTidepoolPayout(p, r);
      expect(p.quote).toHaveBeenCalledTimes(3);
      const [preview, second, first] = p.quote.mock.calls.map((c) => c[0]);
      expect(preview).toMatchObject({ dry: true, recipient: r.refundTo, slippageTolerance: 0 });
      expect(second).toMatchObject({
        originAsset: result.tidepoolRoute!.intermediateAsset,
        destinationAsset: asset,
        recipient: r.recipient,
        recipientType: 'DESTINATION_CHAIN',
        refundTo: r.refundTo,
        refundType: 'INTENTS',
      });
      expect(Object.values(T).find((t) => t.assetId === second!.originAsset)?.symbol).toBe(symbol);
      expect(first).toMatchObject({
        originAsset: asset,
        recipient: result.tidepoolRoute!.secondDepositAddress,
        recipientType: 'INTENTS',
        amount: r.amount,
        slippageTolerance: 0,
        refundTo: r.refundTo,
        refundType: 'INTENTS',
      });
      expect(result.quote).toMatchObject({
        amountIn: r.amount,
        amountOut: '1467040',
        minAmountOut: '1452369',
        timeEstimate: 20,
        deadline: r.deadline,
      });
      expect(Date.parse(second!.deadline) - Date.parse(first!.deadline)).toBe(600_000);
      expect(result.quote.depositAddress).not.toBe(result.tidepoolRoute!.secondDepositAddress);
    },
  );
  it('quotes invoice output exactly and includes both costs in the wallet debit', async () => {
    const p = provider();
    const r = { ...request(), swapType: 'EXACT_OUTPUT' as const };
    const result = await quoteTidepoolPayout(p, r);
    expect(p.quote).toHaveBeenCalledTimes(2);
    expect(result.quote).toMatchObject({
      amountIn: '1471040',
      amountOut: r.amount,
      minAmountOut: r.amount,
    });
    expect(p.quote.mock.calls[1]![0]).toMatchObject({
      amount: '1470040',
      recipientType: 'INTENTS',
    });
  });
  it('leaves different-asset quotes on their original single route', async () => {
    const p = provider();
    const r = { ...request(), destinationAsset: T.solUsdc.assetId };
    expect((await quoteTidepoolPayout(p, r)).tidepoolRoute).toBeUndefined();
    expect(p.quote).toHaveBeenCalledExactlyOnceWith(r);
  });
  it.each(['changed price', 'larger debit', 'memo', 'early expiry', 'bad output'])(
    'rejects %s without returning a signable route',
    async (change) => {
      const p = provider();
      const original = p.quote.getMockImplementation()!;
      p.quote.mockImplementation(async (r) => {
        const result = await original(r);
        if (!r.dry && r.recipientType === 'INTENTS') {
          if (change === 'changed price')
            result.quote.minAmountOut = String(BigInt(result.quote.minAmountOut!) - 1n);
          if (change === 'larger debit') result.quote.amountIn = String(BigInt(r.amount) + 1n);
          if (change === 'memo') result.quote.depositMemo = 'required';
          if (change === 'early expiry')
            result.quote.deadline = new Date(Date.parse(r.deadline) - 1).toISOString();
          if (change === 'bad output') result.quote.amountOut = '0';
        }
        return result;
      });
      await expect(quoteTidepoolPayout(p, request())).rejects.toBeInstanceOf(OneClickError);
    },
  );
  it('waits for the final leg and joins only original debit and final delivery receipts', async () => {
    const p = provider();
    const q = await quoteTidepoolPayout(p, request());
    const first = state('SUCCESS', 'first');
    p.status.mockResolvedValue(state('PENDING_DEPOSIT', 'second'));
    expect((await tidepoolPayoutStatus(p, first, q)).status).toBe('PROCESSING');
    p.status.mockResolvedValue(state('SUCCESS', 'second'));
    const final = await tidepoolPayoutStatus(p, first, q);
    expect(final).toMatchObject({
      status: 'SUCCESS',
      swapDetails: {
        originChainTxHashes: [{ hash: 'first-debit' }],
        destinationChainTxHashes: [{ hash: 'second-credit' }],
      },
    });
    expect(p.status).toHaveBeenLastCalledWith(q.tidepoolRoute!.secondDepositAddress);
  });
  it.each(['REFUNDED', 'FAILED'] as const)(
    'keeps %s distinct from successful delivery on either leg',
    async (status) => {
      const p = provider();
      const q = await quoteTidepoolPayout(p, request());
      expect(await tidepoolPayoutStatus(p, state(status, 'first'), q)).toEqual(
        state(status, 'first'),
      );
      expect(p.status).not.toHaveBeenCalled();
      p.status.mockResolvedValue(state(status, 'second'));
      expect((await tidepoolPayoutStatus(p, state('SUCCESS', 'first'), q)).status).toBe(status);
    },
  );
});
