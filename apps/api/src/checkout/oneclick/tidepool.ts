// Real testnet provider selected only by TEST_PAYMENT_PROVIDER=tidepool.
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { validateTransferPayload, type NativeSignedIntent } from '../../accounts/native-signing.js';
import { HttpOneClick, type FetchLike } from './http.js';
import {
  OneClickError,
  type OneClickProvider,
  type QuoteRequest,
  type StatusResponse,
} from './types.js';

import { TIDEPOOL_BASE_URL, TIDEPOOL_VERIFIER, TIDEPOOL_TOKENS } from '@tendr/contracts';
export { TIDEPOOL_BASE_URL, TIDEPOOL_VERIFIER, TIDEPOOL_TOKENS };
const supported = new Set<string>(Object.values(TIDEPOOL_TOKENS).map((t) => t.assetId));

function requireAsset(asset: string): void {
  if (!supported.has(asset)) throw new Error('Unsupported Tidepool testnet asset');
}

function requireAmount(amount: string): void {
  if (!/^[1-9]\d{0,38}$/.test(amount) || BigInt(amount) >= 2n ** 128n) {
    throw new Error('Expected a positive u128 token amount');
  }
}

export class TidepoolOneClick implements OneClickProvider {
  private readonly http: HttpOneClick;

  constructor(options: { fetch?: FetchLike } = {}) {
    // Never forward the production 1Click credential to this independent service.
    this.http = new HttpOneClick({ baseUrl: TIDEPOOL_BASE_URL, fetch: options.fetch });
  }

  async tokens() {
    const tokens = (await this.http.tokens()).filter((t) => supported.has(t.assetId));
    for (const expected of Object.values(TIDEPOOL_TOKENS)) {
      const matches = tokens.filter((t) => t.assetId === expected.assetId);
      if (
        matches.length !== 1 ||
        matches[0]!.blockchain !== expected.blockchain ||
        matches[0]!.symbol !== expected.symbol ||
        matches[0]!.decimals !== 6
      ) {
        throw new OneClickError(
          'Tidepool test token catalog changed or a route is unavailable',
          null,
          'BAD_RESPONSE',
        );
      }
    }
    return tokens;
  }

  quote(request: QuoteRequest) {
    requireAsset(request.originAsset);
    requireAsset(request.destinationAsset);
    requireAmount(request.amount);
    // The pilot has no fee recipient. Do not accidentally credit a mainnet merchant/treasury.
    if (request.appFees?.length) throw new Error('Tidepool pilot app fees are not enabled');
    return this.http.quote(request);
  }

  status(depositAddress: string) {
    return this.http.status(depositAddress);
  }
  submitDeposit(txHash: string, depositAddress: string) {
    return this.http.submitDeposit(txHash, depositAddress);
  }
  submitIntent(signed: NativeSignedIntent) {
    return this.http.submitIntent(signed);
  }
}

/** Tidepool relays WebAuthn but cannot generate it. Build the single debit locally. */
export function tidepoolTransferPayload(input: {
  signerId: string;
  depositAddress: string;
  asset: string;
  amount: string;
  expiresAt: Date;
}): string {
  requireAsset(input.asset);
  requireAmount(input.amount);
  if (!/^0x[0-9a-f]{40}$/.test(input.signerId)) throw new Error('Expected a native P256 wallet');
  if (
    !/^(?:[a-z0-9_-]+\.)*testnet$/.test(input.depositAddress) &&
    !/^[0-9a-f]{64}$/.test(input.depositAddress)
  ) {
    throw new Error('Expected a NEAR testnet deposit account');
  }
  if (input.expiresAt.getTime() > Date.now() + 30 * 60_000) {
    throw new Error('Tidepool signing deadline must be within 30 minutes');
  }
  const payload = JSON.stringify({
    signer_id: input.signerId,
    verifying_contract: TIDEPOOL_VERIFIER,
    deadline: input.expiresAt.toISOString(),
    nonce: randomBytes(32).toString('base64'),
    intents: [
      {
        intent: 'transfer',
        receiver_id: input.depositAddress,
        tokens: { [input.asset]: input.amount },
      },
    ],
  });
  validateTransferPayload(payload, { ...input, contract: TIDEPOOL_VERIFIER });
  return payload;
}

/** Tidepool can mix origin-chain refunds into destinationChainTxHashes on SUCCESS.
 * This only selects candidates; their final receipts must still prove the expected credit.
 */
export function tidepoolNearSettlementHashes(status: StatusResponse): string[] {
  return [...new Set(status.swapDetails.destinationChainTxHashes.map((tx) => tx.hash))].filter(
    (hash) => {
      try {
        return bs58.decode(hash).length === 32;
      } catch {
        return false;
      }
    },
  );
}
