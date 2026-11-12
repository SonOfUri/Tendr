import { describe, expect, it, vi } from 'vitest';
import { validateTransferPayload } from '../../accounts/native-signing.js';
import {
  TidepoolOneClick,
  TIDEPOOL_BASE_URL,
  TIDEPOOL_TOKENS,
  TIDEPOOL_VERIFIER,
  tidepoolTransferPayload,
  tidepoolNearSettlementHashes,
} from './tidepool.js';
import type { QuoteRequest } from './types.js';

const signerId = `0x${'12'.repeat(20)}`;
const transfer = () => ({
  signerId,
  depositAddress: 'quote.tidepool-sandbox.testnet',
  asset: TIDEPOOL_TOKENS.nearUsdt.assetId,
  amount: '1000000',
  expiresAt: new Date(Date.now() + 300_000),
});
const catalog = () => Object.values(TIDEPOOL_TOKENS).map((token) => ({ ...token, decimals: 6 }));
const quoteRequest = (): QuoteRequest => ({
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: TIDEPOOL_TOKENS.solUsdc.assetId,
  destinationAsset: TIDEPOOL_TOKENS.nearUsdt.assetId,
  amount: '1000000',
  depositType: 'ORIGIN_CHAIN',
  refundType: 'ORIGIN_CHAIN',
  refundTo: 'customer',
  recipient: signerId,
  recipientType: 'INTENTS',
  deadline: new Date(Date.now() + 300_000).toISOString(),
});

describe('Tidepool testnet boundary', () => {
  it('accepts the implicit INTENTS deposit accounts returned by Tidepool', () => {
    const input = {
      ...transfer(),
      depositAddress: '15ce20c1fe2ba146324314f99f557cf786e0757640ee05617556a52c4af050f6',
    };
    expect(
      validateTransferPayload(tidepoolTransferPayload(input), {
        ...input,
        contract: TIDEPOOL_VERIFIER,
      }),
    ).toEqual(input.expiresAt);
  });
  it('separates NEAR settlement candidates from Solana refunds and Base payouts', () => {
    const nearHash = '5M9xKKwtMCyXopwuwz4LhejnoXD2XVYHyWiu64AVrtvD';
    expect(
      tidepoolNearSettlementHashes({
        status: 'SUCCESS',
        swapDetails: {
          originChainTxHashes: [],
          destinationChainTxHashes: [
            { hash: nearHash },
            { hash: nearHash },
            { hash: 'not-a-hash' },
            { hash: `0x${'ab'.repeat(32)}` },
            {
              hash: 'L5E36XeubxskGeWZyVYkqnS5LVMrQNqXg4CHWkRYiRzp5peJJttRD1VoztF2VLHVHU5Jm9VBsP4CiUzwtUP5ijb',
            },
          ],
        },
      }),
    ).toEqual([nearHash]);
  });
  it('uses the pinned endpoint without a mainnet credential and returns only the six pilot assets', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            ...catalog(),
            { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
          ]),
        ),
    );
    const provider = new TidepoolOneClick({ fetch });
    expect(await provider.tokens()).toHaveLength(6);
    expect(fetch).toHaveBeenCalledWith(
      `${TIDEPOOL_BASE_URL}/v0/tokens`,
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  it.each(['missing', 'duplicate', 'decimals', 'chain'])(
    'fails closed when the catalog is %s',
    async (change) => {
      const tokens = catalog();
      if (change === 'missing') tokens.pop();
      if (change === 'duplicate') tokens.push(tokens[0]!);
      if (change === 'decimals') tokens[0]!.decimals = 18;
      if (change === 'chain') Object.assign(tokens[0]!, { blockchain: 'eth' });
      const provider = new TidepoolOneClick({
        fetch: async () => new Response(JSON.stringify(tokens)),
      });
      await expect(provider.tokens()).rejects.toThrow('catalog changed');
    },
  );

  it.each([
    { originAsset: 'nep141:usdc.near' },
    { destinationAsset: 'nep141:usdt.tether-token.near' },
    { amount: '0' },
    { amount: '-1' },
    { amount: '1.5' },
    { amount: (2n ** 128n).toString() },
    { appFees: [{ recipient: 'treasury.near', fee: 20 }] },
  ])('rejects unsafe quote inputs before contacting the provider: %j', (overrides) => {
    const fetch = vi.fn();
    const provider = new TidepoolOneClick({ fetch });
    expect(() => provider.quote({ ...quoteRequest(), ...overrides })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('constructs a bounded single-debit WebAuthn payload accepted by the existing payout guard', () => {
    const input = transfer();
    const payload = tidepoolTransferPayload(input);
    expect(validateTransferPayload(payload, { ...input, contract: TIDEPOOL_VERIFIER })).toEqual(
      input.expiresAt,
    );
    expect(() =>
      validateTransferPayload(payload, { ...input, contract: 'intents.near' }),
    ).toThrow();
    expect(() =>
      validateTransferPayload(payload, {
        ...input,
        contract: TIDEPOOL_VERIFIER,
        amount: '1000001',
      }),
    ).toThrow();
    expect(JSON.parse(tidepoolTransferPayload(input)).nonce).not.toBe(JSON.parse(payload).nonce);
  });

  it.each([
    { signerId: 'merchant.near' },
    { depositAddress: 'quote.near' },
    { asset: 'nep141:usdc.near' },
    { amount: '0' },
    { expiresAt: new Date(0) },
    { expiresAt: new Date(Date.now() + 31 * 60_000) },
  ])('rejects unsafe signing requests: %j', (overrides) => {
    expect(() => tidepoolTransferPayload({ ...transfer(), ...overrides })).toThrow();
  });
});
