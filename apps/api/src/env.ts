import bs58 from 'bs58';
import { z } from 'zod';

const optionalString = z.string().min(1).optional();

/** A non-negative integer amount in yoctoNEAR, given as a decimal string. */
const yocto = z
  .string()
  .regex(/^\d{1,39}$/, 'must be a non-negative integer (yoctoNEAR)')
  .transform((s) => BigInt(s));

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
  })
  .superRefine((e, ctx) => {
    if (e.MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO > e.FUNDING_PER_ACCOUNT_YOCTO) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO'],
        message: 'must not exceed FUNDING_PER_ACCOUNT_YOCTO',
      });
    }
    if (e.NODE_ENV === 'production' && e.KEYVAULT_DRIVER === 'local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KEYVAULT_DRIVER'],
        message: 'local is not allowed in production (set KEYVAULT_DRIVER=gcp)',
      });
    }
    if (e.NODE_ENV === 'production' && e.NEAR_CLIENT_DRIVER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEAR_CLIENT_DRIVER'],
        message: 'fake is not allowed in production (set NEAR_CLIENT_DRIVER=rpc)',
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
