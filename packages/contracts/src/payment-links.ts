import { z } from 'zod';
import { FeePayerSchema, GasPayerSchema } from './checkout.js';
import { containsAddressLike, containsSendInstruction } from './theme-text.js';
import type { ShopperTheme } from './themes.js';

/** Smallest amount a link can take, in USD (the Intents routes' practical floor). */
export const LINK_MIN_USD = '1.00';
export const PAYER_NOTE_MAX = 280;
export const LINK_TITLE_MAX = 80;
export const LINK_DESCRIPTION_MAX = 500;

/** 3 to 60 chars, lower-case letters, digits and inner hyphens. */
export const LINK_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

/** Slugs a link may not take: they collide with routes under `/<merchant>/…` on the pay host. */
export const RESERVED_LINK_SLUGS: readonly string[] = [
  'refund-address',
  'qr',
  'opengraph-image',
  'twitter-image',
  'sessions',
  'session',
  'public',
  'test',
  'new',
  'edit',
  'api',
  'pay',
  'invoice',
  'success',
  'cancel',
  'null',
  'undefined',
  'preview',
  'v1',
  'downloads',
  'privacy',
  'terms',
  'demo',
  'dashboard',
  'connect',
  'login',
  'signup',
  'verify',
  'invite',
  'recover',
  'settings',
  'icons',
  'fonts',
  'motion-intro',
  'motion-2',
  'motion-conclusion',
];

export const PaymentLinkAvailabilitySchema = z.enum([
  'available',
  'inactive',
  'archived',
  'expired',
  'used_up',
  'merchant_not_ready',
]);
export type PaymentLinkAvailability = z.infer<typeof PaymentLinkAvailabilitySchema>;

const NO_PAYMENT_TEXT = "Payment link text can't contain wallet addresses or payment instructions";
const isPlainText = (s: string): boolean => !containsAddressLike(s) && !containsSendInstruction(s);

const AMOUNT_STR = z.string().regex(/^\d+(?:\.\d+)?$/, 'must be a decimal string like "25.10"');

/** Fungible Intents token ids supported by the merchant account's balance/withdrawal paths. */
export const SettlementAssetIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^nep141:[a-z0-9._-]+$/);

export interface LinkSettlementToken {
  asset: string;
  symbol: string;
  /** The asset's source chain; the balance remains in the merchant's Intents account. */
  chain: string;
  decimals: number;
}

export interface LinkSettlementOptions {
  livemode: boolean;
  tokens: LinkSettlementToken[];
  /** Every 1Click `blockchain` id in this mode's catalog, including chains with no NEP-141 token. */
  chains: string[];
  store_default: {
    asset: string;
    symbol: string | null;
    chain: string | null;
    payout_mode: 'intents' | 'wallet';
  } | null;
}

const CreateFields = z.strictObject({
  title: z.string().trim().min(1).max(LINK_TITLE_MAX).refine(isPlainText, NO_PAYMENT_TEXT),
  description: z
    .string()
    .trim()
    .max(LINK_DESCRIPTION_MAX)
    .refine(isPlainText, NO_PAYMENT_TEXT)
    .optional(),
  slug: z
    .string()
    .regex(
      LINK_SLUG_RE,
      '3-60 lower-case letters, digits or hyphens, not starting or ending with "-"',
    )
    .refine((s) => !RESERVED_LINK_SLUGS.includes(s), 'this slug is reserved')
    .optional(),
  amount_type: z.enum(['fixed', 'open']),
  amount: AMOUNT_STR.optional(),
  currency: z.string().min(1).max(200),
  min_amount: AMOUNT_STR.optional(),
  note: z.enum(['off', 'optional']).default('optional'),
  status: z.enum(['active', 'inactive']).optional(),
  expires_at: z.string().datetime().optional(),
  max_uses: z.number().int().min(1).optional(),
  fee_payer: FeePayerSchema.optional(),
  gas_payer: GasPayerSchema.optional(),
  gas_max_usd: AMOUNT_STR.optional(),
  theme_id: z.string().min(1).nullable().optional(),
  /** Null/omitted: inherit the store default. An override always credits its Tendr account. */
  settlement_asset: SettlementAssetIdSchema.nullable().optional(),
});

type Amounts = {
  amount_type?: 'fixed' | 'open';
  amount?: string;
  min_amount?: string | null;
};

function checkAmounts(v: Amounts, ctx: z.RefinementCtx): void {
  if (v.amount_type === 'fixed' && v.amount === undefined) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'required for fixed links' });
  }
  if (v.amount_type === 'open' && v.amount !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'not allowed for open links' });
  }
  if (v.amount_type === 'fixed' && v.min_amount != null) {
    ctx.addIssue({ code: 'custom', path: ['min_amount'], message: 'only allowed for open links' });
  }
}

export const PaymentLinkCreateSchema = CreateFields.superRefine(checkAmounts);
export type PaymentLinkCreate = z.infer<typeof PaymentLinkCreateSchema>;

/** In an update, `null` clears the field and an omitted key leaves it unchanged. */
export const PaymentLinkUpdateSchema = CreateFields.omit({ slug: true })
  .partial()
  .extend({
    description: CreateFields.shape.description.nullable(),
    min_amount: CreateFields.shape.min_amount.nullable(),
    expires_at: CreateFields.shape.expires_at.nullable(),
    max_uses: CreateFields.shape.max_uses.nullable(),
    fee_payer: CreateFields.shape.fee_payer.nullable(),
    gas_payer: CreateFields.shape.gas_payer.nullable(),
    gas_max_usd: CreateFields.shape.gas_max_usd.nullable(),
    archived: z.boolean().optional(),
  })
  .superRefine(checkAmounts);
export type PaymentLinkUpdate = z.infer<typeof PaymentLinkUpdateSchema>;

export const PublicLinkSessionInputSchema = z.object({
  amount: z.string().optional(),
  note: z.string().max(2000).optional(),
});
export type PublicLinkSessionInput = z.infer<typeof PublicLinkSessionInputSchema>;

/**
 * "Pay" answered: the hosted checkout (client secret in its fragment) and the session's expiry, so
 * the page can offer "Continue your payment" to a payer who comes back before it passes.
 */
export type PublicLinkSessionCreated = { url: string; expires_at: string };

/** What the public link page may see: no ids, use counts or limits. */
export type PublicPaymentLinkView = {
  /** The account's legal name (the payee); the shown store name and logo live in `theme`. */
  merchant: { name: string };
  /** The resolved theme (link's, else the store default, else Tendr's), ready to render. */
  theme: ShopperTheme;
  title: string;
  description: string | null;
  amount_type: 'fixed' | 'open';
  amount: string | null;
  currency: string;
  /**
   * The currency's decimal places (Tendr's ISO 4217 table; USD 2). The page formats and checks
   * amounts with this, never the browser's own currency data, which disagrees for some codes.
   */
  minor_units: number;
  /** Effective minimum (open links only), rounded up to the currency's minor units. */
  min_amount: string | null;
  /** 1 USD = X currency; null for USD or when FX is unavailable. */
  usd_rate: string | null;
  note: 'off' | 'optional';
  fee_payer: 'merchant' | 'shopper';
  availability: PaymentLinkAvailability;
  livemode: boolean;
};

/**
 * Direction marks and bidi embeddings/overrides/isolates (LRM, RLM, LRE…RLO, LRI…PDI, ALM): they
 * could make a note read differently in the dashboard or an email than what was typed. The zero
 * width joiner (U+200D) stays, because emoji sequences need it.
 */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜]/gu;

/**
 * Payer note as stored: control characters and bidi controls removed, whitespace collapsed,
 * trimmed, cut to `PAYER_NOTE_MAX` code points (never inside a surrogate pair). HTML is escaped at
 * render.
 */
export function cleanPayerNote(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const s = raw
    .replace(BIDI_CONTROLS, '')
    .replace(/\p{Cc}/gu, (c) => (/[\t\n\r]/.test(c) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  const cut = Array.from(s).slice(0, PAYER_NOTE_MAX).join('').trim();
  return cut.length > 0 ? cut : null;
}
