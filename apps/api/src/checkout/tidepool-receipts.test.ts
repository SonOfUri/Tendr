import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIDEPOOL_TOKENS as T, TIDEPOOL_VERIFIER as V } from '@tendr/contracts';
import { eventLog } from '../near/events.js';
import { verifyTidepoolPayout } from './tidepool-receipts.js';
import type { StatusResponse } from './oneclick/types.js';

const txStatus = vi.hoisted(() => vi.fn());
vi.mock('../near/client.js', () => ({ nearClient: () => ({ txStatus }) }));
const origin = 'BxD8rWUyFsoybutxbx8BiPZLGgtkmz2dgfuqg1j8q29o';
const nearTx = '5M9xKKwtMCyXopwuwz4LhejnoXD2XVYHyWiu64AVrtvD';
const solTx =
  '4hWKtv8Gfqih3uBsb9XhqJPG4FjHdaNjCQxUhjS2H9qSeDn8KnWDJW79FHGq9G6qdf5zVvCRzngVCYgFnfdZHYjo';
const signer = `0x${'a'.repeat(40)}`;
const deposit = 'b'.repeat(64);
const status: StatusResponse = {
  status: 'SUCCESS',
  swapDetails: {
    originChainTxHashes: [{ hash: origin }],
    destinationChainTxHashes: [{ hash: nearTx }, { hash: solTx }],
  },
};
const payout = (chain: 'near' | 'sol'): Parameters<typeof verifyTidepoolPayout>[0] => ({
  livemode: false,
  destinationAsset: chain === 'near' ? T.nearUsdt.assetId : T.solUsdt.assetId,
  destinationChain: chain,
  destination: chain === 'near' ? 'recipient.testnet' : 'recipient-sol',
  asset: T.nearUsdc.assetId,
  amount: '1000000',
  depositAddress: deposit,
  quote: { quote: { minAmountOut: '900000', amountOut: '1000000' } },
  payload: JSON.stringify({ signer_id: signer, nonce: 'nonce' }),
  intentHash: 'intent',
});
const outcome = (executorId: string, logs: string[]) => ({
  finalized: true,
  topLevelOk: true,
  receipts: [{ executorId, ok: true, receiptId: 'r1', logs }],
});

describe('Tidepool payout receipt verification', () => {
  beforeEach(() => {
    txStatus.mockImplementation(async (hash: string) =>
      hash === origin
        ? outcome(V, [
            eventLog('nep245', '1.0.0', 'mt_transfer', [
              {
                old_owner_id: signer,
                new_owner_id: deposit,
                token_ids: [T.nearUsdc.assetId],
                amounts: ['1000000'],
              },
            ]),
            eventLog('dip4', '0.4.3', 'transfer', [
              {
                account_id: signer,
                receiver_id: deposit,
                tokens: { [T.nearUsdc.assetId]: '1000000' },
                intent_hash: 'intent',
              },
            ]),
            eventLog('dip4', '0.4.3', 'intents_executed', [
              { account_id: signer, nonce: 'nonce', intent_hash: 'intent' },
            ]),
          ])
        : outcome(T.nearUsdt.contract, [
            eventLog('nep141', '1.0.0', 'ft_transfer', [
              { new_owner_id: 'recipient.testnet', amount: '950000' },
            ]),
          ]),
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('verifies an external NEAR token transfer and rejects a different recipient or minimum', async () => {
    expect(await verifyTidepoolPayout(payout('near'), status)).toBe(true);
    expect(
      await verifyTidepoolPayout({ ...payout('near'), destination: 'other.testnet' }, status),
    ).toBe(false);
    expect(
      await verifyTidepoolPayout(
        { ...payout('near'), quote: { quote: { amountOut: '1000001' } } },
        status,
      ),
    ).toBe(false);
  });

  it('does not accept non-final receipts or reuse a different signed nonce', async () => {
    expect(
      await verifyTidepoolPayout(
        { ...payout('near'), payload: JSON.stringify({ signer_id: signer, nonce: 'other' }) },
        status,
      ),
    ).toBe(false);
    txStatus.mockResolvedValue({ finalized: false, topLevelOk: true, receipts: [] });
    expect(await verifyTidepoolPayout(payout('near'), status)).toBe(false);
  });

  it('verifies finalized Solana devnet token deltas, not the full balance', async () => {
    let added = '950000';
    const fetcher = vi.fn(async (_url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method === 'getGenesisHash')
        return Response.json({ result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
      expect(params[1].commitment).toBe('finalized');
      const balance = (amount: string) => ({
        accountIndex: 1,
        mint: T.solUsdt.contract,
        owner: 'recipient-sol',
        uiTokenAmount: { amount },
      });
      return Response.json({
        result: {
          meta: {
            err: null,
            preTokenBalances: [balance('100000000')],
            postTokenBalances: [balance(String(100000000n + BigInt(added)))],
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await verifyTidepoolPayout(payout('sol'), status)).toBe(true);
    added = '1';
    expect(await verifyTidepoolPayout(payout('sol'), status)).toBe(false);
  });

  it('rejects a mainnet RPC, live payout or provider status without success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: 'mainnet-genesis' })),
    );
    expect(await verifyTidepoolPayout(payout('sol'), status)).toBe(false);
    expect(await verifyTidepoolPayout({ ...payout('near'), livemode: true }, status)).toBe(false);
    expect(await verifyTidepoolPayout(payout('near'), { ...status, status: 'PROCESSING' })).toBe(
      false,
    );
  });
});
