import { z } from 'zod';

export const AssistantInputSchema = z
  .object({ question: z.string().trim().min(1).max(1000) })
  .strict();
export const RecommendationInputSchema = z
  .object({
    assets: z
      .array(
        z
          .object({
            asset_id: z.string().min(1).max(256),
            /** Optional wallet-reported token balance in base units; not an independently verified balance. */
            balance: z
              .string()
              .regex(/^\d{1,78}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .refine(
        (assets) => new Set(assets.map((a) => a.asset_id)).size === assets.length,
        'Each asset must be unique',
      ),
  })
  .strict();

export type AssistantInput = z.infer<typeof AssistantInputSchema>;
export type RecommendationInput = z.infer<typeof RecommendationInputSchema>;

export interface AssistantAnswer {
  answer: string;
  facts: { id: string; text: string }[];
  generated_at: string;
  source: 'model_selected_facts';
  read_only: true;
}

export interface RouteRecommendation {
  asset_id: string;
  symbol: string;
  chain: string;
  amount_in: string;
  amount_in_usd: string;
  amount_out: string;
  estimated_seconds: number | null;
  balance_sufficient: boolean | null;
}

export interface RouteRecommendations {
  routes: RouteRecommendation[];
  unavailable: {
    asset_id: string;
    reason: 'unsupported' | 'quote_unavailable' | 'insufficient_balance';
  }[];
  recommended: string | null;
  cheapest: string | null;
  fastest: string | null;
  generated_at: string;
  expires_at: string;
  source: 'live_quotes' | 'testnet_quotes' | 'simulated_quotes';
  ranking_basis: 'quoted_input_usd_excluding_wallet_gas';
  wallet_gas_included: false;
  requires_fresh_quote: true;
}

export const InsightQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
  .strict();
export const InsightInputSchema = z
  .object({
    days: z.number().int().min(1).max(90).default(30),
    question: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .default('Summarize checkout conversion and drop-offs.'),
  })
  .strict();
export const AiThemeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(2000),
  })
  .strict();
export type InsightInput = z.infer<typeof InsightInputSchema>;
export type AiThemeInput = z.infer<typeof AiThemeInputSchema>;

export interface CheckoutMetrics {
  sessions_created: number;
  sessions_quoted: number;
  sessions_with_deposit: number;
  sessions_settled: number;
  expired_without_deposit: number;
  sessions_with_refunds: number;
  conversion_percent: string | null;
  /** Order totals associated with settled sessions, not net receipts; currencies are never mixed. */
  settled_order_totals: { currency: string; amount: string }[];
}
export interface MerchantInsights {
  livemode: boolean;
  window: { from: string; to: string; days: number };
  current: CheckoutMetrics;
  previous: CheckoutMetrics;
  conversion_change_percentage_points: string | null;
  facts: { id: string; text: string }[];
  generated_at: string;
  source: 'database_aggregates';
}
