import { z } from 'zod';
import { TIDEPOOL_TOKENS } from '@tendr/contracts';
import {
  OneClickError,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
} from '../checkout/oneclick/index.js';

type Provider = {
  quote(request: QuoteRequest): Promise<QuoteResponse>;
  status(deposit: string): Promise<StatusResponse>;
};
const units = z
  .string()
  .regex(/^[1-9]\d{0,38}$/)
  .refine((s) => BigInt(s) < 2n ** 128n);
const deposit = z.string().regex(/^(?:[0-9a-f]{64}|(?:[a-z0-9_-]+\.)*testnet)$/);
const routeSchema = z.object({
  kind: z.literal('same_asset'),
  intermediateAsset: z.enum(
    Object.values(TIDEPOOL_TOKENS).map((t) => t.assetId) as [string, ...string[]],
  ),
  secondDepositAddress: deposit,
  intermediateAmount: units,
});
export type TidepoolPayoutQuote = QuoteResponse & {
  tidepoolRoute?: z.infer<typeof routeSchema>;
};

function unavailable(message: string): never {
  throw new OneClickError(message, null, 'BAD_RESPONSE');
}

function validateLeg(q: QuoteResponse, deadline: string, funded: boolean) {
  if (
    !units.safeParse(q.quote.amountIn).success ||
    !units.safeParse(q.quote.amountOut).success ||
    !units.safeParse(q.quote.minAmountOut).success ||
    BigInt(q.quote.minAmountOut!) > BigInt(q.quote.amountOut) ||
    q.quote.depositMemo ||
    (funded &&
      (!deposit.safeParse(q.quote.depositAddress).success ||
        !Number.isFinite(Date.parse(q.quote.deadline ?? '')) ||
        Date.parse(q.quote.deadline!) < Date.parse(deadline)))
  )
    unavailable('Tidepool returned an unsupported payout route');
}

/** Tidepool rejects A -> A quotes. Route A -> B -> A, with B staying inside Intents.
 * Both quotes return failed deposits to the owner's wallet. The owner signs only the first
 * debit; the first quote delivers directly to the second quote's unique deposit account.
 * Never change the approved final token/address, and never debit more for EXACT_INPUT.
 */
export async function quoteTidepoolPayout(
  provider: Provider,
  request: QuoteRequest,
): Promise<TidepoolPayoutQuote> {
  if (request.originAsset !== request.destinationAsset) return provider.quote(request);
  const token = Object.values(TIDEPOOL_TOKENS).find((t) => t.assetId === request.originAsset);
  if (
    !token ||
    request.dry ||
    request.depositType !== 'INTENTS' ||
    request.refundType !== 'INTENTS' ||
    request.recipientType !== 'DESTINATION_CHAIN' ||
    request.appFees?.length
  )
    unavailable('Unsupported Tidepool payout request');
  const intermediate = Object.values(TIDEPOOL_TOKENS).find(
    (t) =>
      t.symbol === token.symbol && t.blockchain === (token.blockchain === 'near' ? 'base' : 'near'),
  )!;
  const firstRequest: QuoteRequest = {
    ...request,
    destinationAsset: intermediate.assetId,
    recipientType: 'INTENTS',
    // The second leg must be funded in full. A worse price refunds the first leg instead.
    slippageTolerance: 0,
  };
  let secondAmount = request.amount;
  if (request.swapType === 'EXACT_INPUT') {
    const preview = await provider.quote({
      ...firstRequest,
      dry: true,
      recipient: request.refundTo,
    });
    validateLeg(preview, request.deadline, false);
    if (preview.quote.amountIn !== request.amount) unavailable('Tidepool changed the payout debit');
    secondAmount = preview.quote.minAmountOut!;
  }
  // Give the forwarding leg ten extra minutes to arrive; signing still expires at the original deadline.
  const secondDeadline = new Date(Date.parse(request.deadline) + 10 * 60_000).toISOString();
  const second = await provider.quote({
    ...request,
    originAsset: intermediate.assetId,
    amount: secondAmount,
    deadline: secondDeadline,
  });
  validateLeg(second, secondDeadline, true);
  if (
    request.swapType === 'EXACT_INPUT'
      ? second.quote.amountIn !== secondAmount
      : second.quote.amountOut !== request.amount || second.quote.minAmountOut !== request.amount
  )
    unavailable('Tidepool changed the final payout amount');
  const first = await provider.quote({
    ...firstRequest,
    amount: request.swapType === 'EXACT_OUTPUT' ? second.quote.amountIn : request.amount,
    recipient: second.quote.depositAddress!,
  });
  validateLeg(first, request.deadline, true);
  if (
    (request.swapType === 'EXACT_INPUT' && first.quote.amountIn !== request.amount) ||
    first.quote.amountOut !== second.quote.amountIn ||
    first.quote.minAmountOut !== second.quote.amountIn ||
    first.quote.depositAddress === second.quote.depositAddress
  )
    unavailable('Tidepool prices changed while preparing the route; request a new quote');
  return {
    correlationId: first.correlationId,
    quote: {
      ...first.quote,
      amountOut: second.quote.amountOut,
      amountOutUsd: second.quote.amountOutUsd,
      minAmountOut: second.quote.minAmountOut,
      deadline: request.deadline,
      ...(first.quote.timeEstimate !== undefined && second.quote.timeEstimate !== undefined
        ? { timeEstimate: first.quote.timeEstimate + second.quote.timeEstimate }
        : {}),
    },
    tidepoolRoute: {
      kind: 'same_asset',
      intermediateAsset: intermediate.assetId,
      intermediateAmount: second.quote.amountIn,
      secondDepositAddress: second.quote.depositAddress!,
    },
  };
}

/** Do not report completion at the intermediate Intents credit. Preserve the original debit
 * receipts and the final destination receipts for independent on-chain verification.
 */
export async function tidepoolPayoutStatus(
  provider: Provider,
  first: StatusResponse,
  quote: unknown,
): Promise<StatusResponse> {
  const parsed = z.object({ tidepoolRoute: routeSchema.optional() }).parse(quote);
  if (!parsed.tidepoolRoute || first.status !== 'SUCCESS') return first;
  const second = await provider.status(parsed.tidepoolRoute.secondDepositAddress);
  return {
    ...second,
    status:
      second.status === 'PENDING_DEPOSIT' || second.status === 'KNOWN_DEPOSIT_TX'
        ? 'PROCESSING'
        : second.status,
    swapDetails: {
      ...second.swapDetails,
      amountIn: first.swapDetails.amountIn,
      originChainTxHashes: first.swapDetails.originChainTxHashes,
    },
  };
}
