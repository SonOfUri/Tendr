import { z } from 'zod';

const optionalString = z.string().min(1).optional();

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
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
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production' && e.KEYVAULT_DRIVER === 'local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KEYVAULT_DRIVER'],
        message: 'local is not allowed in production (set KEYVAULT_DRIVER=gcp)',
      });
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
  });

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
