import { z } from 'zod';
import { FeePayerSchema, GasPayerSchema } from './checkout.js';

/** Smallest amount a link can take, in USD (the Intents routes' practical floor). */
export const LINK_MIN_USD = '1.00';
export const PAYER_NOTE_MAX = 280;
export const LINK_TITLE_MAX = 80;
export const LINK_DESCRIPTION_MAX = 500;

/** 3 to 60 chars, lower-case letters, digits and inner hyphens. */
export const LINK_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

/** Slugs a link may not take: they collide with routes under `/pay/<merchant>/…`. */
export const RESERVED_LINK_SLUGS: readonly string[] = [
  'qr',
  'opengraph-image',
  'twitter-image',
  'sessions',
  'session',
  'public',
  'new',
  'api',
  'pay',
  'success',
  'cancel',
  'null',
  'undefined',
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

const AMOUNT_STR = z.string().regex(/^\d+(?:\.\d+)?$/, 'must be a decimal string like "25.10"');

const CreateFields = z.object({
  title: z.string().trim().min(1).max(LINK_TITLE_MAX),
  description: z.string().trim().max(LINK_DESCRIPTION_MAX).optional(),
  slug: z
    .string()
    .regex(LINK_SLUG_RE, '3-60 lower-case letters, digits or hyphens, not starting or ending with "-"')
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
});

type Amounts = { amount_type?: 'fixed' | 'open'; amount?: string; min_amount?: string };

function checkAmounts(v: Amounts, ctx: z.RefinementCtx): void {
  if (v.amount_type === 'fixed' && v.amount === undefined) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'required for fixed links' });
  }
  if (v.amount_type === 'open' && v.amount !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'not allowed for open links' });
  }
  if (v.amount_type === 'fixed' && v.min_amount !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['min_amount'], message: 'only allowed for open links' });
  }
}

export const PaymentLinkCreateSchema = CreateFields.superRefine(checkAmounts);
export type PaymentLinkCreate = z.infer<typeof PaymentLinkCreateSchema>;

export const PaymentLinkUpdateSchema = CreateFields.omit({ slug: true })
  .partial()
  .extend({ archived: z.boolean().optional() })
  .superRefine(checkAmounts);
export type PaymentLinkUpdate = z.infer<typeof PaymentLinkUpdateSchema>;

export const PublicLinkSessionInputSchema = z.object({
  amount: z.string().optional(),
  note: z.string().max(2000).optional(),
});
export type PublicLinkSessionInput = z.infer<typeof PublicLinkSessionInputSchema>;

/** What the public link page may see: no ids, use counts or limits. */
export type PublicPaymentLinkView = {
  merchant: { name: string; logo_url: string | null };
  title: string;
  description: string | null;
  amount_type: 'fixed' | 'open';
  amount: string | null;
  currency: string;
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
 * Payer note as stored: control characters removed, whitespace collapsed, trimmed, cut to
 * `PAYER_NOTE_MAX` code points (never inside a surrogate pair). HTML is escaped at render.
 */
export function cleanPayerNote(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const s = raw
    .replace(/\p{Cc}/gu, (c) => (/[\t\n\r]/.test(c) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  const cut = Array.from(s).slice(0, PAYER_NOTE_MAX).join('').trim();
  return cut.length > 0 ? cut : null;
}
