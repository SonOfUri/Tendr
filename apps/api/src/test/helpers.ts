// Test-only DB helpers. Never import from application code.
import { createHash, randomBytes } from 'node:crypto';
import type { ApiKey, Merchant, Prisma } from '@prisma/client';
import { ALL_SCOPES, type Scope } from '@tendr/contracts';
import { ulid } from 'ulid';
import { prisma } from '../lib/prisma.js';

const id = (prefix: string): string => `${prefix}_${ulid()}`;
const unique = (label: string): string => `${label}-${ulid().toLowerCase()}`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Empties every table. `events` is append-only, so it is cleared with
 * `session_replication_role = replica` (which skips user triggers) — test-only.
 * Its children (`event_outbox`, `webhook_deliveries`) are deleted first because
 * replica mode also skips FK checks.
 */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'events')`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    prisma.$executeRawUnsafe(`DELETE FROM event_outbox`),
    prisma.$executeRawUnsafe(`DELETE FROM webhook_deliveries`),
    prisma.$executeRawUnsafe(`DELETE FROM events`),
    prisma.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`),
  ]);
}

export async function createMerchant(
  overrides: Partial<Prisma.MerchantUncheckedCreateInput> = {},
): Promise<Merchant> {
  return prisma.merchant.create({
    data: { id: id('mer'), name: 'Test Merchant', slug: unique('merchant'), ...overrides },
  });
}

const KEY_PREFIXES = {
  secret: { true: 'tdr_live_', false: 'tdr_test_' },
  publishable: { true: 'tdr_pk_live_', false: 'tdr_pk_test_' },
} as const;

export async function createApiKey(
  merchantId: string,
  opts: {
    livemode: boolean;
    kind?: 'secret' | 'publishable';
    scopes?: Scope[];
    signingRequired?: boolean;
  },
): Promise<{ raw: string; record: ApiKey }> {
  const kind = opts.kind ?? 'secret';
  const prefix = KEY_PREFIXES[kind][`${opts.livemode}`];
  const raw = `${prefix}${randomBytes(24).toString('hex')}`;
  const record = await prisma.apiKey.create({
    data: {
      id: id('key'),
      merchantId,
      livemode: opts.livemode,
      name: `${kind} key`,
      kind,
      keyPrefix: raw.slice(0, prefix.length + 4),
      keyHash: sha256(raw),
      scopes: [...(opts.scopes ?? ALL_SCOPES)],
      signingRequired: opts.signingRequired ?? false,
    },
  });
  return { raw, record };
}

type SessionInput = Prisma.SessionUncheckedCreateInput;

/** A valid `sessions` row; `merchantId` and `livemode` are required, everything else overridable. */
export function minimalSession(
  overrides: Partial<SessionInput> & Pick<SessionInput, 'merchantId' | 'livemode'>,
): SessionInput {
  return {
    id: id('ses'),
    amountMode: 'EXACT_OUT',
    amount: '49.00',
    amountCurrency: 'USD',
    destAsset: 'nep141:usdc.test',
    destChain: 'near',
    recipient: 'merchant.testnet',
    delivery: 'WEBHOOK',
    feeBps: 50,
    feePayer: 'merchant',
    gasSponsor: 'buyer',
    expiresAt: new Date(Date.now() + 30 * 60_000),
    clientSecretHash: sha256(randomBytes(16).toString('hex')),
    ...overrides,
  };
}

/** A row as returned by Prisma; every merchant-owned row has an id and merchant id. */
export type CreatedRow = { id: string; merchantId: string | null } & Record<string, unknown>;
type Overrides = Record<string, unknown>;
type Builder = (merchantId: string, livemode: boolean, o: Overrides) => Promise<CreatedRow>;

/** Every model that carries a `merchant_id`. */
export const MERCHANT_OWNED_MODELS = [
  'MerchantUser',
  'ApiKey',
  'AccountKey',
  'SettlementConfig',
  'PayoutAllowlistEntry',
  'WebhookEndpoint',
  'GasPolicy',
  'PaymentLink',
  'Session',
  'Quote',
  'Payment',
  'Refund',
  'WebhookDelivery',
  'HookCall',
  'GasSponsorship',
  'ScreeningResult',
  'Event',
  'FeePlan',
  'RevenueEntry',
  'CheckoutTheme',
  'ThemeAsset',
  'IdempotencyKey',
] as const;
export type MerchantOwnedModel = (typeof MERCHANT_OWNED_MODELS)[number];

async function createSecret(): Promise<{ id: string }> {
  return prisma.secret.create({
    data: { id: id('sec'), purpose: 'test', ciphertext: '{}', kek: 'local' },
  });
}

const builders: Record<MerchantOwnedModel, Builder> = {
  MerchantUser: (merchantId, _l, o) =>
    prisma.merchantUser.create({
      data: { id: id('usr'), merchantId, email: `${unique('user')}@example.com`, role: 'owner', ...o },
    }),
  ApiKey: async (merchantId, livemode) => (await createApiKey(merchantId, { livemode })).record,
  AccountKey: (merchantId, _l, o) =>
    prisma.accountKey.create({
      data: {
        id: id('ak'),
        merchantId,
        nearAccountId: 'merchant.testnet',
        publicKey: `ed25519:${unique('pk')}`,
        kind: 'passkey',
        ...o,
      },
    }),
  SettlementConfig: (merchantId, livemode, o) =>
    prisma.settlementConfig.create({
      data: {
        id: id('stc'),
        merchantId,
        livemode,
        destAssetId: 'nep141:usdc.test',
        destChain: 'near',
        payoutMode: 'wallet',
        payoutAddress: 'merchant.testnet',
        ...o,
      },
    }),
  PayoutAllowlistEntry: (merchantId, livemode, o) =>
    prisma.payoutAllowlistEntry.create({
      data: {
        id: id('pal'),
        merchantId,
        livemode,
        chain: 'near',
        address: unique('addr'),
        activeFrom: new Date(),
        ...o,
      },
    }),
  WebhookEndpoint: async (merchantId, livemode, o) =>
    prisma.webhookEndpoint.create({
      data: {
        id: id('whe'),
        merchantId,
        livemode,
        url: 'https://example.com/webhooks',
        secretRef: (await createSecret()).id,
        events: ['*'],
        ...o,
      },
    }),
  GasPolicy: (merchantId, livemode, o) =>
    prisma.gasPolicy.create({
      data: {
        id: id('gsp'),
        merchantId,
        livemode,
        perPaymentCapUsd: '1',
        monthlyBudgetUsd: '100',
        minOrderUsd: '5',
        ...o,
      },
    }),
  PaymentLink: (merchantId, livemode, o) =>
    prisma.paymentLink.create({
      data: {
        id: id('plink'),
        merchantId,
        livemode,
        slug: unique('link'),
        title: 'Test link',
        amount: '49.00',
        amountCurrency: 'USD',
        destAsset: 'nep141:usdc.test',
        destChain: 'near',
        ...o,
      },
    }),
  Session: (merchantId, livemode, o) =>
    prisma.session.create({ data: minimalSession({ merchantId, livemode, ...o }) }),
  Quote: async (merchantId, livemode, o) =>
    prisma.quote.create({
      data: {
        id: id('quo'),
        merchantId,
        livemode,
        sessionId: (await builders.Session(merchantId, livemode, {})).id,
        originAssetId: 'nep141:eth.test',
        depositAddress: unique('deposit'),
        amountIn: '1000000',
        amountOut: '1000000',
        refundTo: 'buyer.testnet',
        deadline: new Date(Date.now() + 30 * 60_000),
        ...o,
      },
    }),
  Payment: async (merchantId, livemode, o) => {
    const quote = await builders.Quote(merchantId, livemode, {});
    return prisma.payment.create({
      data: {
        id: id('pay'),
        merchantId,
        livemode,
        sessionId: quote.sessionId as string,
        quoteId: quote.id,
        amountReceived: '1000000',
        ...o,
      },
    });
  },
  Refund: async (merchantId, livemode, o) =>
    prisma.refund.create({
      data: {
        id: id('ref'),
        merchantId,
        livemode,
        paymentId: (await builders.Payment(merchantId, livemode, {})).id,
        reason: 'expired',
        ...o,
      },
    }),
  WebhookDelivery: async (merchantId, livemode, o) =>
    prisma.webhookDelivery.create({
      data: {
        id: id('whd'),
        merchantId,
        livemode,
        endpointId: (await builders.WebhookEndpoint(merchantId, livemode, {})).id,
        eventId: (await builders.Event(merchantId, livemode, {})).id,
        eventType: 'session.created',
        idempotencyKey: unique('delivery'),
        ...o,
      },
    }),
  HookCall: async (merchantId, livemode, o) =>
    prisma.hookCall.create({
      data: {
        id: id('hkc'),
        merchantId,
        livemode,
        sessionId: (await builders.Session(merchantId, livemode, {})).id,
        chain: 'base',
        targetContract: '0x0000000000000000000000000000000000000001',
        ...o,
      },
    }),
  GasSponsorship: async (merchantId, livemode, o) =>
    prisma.gasSponsorship.create({
      data: {
        id: id('gas'),
        merchantId,
        livemode,
        sessionId: (await builders.Session(merchantId, livemode, {})).id,
        chain: 'base',
        method: 'paymaster_verifying',
        provider: 'pimlico',
        sponsor: 'merchant',
        ...o,
      },
    }),
  ScreeningResult: async (merchantId, livemode, o) =>
    prisma.screeningResult.create({
      data: {
        id: id('scr'),
        merchantId,
        livemode,
        sessionId: (await builders.Session(merchantId, livemode, {})).id,
        address: unique('addr'),
        chain: 'near',
        provider: 'test',
        riskScore: '1.50',
        decision: 'allow',
        ...o,
      },
    }),
  Event: (merchantId, livemode, o) =>
    prisma.event.create({
      data: {
        id: id('evt'),
        merchantId,
        livemode,
        aggregateType: 'session',
        aggregateId: id('ses'),
        type: 'session.created',
        payload: {},
        ...o,
      },
    }),
  FeePlan: (merchantId, _l, o) =>
    prisma.feePlan.create({
      data: {
        id: id('fpl'),
        merchantId,
        feeBps: 50,
        defaultFeePayer: 'merchant',
        volumeTiers: [],
        effectiveFrom: new Date(),
        ...o,
      },
    }),
  RevenueEntry: async (merchantId, livemode, o) =>
    prisma.revenueEntry.create({
      data: {
        id: id('rev'),
        merchantId,
        livemode,
        paymentId: (await builders.Payment(merchantId, livemode, {})).id,
        source: 'app_fee',
        assetId: 'nep141:usdc.test',
        amount: '5000',
        ...o,
      },
    }),
  CheckoutTheme: (merchantId, _l, o) =>
    prisma.checkoutTheme.create({
      data: {
        id: id('thm'),
        merchantId,
        name: 'Default',
        displayName: 'Test Merchant',
        accent: '#000000',
        background: '#ffffff',
        text: '#111111',
        font: 'Inter',
        cornerRadius: 8,
        layout: 'modal',
        blocks: [],
        schemaVersion: 1,
        tokenPreferences: {},
        ...o,
      },
    }),
  ThemeAsset: async (merchantId, livemode, o) =>
    prisma.themeAsset.create({
      data: {
        id: id('tas'),
        merchantId,
        themeId: (await builders.CheckoutTheme(merchantId, livemode, {})).id,
        kind: 'logo',
        url: 'https://example.com/logo.png',
        mime: 'image/png',
        sizeBytes: 1024,
        checksum: sha256('logo'),
        ...o,
      },
    }),
  IdempotencyKey: (merchantId, livemode, o) =>
    prisma.idempotencyKey.create({
      data: {
        id: id('idk'),
        merchantId,
        livemode,
        key: unique('idem'),
        requestHash: sha256('{}'),
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
        ...o,
      },
    }),
};

/** Merchant-owned models shared across modes (no `livemode` column). */
export const SHARED_MODELS: readonly MerchantOwnedModel[] = [
  'MerchantUser',
  'AccountKey',
  'FeePlan',
  'CheckoutTheme',
  'ThemeAsset',
];

/** Merchant-owned models with a `livemode` column. */
export const PER_MODE_MODELS: readonly MerchantOwnedModel[] = MERCHANT_OWNED_MODELS.filter(
  (m) => !SHARED_MODELS.includes(m),
);

/**
 * Creates a minimal valid row of `model` owned by `merchantId`, creating any required
 * parent rows with the same merchant and mode. `livemode` is ignored by shared models.
 */
export async function createRow(
  model: string,
  merchantId: string,
  livemode: boolean,
  overrides: Overrides = {},
): Promise<CreatedRow> {
  if (!Object.hasOwn(builders, model)) {
    throw new Error(`createRow: unknown merchant-owned model "${model}"`);
  }
  return builders[model as MerchantOwnedModel](merchantId, livemode, overrides);
}
