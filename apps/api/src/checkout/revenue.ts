// Revenue entries for a settled payment (spec §5): Tendr's fee (the 1Click `appFees` entry),
// 1Click's fee (its fee plus the swap spread), the network fee the shopper paid themselves (the
// quote's estimate) and the gas reimbursement: the merchant-sponsored network fee and integrator
// hook estimate collected from the merchant's proceeds through the same `appFees` entry (the
// quote's `network_fee_bps`, project 5a §8.1).
//
// Every row is in the payment's ORIGIN asset base units at the quote's price, with its USD value
// in `amount_usd`: Tendr's fee is `fee_bps` and the gas reimbursement `network_fee_bps` of the
// value 1Click charges `appFees` on (ONECLICK_APP_FEE_BASE: the output, or the input); the USD
// figures are converted to units at the quote's `amount_in / amount_in_usd`. Rows with a zero amount are not written. A shopper-paid token fee
// is not a line here: it is collected outside the swap, by the relayed transaction.
// One row per (payment, source) (a unique index): recording twice is a no-op.
import { Prisma } from '@prisma/client';
import type { ScopeContext } from '../db/scoped.js';
import { assertTransaction } from '../events/record.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { gasEstimateUsd } from './gas-estimates.js';
import { ONECLICK_APP_FEE_BASE, appFeeBaseValue, type AppFeeBase } from './oneclick/types.js';

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;
type Source = 'app_fee' | 'oneclick_fee' | 'network_fee' | 'gas_reimbursement';

export interface RevenueLine {
  source: Source;
  assetId: string;
  /** Origin-asset base units. */
  amount: Decimal;
  amountUsd: Decimal | null;
}

/**
 * The revenue lines of a payment (pure). `amountIn` / `amountInUsd` / `amountOutUsd` and the
 * `networkFee*` fields are the quote's; `chain` is the origin chain (the static network-fee
 * estimate for quotes made before gasless payments).
 */
export function revenueLines(
  input: {
    originAsset: string;
    chain: string;
    amountIn: Decimal;
    amountInUsd: Decimal | null;
    amountOutUsd: Decimal | null;
    feeBps: number;
    /** `appFees` basis points that collected the merchant-sponsored fee (and hook estimate). */
    networkFeeBps: number;
    /** The quote's network fee (USD); null on quotes made before gasless payments. */
    networkFeeUsd: Decimal | null;
    /** Who paid the network fee; null on quotes made before gasless payments. */
    networkFeePaidBy: 'merchant' | 'buyer' | null;
  },
  appFeeBase: AppFeeBase = ONECLICK_APP_FEE_BASE,
): RevenueLine[] {
  const { amountIn, amountInUsd } = input;
  const bps = new D(input.feeBps).div(10_000);
  const usdToUnits = (usd: Decimal): Decimal =>
    amountInUsd && amountInUsd.gt(0)
      ? usd.mul(amountIn).div(amountInUsd).toDecimalPlaces(0, D.ROUND_DOWN)
      : new D(0);
  const usd = (v: Decimal | null) => (v ? v.toDecimalPlaces(6, D.ROUND_HALF_UP) : null);

  // The value `appFees` are charged on, in origin units and in USD.
  const feeBaseUnits = appFeeBaseValue(
    { input: amountIn, output: input.amountOutUsd ? usdToUnits(input.amountOutUsd) : new D(0) },
    appFeeBase,
  );
  const feeBaseUsd = appFeeBaseValue(
    { input: amountInUsd, output: input.amountOutUsd },
    appFeeBase,
  );
  const appFee = feeBaseUnits.mul(bps).toDecimalPlaces(0, D.ROUND_DOWN);
  const appFeeUsd = feeBaseUsd ? feeBaseUsd.mul(bps) : null;
  const gasBps = new D(input.networkFeeBps).div(10_000);
  const gas = feeBaseUnits.mul(gasBps).toDecimalPlaces(0, D.ROUND_DOWN);
  const gasUsd = feeBaseUsd ? feeBaseUsd.mul(gasBps) : null;
  const lines: RevenueLine[] = [
    { source: 'app_fee', assetId: input.originAsset, amount: appFee, amountUsd: usd(appFeeUsd) },
  ];
  if (amountInUsd && input.amountOutUsd && appFeeUsd && gasUsd) {
    const spread = D.max(0, amountInUsd.minus(input.amountOutUsd).minus(appFeeUsd).minus(gasUsd));
    lines.push({
      source: 'oneclick_fee',
      assetId: input.originAsset,
      amount: usdToUnits(spread),
      amountUsd: usd(spread),
    });
  }
  // The shopper's own network fee; a sponsored fee is the gas reimbursement instead.
  if (input.networkFeePaidBy !== 'merchant') {
    const network = input.networkFeeUsd ?? new D(gasEstimateUsd(input.chain));
    lines.push({
      source: 'network_fee',
      assetId: input.originAsset,
      amount: usdToUnits(network),
      amountUsd: usd(network),
    });
  }
  lines.push({
    source: 'gas_reimbursement',
    assetId: input.originAsset,
    amount: gas,
    amountUsd: usd(gasUsd),
  });
  return lines.filter((l) => l.amount.gt(0));
}

/**
 * Writes the revenue entries of a settled payment inside the caller's `tenantTransaction`
 * (same `ctx`). Idempotent. Returns how many rows were written.
 */
export async function recordRevenue(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  paymentId: string,
): Promise<number> {
  assertTransaction(tx);
  const tenant = { merchantId: ctx.merchantId, livemode: ctx.livemode };
  const p = await tx.payment.findFirst({
    where: { id: paymentId, ...tenant },
    include: { quote: true, session: true },
  });
  if (!p) throw notFound('Payment not found');
  const lines = revenueLines({
    originAsset: p.quote.originAssetId,
    chain: p.senderChain ?? '',
    amountIn: p.quote.amountIn,
    amountInUsd: p.quote.amountInUsd,
    amountOutUsd: p.quote.amountOutUsd,
    feeBps: p.session.feeBps,
    networkFeeBps: p.quote.networkFeeBps,
    networkFeeUsd: p.quote.networkFeeUsd,
    networkFeePaidBy: p.quote.networkFeePaidBy,
  });
  if (lines.length === 0) return 0;
  const { count } = await tx.revenueEntry.createMany({
    data: lines.map((l) => ({
      id: newId('rev'),
      ...tenant,
      paymentId: p.id,
      source: l.source,
      assetId: l.assetId,
      amount: l.amount,
      amountUsd: l.amountUsd,
      txHash: p.settleTx,
    })),
    skipDuplicates: true,
  });
  return count;
}
