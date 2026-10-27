// Test-only DB helpers. Never import from application code.
import { createHash, randomBytes } from 'node:crypto';
import type { ApiKey, Merchant, Prisma, User, WebauthnCredential } from '@prisma/client';
import { ALL_SCOPES, type Scope } from '@tendr/contracts';
import { ulid } from 'ulid';
import { PER_MODE_MODELS, READ_ONLY_PER_MODE_MODELS, SHARED_MODELS } from '../db/models.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { putSecret } from '../secrets/secrets.js';

const unique = (label: string): string => `${label}-${ulid().toLowerCase()}`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Empties every table. `events` is append-only, so it is cleared with
 * `session_replication_role = replica` (which skips user triggers) — test-only.
 * Its children (`event_outbox`, `webhook_deliveries`) are deleted first because
 * replica mode also skips FK checks. The final `TRUNCATE ... CASCADE` reaches `events`
 * through its `merchants` FK; the `events_no_truncate` trigger does not fire in replica
 * mode, and `events` is already empty by then.
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
    data: { id: newId('mer'), name: 'Test Merchant', slug: unique('merchant'), ...overrides },
  });
}

/** A person (`users` row) with a unique lower-case email. */
export async function createUser(
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
): Promise<User> {
  return prisma.user.create({
    data: { id: newId('per'), email: `${unique('person')}@example.com`, ...overrides },
  });
}

/** A passkey for `userId`; the public key is a `SignerKey` JSON value as the contract uses. */
export async function createCredential(
  userId: string,
  overrides: Partial<Prisma.WebauthnCredentialUncheckedCreateInput> = {},
): Promise<WebauthnCredential> {
  return prisma.webauthnCredential.create({
    data: {
      id: newId('cred'),
      userId,
      credentialId: unique('cred'),
      publicKey: {
        p256: Buffer.concat([Buffer.from([2]), randomBytes(32)]).toString('base64'),
      },
      transports: ['internal'],
      ...overrides,
    },
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
    signingSecret?: string;
  },
): Promise<{ raw: string; record: ApiKey }> {
  const kind = opts.kind ?? 'secret';
  const prefix = KEY_PREFIXES[kind][`${opts.livemode}`];
  const raw = `${prefix}${randomBytes(24).toString('hex')}`;
  const signingSecretRef = opts.signingSecret
    ? await putSecret(opts.signingSecret, 'api_key_signing')
    : undefined;
  const record = await prisma.apiKey.create({
    data: {
      id: newId('key'),
      merchantId,
      livemode: opts.livemode,
      name: `${kind} key`,
      kind,
      keyPrefix: raw.slice(0, prefix.length + 4),
      keyHash: sha256(raw),
      scopes: [...(opts.scopes ?? ALL_SCOPES)],
      signingRequired: opts.signingRequired ?? false,
      signingSecretRef,
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
    id: newId('ses'),
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

/** Every model that carries a `merchant_id`: the scoped models plus the merchant-owned infra one. */
export const MERCHANT_OWNED_MODELS = [
  ...PER_MODE_MODELS,
  ...READ_ONLY_PER_MODE_MODELS,
  ...SHARED_MODELS,
  'IdempotencyKey',
] as const;
export type MerchantOwnedModel = (typeof MERCHANT_OWNED_MODELS)[number];

async function createSecret(): Promise<{ id: string }> {
  return prisma.secret.create({
    data: { id: newId('sec'), purpose: 'test', ciphertext: '{}', kek: 'local' },
  });
}

const builders: Record<MerchantOwnedModel, Builder> = {
  MerchantUser: async (merchantId, _l, o) =>
    prisma.merchantUser.create({
      data: {
        id: newId('usr'),
        merchantId,
        userId: (await createUser()).id,
        role: 'owner',
        ...o,
      },
    }),
  MerchantInvite: (merchantId, _l, o) =>
    prisma.merchantInvite.create({
      data: {
        id: newId('inv'),
        merchantId,
        email: `${unique('invitee')}@example.com`,
        role: 'finance',
        tokenHash: sha256(unique('invite')),
        expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
        ...o,
      },
    }),
  ApiKey: async (merchantId, livemode) => (await createApiKey(merchantId, { livemode })).record,
  AccountKey: (merchantId, livemode, o) =>
    prisma.accountKey.create({
      data: {
        id: newId('akey'),
        merchantId,
        livemode,
        nearAccountId: 'merchant.testnet',
        publicKey: `ed25519:${unique('pk')}`,
        kind: 'passkey',
        ...o,
      },
    }),
  SettlementConfig: (merchantId, livemode, o) =>
    prisma.settlementConfig.create({
      data: {
        id: newId('stc'),
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
        id: newId('pal'),
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
        id: newId('whe'),
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
        id: newId('gpol'),
        merchantId,
        livemode,
        perPaymentCapUsd: '1',
        monthlyBudgetUsd: '100',
        minOrderUsd: '5',
        ...o,
      },
    }),
  GasBudgetMonth: (merchantId, livemode, o) =>
    prisma.gasBudgetMonth.create({
      data: { id: newId('gbm'), merchantId, livemode, month: '2026-10', ...o },
    }),
  PaymentLink: (merchantId, livemode, o) =>
    prisma.paymentLink.create({
      data: {
        id: newId('plink'),
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
        id: newId('quo'),
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
        id: newId('pay'),
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
        id: newId('ref'),
        merchantId,
        livemode,
        paymentId: (await builders.Payment(merchantId, livemode, {})).id,
        reason: 'expired',
        assetId: 'nep141:eth.test',
        amount: '1000000',
        ...o,
      },
    }),
  WebhookDelivery: async (merchantId, livemode, o) =>
    prisma.webhookDelivery.create({
      data: {
        id: newId('whd'),
        merchantId,
        livemode,
        endpointId: (await builders.WebhookEndpoint(merchantId, livemode, {})).id,
        eventId: (await builders.Event(merchantId, livemode, {})).id,
        eventType: 'session.created',
        idempotencyKey: unique('delivery'),
        ...o,
      },
    }),
  HookCall: async (merchantId, livemode, o) => {
    const payment = await builders.Payment(merchantId, livemode, {});
    return prisma.hookCall.create({
      data: {
        id: newId('hook'),
        merchantId,
        livemode,
        sessionId: payment.sessionId as string,
        paymentId: payment.id,
        chain: 'base',
        targetContract: '0x0000000000000000000000000000000000000001',
        hookData: { order: 'A-1' },
        ...o,
      },
    });
  },
  GasSponsorship: async (merchantId, livemode, o) =>
    prisma.gasSponsorship.create({
      data: {
        id: newId('gas'),
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
        id: newId('scr'),
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
        id: newId('evt'),
        merchantId,
        livemode,
        aggregateType: 'session',
        aggregateId: newId('ses'),
        type: 'session.created',
        payload: {},
        ...o,
      },
    }),
  FeePlan: (merchantId, _l, o) =>
    prisma.feePlan.create({
      data: {
        id: newId('fplan'),
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
        id: newId('rev'),
        merchantId,
        livemode,
        paymentId: (await builders.Payment(merchantId, livemode, {})).id,
        source: 'app_fee',
        assetId: 'nep141:usdc.test',
        amount: '5000',
        ...o,
      },
    }),
  SettlementClaim: async (merchantId, livemode, o) =>
    prisma.settlementClaim.create({
      data: {
        id: newId('scl'),
        merchantId,
        livemode,
        paymentId: (await builders.Payment(merchantId, livemode, {})).id,
        txHash: unique('tx'),
        receiptId: 'r0',
        eventKey: '0.0.0',
        amount: '5000',
        ...o,
      },
    }),
  CheckoutTheme: (merchantId, _l, o) =>
    prisma.checkoutTheme.create({
      data: {
        id: newId('thm'),
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
        id: newId('tasset'),
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
  Connection: async (merchantId, _l, o) =>
    prisma.connection.create({
      data: {
        id: newId('con'),
        merchantId,
        platform: 'woocommerce',
        siteUrl: 'https://shop.example.com',
        siteOrigin: 'https://shop.example.com',
        connectedByUserId: (await createUser()).id,
        ...o,
      },
    }),
  MerchantAccount: (merchantId, livemode, o) =>
    prisma.merchantAccount.create({
      data: {
        id: newId('macc'),
        merchantId,
        livemode,
        nearAccountId: `${unique('m')}.tendr.${livemode ? 'near' : 'testnet'}`,
        threshold: 1,
        ...o,
      },
    }),
  AccountProposal: async (merchantId, livemode, o) =>
    prisma.accountProposal.create({
      data: {
        id: newId('prop'),
        merchantId,
        livemode,
        accountId: (await accountFor(merchantId, livemode)).id,
        onchainId: randomBytes(32).toString('hex'),
        kind: 'set_threshold',
        action: { set_threshold: 2 },
        salt: randomBytes(32).toString('base64'),
        createdByUserId: (await createUser()).id,
        ...o,
      },
    }),
  AccountApproval: async (merchantId, livemode, o) => {
    const user = await createUser();
    return prisma.accountApproval.create({
      data: {
        id: newId('appr'),
        merchantId,
        livemode,
        proposalId: (await builders.AccountProposal(merchantId, livemode, {})).id,
        userId: user.id,
        credentialId: (await createCredential(user.id)).id,
        signerEpoch: 0n,
        ...o,
      },
    });
  },
  RecoveryRequest: async (merchantId, livemode, o) =>
    prisma.recoveryRequest.create({
      data: {
        id: newId('rec'),
        merchantId,
        livemode,
        accountId: (await accountFor(merchantId, livemode)).id,
        executesAt: new Date(Date.now() + 72 * 3_600_000),
        newSignerIds: [newId('per')],
        ...o,
      },
    }),
  AccountLimit: async (merchantId, livemode, o) =>
    prisma.accountLimit.create({
      data: {
        id: newId('alim'),
        merchantId,
        livemode,
        accountId: (await accountFor(merchantId, livemode)).id,
        asset: unique('nep141:asset'),
        ...o,
      },
    }),
  IdempotencyKey: (merchantId, livemode, o) =>
    prisma.idempotencyKey.create({
      data: {
        id: newId('idem'),
        merchantId,
        livemode,
        principalRef: 'secret_key:key_test',
        key: unique('idem'),
        requestHash: sha256('{}'),
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
        ...o,
      },
    }),
};

/** The merchant's account in `livemode` (one per merchant and mode), created when missing. */
async function accountFor(merchantId: string, livemode: boolean): Promise<CreatedRow> {
  return (
    (await prisma.merchantAccount.findFirst({ where: { merchantId, livemode } })) ??
    builders.MerchantAccount(merchantId, livemode, {})
  );
}

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
