import bs58 from 'bs58';
import { DEFAULT_GAS_MAX_USD, DEFAULT_SLIPPAGE_BPS } from '@tendr/contracts';
import { z } from 'zod';

const optionalString = z.string().min(1).optional();

/** An empty or whitespace-only env var counts as unset (so `.default()` applies, not `0`). */
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** A non-negative integer amount in yoctoNEAR, given as a decimal string. */
const yocto = z
  .string()
  .regex(/^\d{1,39}$/, 'must be a non-negative integer (yoctoNEAR)')
  .transform((s) => BigInt(s));

/** A NEAR account id (named or implicit), per the protocol's account-id rules. */
const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const nearAccountId = z.string().regex(NEAR_ACCOUNT_ID, 'must be a valid NEAR account id');

const codeHash = z
  .string()
  .refine((s) => {
    try {
      return bs58.decode(s).length === 32;
    } catch {
      return false;
    }
  }, 'must be a base58-encoded 32-byte hash')
  .optional();

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    /** Defaults to 0.0.0.0 in production (reachable by the platform), 127.0.0.1 otherwise. */
    API_HOST: optionalString,
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
    /** Defaults to 0.0.0.0 in production (reachable by the platform), 127.0.0.1 otherwise. */
    WORKER_HEALTH_HOST: optionalString,
    API_BASE_URL: z.string().url().default('http://localhost:4000'),
    WEB_URL: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z.string().min(1),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    REDIS_URL: z.string().url(),
    KEYVAULT_DRIVER: z.enum(['local', 'gcp']).default('local'),
    LOCAL_KEYVAULT_PATH: z.string().min(1).default('.keyvault/local.json'),
    // Cloud KMS (required only when KEYVAULT_DRIVER=gcp).
    GCP_PROJECT_ID: optionalString,
    GCP_KMS_LOCATION: optionalString,
    GCP_KMS_KEYRING: optionalString,
    GCP_KMS_KEK: z.string().min(1).default('tendr-kek'),
    /** Service-account JSON key, as a string. */
    GCP_CREDENTIALS_JSON: optionalString,
    // NEAR. Each mode has its own RPC, parent account, intents contract and global code hash.
    /** `fake` (in-memory, no network) by default outside production; refused in production. */
    NEAR_CLIENT_DRIVER: z.enum(['rpc', 'fake']).optional(),
    /**
     * `1`: the fake client runs an in-memory merchant-account contract (near/fake-contract.ts) so
     * the dashboard works end to end offline (local dev, e2e). Ignored unless the driver is fake.
     */
    NEAR_FAKE_SIMULATE: z
      .enum(['0', '1'])
      .optional()
      .transform((v) => v === '1'),
    NEAR_RPC_URL_LIVE: z.string().url().default('https://rpc.mainnet.near.org'),
    NEAR_RPC_URL_TEST: z.string().url().default('https://rpc.testnet.near.org'),
    NEAR_PARENT_ACCOUNT_LIVE: z.string().min(1).default('tendr.near'),
    NEAR_PARENT_ACCOUNT_TEST: z.string().min(1).default('tendr.testnet'),
    INTENTS_CONTRACT_LIVE: z.string().min(1).default('intents.near'),
    INTENTS_CONTRACT_TEST: z.string().min(1).default('intents-mock.tendr.testnet'),
    /** base58 sha256 of the published global merchant-account wasm (NEP-591 code hash). */
    MERCHANT_ACCOUNT_CODE_HASH_LIVE: codeHash,
    MERCHANT_ACCOUNT_CODE_HASH_TEST: codeHash,
    /** Max yoctoNEAR `funding-near` may spend on account creation per rolling 24 h, per mode. */
    FUNDING_DAILY_CAP_YOCTO: yocto.default('50000000000000000000000000'), // 50 NEAR
    /** Max yoctoNEAR one provisioned account may be seeded with. */
    FUNDING_PER_ACCOUNT_YOCTO: yocto.default('1000000000000000000000000'), // 1 NEAR
    /** yoctoNEAR each new merchant account is seeded with (storage); within the per-account cap. */
    MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO: yocto.default('500000000000000000000000'), // 0.5 NEAR
    /**
     * yoctoNEAR one storage top-up sends to a merchant account whose free balance runs low (the
     * watcher, R35); counts against FUNDING_DAILY_CAP_YOCTO, within the per-account cap.
     */
    MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO: yocto.default('500000000000000000000000'), // 0.5 NEAR
    // Dashboard auth. Production must set the RP ID and origins explicitly (no localhost defaults).
    WEBAUTHN_RP_ID: optionalString,
    WEBAUTHN_RP_NAME: z.string().min(1).default('Tendr'),
    /** Comma-separated origins allowed in WebAuthn client data (the dashboard's). */
    WEBAUTHN_ORIGINS: optionalString,
    /**
     * `log` (dev: logger + `apps/api/.mail/*.json`), `memory` (tests), `unconfigured` (sending
     * fails loudly; production's default until a real provider is wired). Defaults per NODE_ENV.
     */
    MAIL_DRIVER: z.enum(['log', 'memory', 'unconfigured']).optional(),
    // 1Click (checkout swaps). Live mode only; test mode uses the simulated provider.
    ONECLICK_BASE_URL: z.string().url().default('https://1click.chaindefuser.com'),
    /** 1Click JWT, sent as `X-API-Key`. Required in production. */
    ONECLICK_API_KEY: optionalString,
    /** Tendr's fee account per mode: the 1Click `appFees` recipient. */
    FEE_ACCOUNT_LIVE: nearAccountId.default('fees.tendr.near'),
    FEE_ACCOUNT_TEST: nearAccountId.default('fees.tendr.testnet'),
    /** 1Click slippage tolerance for checkout quotes, basis points (0–10000). */
    CHECKOUT_SLIPPAGE_BPS: z.preprocess(
      blankAsUnset,
      z.coerce.number().int().min(0).max(10_000).default(DEFAULT_SLIPPAGE_BPS),
    ),
    /**
     * Gas-reimbursement cap (USD) when a session/link sets no `gas_max_usd`. A decimal string,
     * never parsed as a float.
     */
    CHECKOUT_GAS_MAX_USD: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal')
        .default(String(DEFAULT_GAS_MAX_USD)),
    ),
    /**
     * Underpay top-up ("send the remaining X to the same address" while the quote is live).
     * Unset: on in test mode (the simulator accumulates deposits), off in live mode until the
     * mainnet check confirms 1Click accumulates a top-up. Set: applies to both modes.
     */
    CHECKOUT_TOPUP_ENABLED: z.preprocess(
      blankAsUnset,
      z
        .enum(['true', 'false', '1', '0'])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
    ),
    /**
     * Live-mode EVM RPC endpoints for reading a deposit's sender, as JSON
     * `{"<1Click blockchain id>": "<url>"}` (`eth`, `base`, `arb`, `pol`, `bsc`, `op`, `avax`, …;
     * `arbitrum`/`polygon`/`optimism`/`avalanche`/`ethereum` accepted). Merged over public defaults.
     */
    EVM_RPC_URLS: z.preprocess(
      blankAsUnset,
      z
        .string()
        .default('{}')
        .transform((text, ctx) => {
          let v: unknown;
          try {
            v = JSON.parse(text);
          } catch {
            v = null;
          }
          const ok =
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            Object.values(v).every((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
          if (!ok) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'must be a JSON object of chain to http(s) URL',
            });
            return z.NEVER;
          }
          return v as Record<string, string>;
        }),
    ),
    /**
     * Live-mode FX rate provider for non-USD order totals. `openexchangerates` (with FX_API_KEY)
     * is the live adapter; `fixed` means no live provider, so live non-USD sessions are
     * FX_RATE_UNAVAILABLE. Live mode never uses fixed rates; test mode always does. Default:
     * `openexchangerates` in production, `fixed` otherwise. Production refuses `fixed`.
     */
    FX_PROVIDER: z.preprocess(blankAsUnset, z.enum(['fixed', 'openexchangerates']).optional()),
    /**
     * The live FX provider's key (Open Exchange Rates app id). Required in production; elsewhere,
     * without it, live non-USD sessions are FX_RATE_UNAVAILABLE.
     */
    FX_API_KEY: optionalString,
    /**
     * Test-mode FX rate overrides as JSON `{"NGN":"1602.04"}`: "1 USD = R <code>", decimal strings
     * (never JSON numbers, so no float ever touches a rate). Entries override the built-in test
     * table (fx.ts TEST_FX_RATES). Never used in live mode.
     */
    FX_FIXED_RATES: z.preprocess(
      blankAsUnset,
      z
        .string()
        .default('{}')
        .transform((text, ctx) => {
          let v: unknown;
          try {
            v = JSON.parse(text);
          } catch {
            v = null;
          }
          const ok =
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            Object.entries(v).every(
              ([code, rate]) =>
                /^[A-Z]{3}$/.test(code) &&
                typeof rate === 'string' &&
                /^\d+(\.\d+)?$/.test(rate) &&
                /[1-9]/.test(rate),
            );
          if (!ok) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'must be a JSON object of currency code to positive decimal string',
            });
            return z.NEVER;
          }
          return v as Record<string, string>;
        }),
    ),
    SCREENING_TEST_BLOCKLIST: z.preprocess(
      blankAsUnset,
      z.string().default('0x000000000000000000000000000000000000dead'),
    ),
    /**
     * Base URL of the hosted checkout page; a session's `url` is
     * `${CHECKOUT_BASE_URL}/pay/{id}#cs={client_secret}`. No trailing slash needed.
     */
    CHECKOUT_BASE_URL: z.preprocess(
      blankAsUnset,
      z
        .string()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')
        .default('http://localhost:3000'),
    ),
  })
  .superRefine((e, ctx) => {
    if (e.MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO > e.FUNDING_PER_ACCOUNT_YOCTO) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO'],
        message: 'must not exceed FUNDING_PER_ACCOUNT_YOCTO',
      });
    }
    if (
      e.MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO === 0n ||
      e.MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO > e.FUNDING_PER_ACCOUNT_YOCTO
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO'],
        message: 'must be positive and not exceed FUNDING_PER_ACCOUNT_YOCTO',
      });
    }
    if (e.NODE_ENV === 'production' && e.KEYVAULT_DRIVER === 'local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KEYVAULT_DRIVER'],
        message: 'local is not allowed in production (set KEYVAULT_DRIVER=gcp)',
      });
    }
    const driver = e.NEAR_CLIENT_DRIVER ?? (e.NODE_ENV === 'production' ? 'rpc' : 'fake');
    if (e.NEAR_FAKE_SIMULATE && driver !== 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEAR_FAKE_SIMULATE'],
        message: 'the contract simulator only runs with NEAR_CLIENT_DRIVER=fake',
      });
    }
    if (e.NODE_ENV === 'production' && e.NEAR_CLIENT_DRIVER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEAR_CLIENT_DRIVER'],
        message: 'fake is not allowed in production (set NEAR_CLIENT_DRIVER=rpc)',
      });
    }
    const fxProvider =
      e.FX_PROVIDER ?? (e.NODE_ENV === 'production' ? 'openexchangerates' : 'fixed');
    if (e.NODE_ENV === 'production' && fxProvider === 'fixed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FX_PROVIDER'],
        message: 'fixed is not allowed in production (set FX_PROVIDER=openexchangerates)',
      });
    }
    if (e.NODE_ENV === 'production' && !e.FX_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FX_API_KEY'],
        message: `required in production (FX_PROVIDER=${fxProvider})`,
      });
    }
    if (e.NODE_ENV === 'production') {
      if (!e.WEBAUTHN_RP_ID || e.WEBAUTHN_RP_ID === 'localhost') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBAUTHN_RP_ID'],
          message: 'required in production and must not be localhost',
        });
      }
      const origins = splitList(e.WEBAUTHN_ORIGINS);
      if (origins.length === 0 || origins.some((o) => !o.startsWith('https://'))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBAUTHN_ORIGINS'],
          message: 'required in production; every origin must be https',
        });
      }
      if (!e.ONECLICK_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ONECLICK_API_KEY'],
          message: 'required in production (the live 1Click provider authenticates with it)',
        });
      }
      if (e.MAIL_DRIVER === 'memory' || e.MAIL_DRIVER === 'log') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_DRIVER'],
          message: `${e.MAIL_DRIVER} is not allowed in production`,
        });
      }
    }
    for (const origin of splitList(e.WEBAUTHN_ORIGINS)) {
      if (!z.string().url().safeParse(origin).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBAUTHN_ORIGINS'],
          message: `not a URL: ${origin}`,
        });
      }
    }
    if (e.KEYVAULT_DRIVER !== 'gcp') return;
    for (const key of [
      'GCP_PROJECT_ID',
      'GCP_KMS_LOCATION',
      'GCP_KMS_KEYRING',
      'GCP_CREDENTIALS_JSON',
    ] as const) {
      if (!e[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'required when KEYVAULT_DRIVER=gcp',
        });
      }
    }
    if (e.GCP_CREDENTIALS_JSON && !isJsonObject(e.GCP_CREDENTIALS_JSON)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GCP_CREDENTIALS_JSON'],
        message: 'must be a service-account JSON object',
      });
    }
  })
  .transform((e) => ({
    ...e,
    API_HOST: e.API_HOST ?? (e.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    WORKER_HEALTH_HOST:
      e.WORKER_HEALTH_HOST ?? (e.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    NEAR_CLIENT_DRIVER: e.NEAR_CLIENT_DRIVER ?? (e.NODE_ENV === 'production' ? 'rpc' : 'fake'),
    WEBAUTHN_RP_ID: e.WEBAUTHN_RP_ID ?? 'localhost',
    WEBAUTHN_ORIGINS: e.WEBAUTHN_ORIGINS
      ? splitList(e.WEBAUTHN_ORIGINS)
      : ['http://localhost:3000'],
    FX_PROVIDER: e.FX_PROVIDER ?? (e.NODE_ENV === 'production' ? 'openexchangerates' : 'fixed'),
    MAIL_DRIVER:
      e.MAIL_DRIVER ??
      ({ development: 'log', test: 'memory', production: 'unconfigured' } as const)[e.NODE_ENV],
  }));

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isJsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function env(): Env {
  if (!cached) return loadEnv();
  return cached;
}
