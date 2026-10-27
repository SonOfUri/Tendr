// Gasless payments (project 5a): the merchant's gas policy, its monthly usage and the network-fee
// view on sessions and payments. Every USD amount crosses the API as a decimal string (never a
// float), at most 6 decimals as stored (`numeric(18, 6)`).
import { z } from 'zod';

/**
 * The 1Click blockchain ids gasless payments cover (spec §2.3): the EVM chains, Solana, NEAR and
 * Tron. Same ids as the pay page's wallet code (`apps/web/src/lib/wallets`).
 */
export const GAS_EVM_CHAINS = [
  'eth',
  'base',
  'arb',
  'op',
  'pol',
  'bsc',
  'avax',
  'gnosis',
  'bera',
] as const;
export const GAS_CHAINS = [...GAS_EVM_CHAINS, 'sol', 'near', 'tron'] as const;
export type GasChain = (typeof GAS_CHAINS)[number];
export const GasChainSchema = z.enum(GAS_CHAINS);

/** How a shopper-paid network fee is paid: in the payment token (gasless) or the chain's coin. */
export const FeeModeValues = ['token', 'native'] as const;
export type FeeMode = (typeof FeeModeValues)[number];
export const FeeModeSchema = z.enum(FeeModeValues);

/** A sponsorship's hold on the monthly budget. Null on the record when nothing was reserved. */
export const GasReservationStateValues = ['reserved', 'settled', 'released'] as const;
export type GasReservationState = (typeof GasReservationStateValues)[number];
export const GasReservationStateSchema = z.enum(GasReservationStateValues);

const USD_RE = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
/** A non-negative USD amount as a decimal string ("1", "0.5", "49.123456"). */
export const UsdAmountSchema = z
  .string()
  .regex(USD_RE, 'must be a non-negative decimal string like "1.50" (at most 6 decimals)');

/** A USD decimal string as integer micro-dollars (exact; for comparisons). */
export function usdToMicros(usd: string): bigint {
  const [whole, frac = ''] = usd.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/**
 * A merchant's gas policy for one mode (spec §2.2). Merchant-sponsored gas applies only when the
 * policy is enabled and the payment passes it:
 * - `chains`: where sponsorship may happen (1Click blockchain ids); Ethereum mainnet is opt-in.
 * - `tokens`: the 1Click asset ids allowed; empty → any token.
 * - `min_order_usd`: the order must be at least this.
 * - `per_payment_cap_usd`: the quoted fee must be at most this (never above the monthly budget).
 * - `monthly_budget_usd`: reserved + spent per calendar month (UTC) never exceeds this.
 * - `first_time_only`: only the first payment from a shopper address to this merchant.
 */
export const GasPolicySchema = z
  .object({
    enabled: z.boolean(),
    per_payment_cap_usd: UsdAmountSchema,
    monthly_budget_usd: UsdAmountSchema,
    min_order_usd: UsdAmountSchema,
    chains: z
      .array(GasChainSchema)
      .max(GAS_CHAINS.length * 2)
      .transform(unique),
    tokens: z.array(z.string().min(1).max(200)).max(200).transform(unique),
    first_time_only: z.boolean(),
  })
  .strict()
  .refine(
    // Zod still runs a refinement after a field's regex failed: compare well-formed amounts only.
    (p) =>
      !USD_RE.test(p.per_payment_cap_usd) ||
      !USD_RE.test(p.monthly_budget_usd) ||
      usdToMicros(p.per_payment_cap_usd) <= usdToMicros(p.monthly_budget_usd),
    {
      message: 'per_payment_cap_usd cannot exceed monthly_budget_usd',
      path: ['per_payment_cap_usd'],
    },
  );
export type GasPolicy = z.infer<typeof GasPolicySchema>;

/**
 * `PUT /v1/gas-policy` body: any subset of the policy fields. Omitted fields keep their current
 * value (the defaults when the mode has no policy yet); the merged policy must pass
 * `GasPolicySchema`.
 */
export const GasPolicyInputSchema = z
  .object({
    enabled: z.boolean(),
    per_payment_cap_usd: UsdAmountSchema,
    monthly_budget_usd: UsdAmountSchema,
    min_order_usd: UsdAmountSchema,
    chains: z.array(GasChainSchema).max(GAS_CHAINS.length * 2),
    tokens: z.array(z.string().min(1).max(200)).max(200),
    first_time_only: z.boolean(),
  })
  .partial()
  .strict();
export type GasPolicyInput = z.infer<typeof GasPolicyInputSchema>;

/**
 * The policy a mode has before the merchant sets one, and the limits a new policy starts from:
 * $1 per payment, $50 per month, every supported chain except Ethereum mainnet (opt-in).
 */
export const DEFAULT_GAS_POLICY: Readonly<GasPolicy> = Object.freeze({
  enabled: false,
  per_payment_cap_usd: '1',
  monthly_budget_usd: '50',
  min_order_usd: '0',
  chains: GAS_CHAINS.filter((c) => c !== 'eth'),
  tokens: [],
  first_time_only: false,
});

/** `GET /v1/gas-policy`: the mode's policy; `updated_at` null while the defaults apply. */
export type GasPolicyView = GasPolicy & { livemode: boolean; updated_at: string | null };

/** A calendar month in UTC, `YYYY-MM`. */
export const GasMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');

export const GasUsageQuerySchema = z.object({ month: GasMonthSchema.optional() }).strict();

/**
 * `GET /v1/gas-policy/usage`: the month's budget use. `reserved_usd` is held by sponsorships not
 * yet settled, `spent_usd` is settled; `remaining_usd` = monthly budget − reserved − spent, never
 * below zero.
 */
export interface GasUsageView {
  month: string;
  reserved_usd: string;
  spent_usd: string;
  remaining_usd: string;
  count: number;
}

/**
 * The `network_fee` on session and payment views (spec §2.6). `paid_by: merchant` → sponsored;
 * `shopper` with `fee_mode: token` → the fee was paid in the payment token (`amount` base units
 * of `asset`); `native` → the shopper's wallet paid gas itself (Tendr collected nothing).
 * `usd` is a decimal string; `method` is the sponsorship method, when one was used.
 */
export interface NetworkFeeView {
  paid_by: 'merchant' | 'shopper';
  fee_mode: FeeMode | null;
  amount: string | null;
  asset: string | null;
  usd: string;
  method: string | null;
}
