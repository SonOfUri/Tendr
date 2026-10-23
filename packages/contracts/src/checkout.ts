import { z } from 'zod';
import { CheckoutModes, CheckoutSessionStatuses, PaymentStatuses } from './enums.js';
import { CurrencyCodeSchema, MoneyAmountSchema } from './money.js';

const HttpUrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'URL must be http(s)');

export const CreateCheckoutSessionRequestSchema = z.object({
  merchantReference: z.string().min(1).max(128),
  amount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  description: z.string().max(500).optional(),
  successUrl: HttpUrlSchema,
  cancelUrl: HttpUrlSchema,
  mode: z.enum(CheckoutModes).default('sandbox'),
  metadata: z.record(z.string()).default({}),
});

export type CreateCheckoutSessionRequest = z.infer<typeof CreateCheckoutSessionRequestSchema>;

export const CheckoutSessionSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  merchantReference: z.string(),
  amount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  description: z.string().nullable(),
  successUrl: z.string(),
  cancelUrl: z.string(),
  mode: z.enum(CheckoutModes),
  status: z.enum(CheckoutSessionStatuses),
  metadata: z.record(z.string()),
  paymentId: z.string().nullable(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CheckoutSession = z.infer<typeof CheckoutSessionSchema>;

export const CreateQuoteRequestSchema = z.object({
  sourceAsset: z.string().min(1).max(64).optional(),
  sourceNetwork: z.string().min(1).max(64).optional(),
});

export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequestSchema>;

export const QuoteSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sourceAsset: z.string(),
  sourceNetwork: z.string(),
  destinationAsset: z.string(),
  destinationNetwork: z.string(),
  sourceAmount: MoneyAmountSchema,
  destinationAmount: MoneyAmountSchema,
  expiresAt: z.string().datetime(),
  provider: z.string(),
  createdAt: z.string().datetime(),
});

export type Quote = z.infer<typeof QuoteSchema>;

export const ConfirmCheckoutRequestSchema = z.object({
  quoteId: z.string().min(1),
});

export const PaymentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  merchantId: z.string(),
  status: z.enum(PaymentStatuses),
  amount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  mode: z.enum(CheckoutModes),
  provider: z.string(),
  providerReference: z.string().nullable(),
  failureReason: z.string().nullable(),
  settledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Payment = z.infer<typeof PaymentSchema>;

export const MerchantSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string().datetime(),
});

export const WebhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
});

export const CreateWebhookEndpointRequestSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), {
      message: 'Production webhooks require HTTPS; localhost http allowed in development',
    }),
  description: z.string().max(200).optional(),
});

export type CreateWebhookEndpointRequest = z.infer<typeof CreateWebhookEndpointRequestSchema>;
