// Prisma model names grouped by how the scoped data-access clients treat them.

/** Merchant-owned models with a `livemode` column: scoped by `merchantId` and `livemode`. */
export const PER_MODE_MODELS = [
  'ApiKey',
  'SettlementConfig',
  'PayoutAllowlistEntry',
  'WebhookEndpoint',
  'GasPolicy',
  'GasBudgetMonth',
  'PaymentLink',
  'Session',
  'Quote',
  'Payment',
  'Refund',
  'WebhookDelivery',
  'HookCall',
  'GasSponsorship',
  'ScreeningResult',
  'RevenueEntry',
  'SettlementClaim',
  'AccountKey',
  'MerchantAccount',
  'AccountProposal',
  'AccountApproval',
  'RecoveryRequest',
  'AccountLimit',
] as const;

/** Merchant-owned models shared by both modes (no `livemode` column): scoped by `merchantId`. */
export const SHARED_MODELS = [
  'MerchantUser',
  'MerchantInvite',
  'FeePlan',
  'CheckoutTheme',
  'ThemeAsset',
  'Connection',
] as const;

/**
 * Per-mode models that the scoped and read-only clients may READ (scoped by `merchantId` and
 * `livemode`) but never write. Events are appended only by `recordEvent` (inside
 * `tenantTransaction`), so the append-only log cannot be forged or edited through a scoped client.
 * System events (`merchant_id` NULL) are invisible to every scoped client.
 */
export const READ_ONLY_PER_MODE_MODELS = ['Event'] as const;

/**
 * Infrastructure models. Never reachable through the scoped or read-only clients; only
 * infra code (event dispatch, idempotency, secrets) touches them, via the unscoped client.
 */
export const INFRA_MODELS = [
  'EventOutbox',
  'Secret',
  'IdempotencyKey',
  'EventNotice',
  // Connect authorization codes: only the connect flow touches them, by code hash.
  'ConnectAuthCode',
] as const;

/**
 * People and their credentials: global, not owned by any merchant (a person can belong to several
 * merchants). Never reachable through the scoped or read-only clients; only the dashboard auth
 * code touches them, via the unscoped client.
 */
export const IDENTITY_MODELS = [
  'User',
  'WebauthnCredential',
  'DashboardSession',
  'EmailToken',
  'WebauthnChallenge',
] as const;

export type PerModeModel = (typeof PER_MODE_MODELS)[number];
export type ReadOnlyPerModeModel = (typeof READ_ONLY_PER_MODE_MODELS)[number];
export type SharedModel = (typeof SHARED_MODELS)[number];
export type InfraModel = (typeof INFRA_MODELS)[number];
export type IdentityModel = (typeof IDENTITY_MODELS)[number];
