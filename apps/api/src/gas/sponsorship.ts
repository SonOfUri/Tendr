// Who pays a payment's network fee (project 5a, spec §2.2, §8.1).
//
// The resolved payer follows the existing order (session override → payment link → merchant
// default, `resolvePayers`). The merchant sponsors only when its gas policy for the mode is enabled
// and the payment passes every check below, in order; the first failing check is the reason the
// shopper pays. The decision reads state but changes none: the budget check does not reserve
// (`reserveBudget` does, under a lock, when the shopper commits to sign), so a payment that passes
// here can still be refused by the reservation.
import { Prisma } from '@prisma/client';
import { GAS_EVM_CHAINS, type GasPayer, gasPayerFromDb } from '@tendr/contracts';
import { scopedDb } from '../db/scoped.js';
import { resolvePayers } from '../checkout/pricing.js';
import { prisma } from '../lib/prisma.js';
import { alertLossCapReached, lossCapReached } from './loss-cap.js';
import { currentMonth, getGasPolicy } from './policy.js';

const Dec = Prisma.Decimal;

export type SponsorReason =
  | 'policy_disabled'
  | 'chain'
  | 'token'
  | 'min_order'
  | 'not_first_time'
  | 'per_payment_cap'
  | 'budget'
  | 'loss_cap'
  | 'shopper_choice';

export interface SponsorDecision {
  paidBy: GasPayer;
  /** Why the shopper pays; null when the merchant sponsors. */
  reason: SponsorReason | null;
}

export interface DecideSponsorInput {
  merchantId: string;
  livemode: boolean;
  sessionId: string;
  /** The shopper's origin chain (1Click blockchain id). */
  chain: string;
  /** The origin asset (1Click asset id). */
  assetId: string;
  /** The order's value in USD, a decimal string. */
  orderUsd: string;
  /** The connected wallet address the shopper pays from. */
  shopperAddress: string;
  /** The quoted network fee in USD, a decimal string. */
  feeUsd: string;
  /** The session's own `gas_payer`, if it set one. */
  sessionOverride: GasPayer | null;
  /** The payment link's gas setting, if the session came from a link that set one. */
  linkSetting: GasPayer | null;
  /** The session's (or link's) `gas_max_usd`, if any. */
  gasMaxUsd: string | null;
  /** Defaults to now; picks the budget month and the loss-cap day. */
  now?: Date;
}

const EVM = new Set<string>(GAS_EVM_CHAINS);

/**
 * Whether the merchant has an earlier payment (any status) in this mode from `address`, as the
 * payment's sender or one of its senders. EVM addresses compare case-insensitively; others exactly.
 */
async function returningShopper(
  merchantId: string,
  livemode: boolean,
  chain: string,
  address: string,
): Promise<boolean> {
  const rows = EVM.has(chain)
    ? await prisma.$queryRaw<unknown[]>`
        SELECT 1 FROM payments
        WHERE merchant_id = ${merchantId} AND livemode = ${livemode}
          AND (lower(sender_address) = lower(${address})
               OR lower(${address}) IN (SELECT lower(a) FROM unnest(sender_addresses) a))
        LIMIT 1`
    : await prisma.$queryRaw<unknown[]>`
        SELECT 1 FROM payments
        WHERE merchant_id = ${merchantId} AND livemode = ${livemode}
          AND (sender_address = ${address} OR ${address} = ANY(sender_addresses))
        LIMIT 1`;
  return rows.length > 0;
}

/**
 * Decides who pays the network fee. Checks, in order: resolved payer (`shopper_choice`), policy
 * enabled, chain, token (an empty list allows any), min order, first time (when `first_time_only`),
 * fee ≤ min(per-payment cap, `gasMaxUsd`), the Tendr-wide loss cap (alerting operators once a day),
 * and the month's remaining budget (read only, nothing is reserved).
 */
export async function decideSponsor(input: DecideSponsorInput): Promise<SponsorDecision> {
  const shopper = (reason: SponsorReason): SponsorDecision => ({ paidBy: 'shopper', reason });
  const now = input.now ?? new Date();
  const { merchantId, livemode } = input;

  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { defaultGasPayer: true },
  });
  const { gasPayer } = resolvePayers({
    sessionOverride: { gasPayer: input.sessionOverride },
    link: input.linkSetting ? { gasPayer: input.linkSetting } : null,
    merchant: {
      // Only the gas payer is resolved here; the fee payer is not used.
      defaultFeePayer: 'merchant',
      defaultGasPayer: gasPayerFromDb(merchant.defaultGasPayer),
    },
  });
  if (gasPayer === 'shopper') return shopper('shopper_choice');

  const policy = await getGasPolicy(merchantId, livemode);
  if (!policy.enabled) return shopper('policy_disabled');
  if (!(policy.chains as string[]).includes(input.chain)) return shopper('chain');
  if (policy.tokens.length > 0 && !policy.tokens.includes(input.assetId)) return shopper('token');
  const fee = new Dec(input.feeUsd);
  if (new Dec(input.orderUsd).lt(policy.min_order_usd)) return shopper('min_order');
  if (
    policy.first_time_only &&
    (await returningShopper(merchantId, livemode, input.chain, input.shopperAddress))
  ) {
    return shopper('not_first_time');
  }
  const cap =
    input.gasMaxUsd === null
      ? new Dec(policy.per_payment_cap_usd)
      : Dec.min(policy.per_payment_cap_usd, input.gasMaxUsd);
  if (fee.gt(cap)) return shopper('per_payment_cap');
  if (await lossCapReached(livemode, now)) {
    await alertLossCapReached(livemode, now);
    return shopper('loss_cap');
  }
  const month = await scopedDb({ merchantId, livemode }).gasBudgetMonth.findFirst({
    where: { month: currentMonth(now) },
    select: { reservedUsd: true, spentUsd: true },
  });
  const used = month ? month.reservedUsd.plus(month.spentUsd) : new Dec(0);
  if (used.plus(fee).gt(policy.monthly_budget_usd)) return shopper('budget');
  return { paidBy: 'merchant', reason: null };
}
