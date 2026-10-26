// Revenue entries for a settled payment (spec §5): Tendr's fee (the 1Click `appFees` entry),
// 1Click's fee (its fee plus the swap spread), the network fee (the shopper's estimated
// origin-chain send fee) and the merchant's gas reimbursement.
//
// Every row is in the payment's ORIGIN asset base units at the quote's price, with its USD value
// in `amount_usd`: Tendr's fee is `fee_bps × amount_in`; the other lines are USD figures
// converted at the quote's `amount_in / amount_in_usd`. Rows with a zero amount are not written.
// One row per (payment, source) (a unique index): recording twice is a no-op.
import { Prisma } from '@prisma/client';
import { gasPayerFromDb } from '@tendr/contracts';
import type { ScopeContext } from '../db/scoped.js';
import { assertTransaction } from '../events/record.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { gasEstimateUsd } from './gas-estimates.js';
import { gasReimbursementUsd } from './pricing.js';

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
 * The revenue lines of a payment (pure). `amountIn` / `amountInUsd` / `amountOutUsd` are the
 * quote's; `chain` is the origin chain (the network-fee estimate).
 */
export function revenueLines(input: {
  originAsset: string;
  chain: string;
  amountIn: Decimal;
  amountInUsd: Decimal | null;
  amountOutUsd: Decimal | null;
  feeBps: number;
  gasPayer: 'merchant' | 'shopper';
  gasMaxUsd: Decimal | null;
}): RevenueLine[] {
  const { amountIn, amountInUsd } = input;
  const bps = new D(input.feeBps).div(10_000);
  const usdToUnits = (usd: Decimal): Decimal =>
    amountInUsd && amountInUsd.gt(0)
      ? usd.mul(amountIn).div(amountInUsd).toDecimalPlaces(0, D.ROUND_DOWN)
      : new D(0);
  const usd = (v: Decimal | null) => (v ? v.toDecimalPlaces(6, D.ROUND_HALF_UP) : null);

  const appFee = amountIn.mul(bps).toDecimalPlaces(0, D.ROUND_DOWN);
  const appFeeUsd = amountInUsd ? amountInUsd.mul(bps) : null;
  const lines: RevenueLine[] = [
    { source: 'app_fee', assetId: input.originAsset, amount: appFee, amountUsd: usd(appFeeUsd) },
  ];
  if (amountInUsd && input.amountOutUsd && appFeeUsd) {
    const spread = D.max(0, amountInUsd.minus(input.amountOutUsd).minus(appFeeUsd));
    lines.push({
      source: 'oneclick_fee',
      assetId: input.originAsset,
      amount: usdToUnits(spread),
      amountUsd: usd(spread),
    });
  }
  const network = new D(gasEstimateUsd(input.chain));
  lines.push({
    source: 'network_fee',
    assetId: input.originAsset,
    amount: usdToUnits(network),
    amountUsd: usd(network),
  });
  const gas = new D(
    gasReimbursementUsd(input.gasPayer, gasEstimateUsd(input.chain), input.gasMaxUsd),
  );
  lines.push({
    source: 'gas_reimbursement',
    assetId: input.originAsset,
    amount: usdToUnits(gas),
    amountUsd: usd(gas),
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
    gasPayer: gasPayerFromDb(p.session.gasSponsor),
    gasMaxUsd: p.session.gasMaxUsd,
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
