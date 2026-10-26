// The return-fee arithmetic shared by settlement (watcher.ts: whether an overpay is kept small,
// M-8) and returns (refunds.ts: the net sent back). One computation, so the first
// `payment.succeeded` carries the same `kept_small_overpayment` the return path then applies.
import { Prisma, type Quote } from '@prisma/client';
import { SMALL_OVERPAY_USD } from '@tendr/contracts';
import { gasEstimateUsd } from './gas-estimates.js';
import { tokenInfo } from './tokens.js';

type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/** USD per base unit of `assetId`: the token list's price, else the quote's own in/out ratio. */
export async function usdPerUnit(
  livemode: boolean,
  assetId: string,
  quote: Pick<Quote, 'originAssetId' | 'amountIn' | 'amountInUsd'>,
): Promise<Dec | null> {
  try {
    const t = await tokenInfo(livemode, assetId);
    if (t.priceUsd && D(t.priceUsd).gt(0)) return D(t.priceUsd).div(D(10).pow(t.decimals));
  } catch {
    // Unlisted or the provider is down: fall back to the quote.
  }
  if (assetId === quote.originAssetId && quote.amountInUsd && quote.amountIn.gt(0)) {
    return quote.amountInUsd.div(quote.amountIn);
  }
  return null;
}

/**
 * `amount` less the estimated return fee (`feeUsd` converted at `perUnit`, rounded up): the net
 * sent back and its USD value.
 */
export function netOfReturnFee(
  amount: bigint,
  perUnit: Dec,
  feeUsd: Dec,
): { fee: bigint; net: bigint; netUsd: Dec } {
  const fee = perUnit.gt(0) ? BigInt(feeUsd.div(perUnit).ceil().toFixed(0)) : 0n;
  const net = amount > fee ? amount - fee : 0n;
  return { fee: fee > amount ? amount : fee, net, netUsd: perUnit.mul(net.toString()) };
}

/**
 * Whether returning `amount` of `assetId` to a sender on `senderChain` is worth less than
 * SMALL_OVERPAY_USD once the estimated return fee is deducted (the merchant keeps it). Null when it
 * cannot be told (no price): the return path then sends it to review, never keeps it.
 */
export async function keptSmallNetOfFee(
  livemode: boolean,
  assetId: string,
  amount: bigint,
  senderChain: string,
  quote: Pick<Quote, 'originAssetId' | 'amountIn' | 'amountInUsd'>,
): Promise<boolean | null> {
  const perUnit = await usdPerUnit(livemode, assetId, quote);
  if (!perUnit) return null;
  const { net, netUsd } = netOfReturnFee(amount, perUnit, D(gasEstimateUsd(senderChain)));
  return net <= 0n || netUsd.lt(SMALL_OVERPAY_USD);
}
