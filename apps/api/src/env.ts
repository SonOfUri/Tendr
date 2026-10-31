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

/** A gas price in gwei: a non-negative decimal string, never parsed as a float. */
const evmMaxFeeGwei = z.preprocess(
  blankAsUnset,
  z
    .string()
    .regex(/^\d+(\.\d{1,9})?$/, 'must be a non-negative decimal (gwei, at most 9 decimals)')
    .optional(),
);

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
    /**
     * Seconds the simulated contract's timelocks last (default 24 h, as on chain). Only the
     * WooCommerce e2e shortens it, so a timelocked store refund executes within the run. Only with
     * the contract simulator (`NEAR_FAKE_SIMULATE=1`).
     */
    NEAR_FAKE_TIMELOCK_SECONDS: z.coerce.number().int().min(1).max(86_400).optional(),
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
     * Tendr-wide daily cap (USD, per mode, UTC day) on unrecovered sponsorship losses
     * (`gas_sponsorships.sponsor = tendr`). Once reached, new payments are not sponsored (the
     * shopper pays) and operators are alerted. A decimal string, never parsed as a float.
     */
    TENDR_SPONSOR_LOSS_CAP_USD: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal')
        .default('50'),
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
     * Live-mode Solana JSON-RPC endpoint: deposit sender lookups and network-fee estimates
     * (base fee + priority fee). Default: the public mainnet RPC.
     */
    SOLANA_RPC_URL: z.preprocess(
      blankAsUnset,
      z
        .string()
        .url()
        .regex(/^https?:\/\//i, 'must be an http(s) URL')
        .default('https://api.mainnet-beta.solana.com'),
    ),
    /**
     * Live-mode Tron HTTP API (TronGrid-compatible): deposit sender lookups and network-fee
     * estimates (energy price). Default: the public TronGrid endpoint.
     */
    TRON_RPC_URL: z.preprocess(
      blankAsUnset,
      z
        .string()
        .url()
        .regex(/^https?:\/\//i, 'must be an http(s) URL')
        .default('https://api.trongrid.io'),
    ),
    /**
     * The TendrForwarder deployed on Tron (base58 `T…`), whose `payWithApproval` `gas-tron` calls
     * for gasless USDT payments (ruling T9-a). No default: gasless Tron is unavailable while it is
     * unset (the contract is not deployed yet). Never taken from a request.
     */
    TRON_FORWARDER_ADDRESS: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, 'must be a base58 Tron address (T…)')
        .optional(),
    ),
    /**
     * Safety margin (basis points) on a network fee Tendr quotes and collects: a shopper-paid fee
     * in a token is `usd × (1 + margin / 10 000) ÷ token price`, and a merchant-sponsored fee is
     * charged with the same margin. Integer 0–10 000, default 2000 (20 %).
     */
    GAS_FEE_MARGIN_BPS: z.preprocess(
      blankAsUnset,
      z.coerce.number().int().min(0).max(10_000).default(2000),
    ),
    /**
     * Operator gate for the gas-fee sweep (project 5a, Task 12). Off by default: due sweeps are
     * planned, recorded and announced to operators, but no gas-fee key signs anything until this
     * is `true`.
     */
    FEE_SWEEP_ENABLED: z.preprocess(
      blankAsUnset,
      z
        .enum(['true', 'false', '1', '0'])
        .default('false')
        .transform((v) => v === 'true' || v === '1'),
    ),
    /**
     * A gas-fee account's token is swept once it is worth at least this much (USD), or weekly.
     * A decimal string, never parsed as a float. Default 20.
     */
    FEE_SWEEP_THRESHOLD_USD: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal')
        .default('20'),
    ),
    /**
     * Tendr's NEAR account that receives swept gas fees (as USDC on NEAR). No default: while it is
     * unset no sweep executes, and operators are told why.
     */
    TENDR_FEE_ACCOUNT_NEAR: z.preprocess(blankAsUnset, nearAccountId.optional()),
    /**
     * Operators are alerted (once per 6 h per account) when a relayer key's native balance, or
     * Tendr's Pimlico balance, is worth less than this (USD). A decimal string. Default 50.
     */
    GAS_LOW_BALANCE_USD: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal')
        .default('50'),
    ),
    /**
     * The TendrForwarder contract (project 5a, onchain/evm) the EVM relayer calls: the same
     * CREATE2 address on every EVM chain and in both modes. Never taken from a request.
     */
    EVM_FORWARDER_ADDRESS: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
        .default('0x19BEBC71495490A99cA6F50F107076967380cf09'),
    ),
    /**
     * Optional per-chain ceiling (gwei, decimal) on the EVM relayer's `maxFeePerGas`, for its own
     * transactions and their replacements. Unset: no cap beyond the fee the chain asks for.
     */
    EVM_MAX_FEE_GWEI_ETH: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_BASE: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_ARB: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_OP: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_POL: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_BSC: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_AVAX: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_GNOSIS: evmMaxFeeGwei,
    EVM_MAX_FEE_GWEI_BERA: evmMaxFeeGwei,
    /**
     * Optional Pimlico sponsorship policy id, sent with every paymaster request the checkout's
     * paymaster proxy forwards (project 5a). The Pimlico API key itself is a stored secret
     * (`putSecret`, purpose `pimlico`), never an env var.
     */
    PIMLICO_SPONSORSHIP_POLICY_ID: z.preprocess(
      blankAsUnset,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be a Pimlico sponsorship policy id (sp_…)')
        .optional(),
    ),
    /**
     * Pimlico's Solana paymaster network (Kora JSON-RPC at
     * `https://solana.pimlico.io/v1/{network}/rpc`; the API key is the stored `pimlico` secret).
     * Live mode only; test mode never calls Pimlico. Default `mainnet`.
     */
    PIMLICO_SOLANA_NETWORK: z.preprocess(
      blankAsUnset,
      z.enum(['mainnet', 'devnet']).default('mainnet'),
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
     * `${CHECKOUT_BASE_URL}/{id}#cs={client_secret}` (root of the pay host). No trailing slash needed.
     */
    CHECKOUT_BASE_URL: z.preprocess(
      blankAsUnset,
      z
        .string()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')
        .default('http://localhost:3000'),
    ),
    /**
     * Shared secret the web server sends as `x-tendr-internal` when it reads public payment links
     * for a payer: with it, the API trusts `x-tendr-client-ip` as the payer's IP and keys per-IP
     * limits on it. Unset = never trusted. Required (≥ 32 chars) in production. Never logged.
     */
    WEB_INTERNAL_TOKEN: z.preprocess(blankAsUnset, z.string().min(32).optional()),
    /**
     * The origin theme assets are served from. Custom theme CSS and HTML may load images and fonts
     * from this origin only.
     */
    TENDR_ASSET_ORIGIN: z.preprocess(
      blankAsUnset,
      z
        .string()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')
        // Trailing slashes dropped, so `${origin}/${key}` never has `//`.
        .transform((u) => u.replace(/\/+$/, ''))
        .default('http://localhost:9100/tendr-assets'),
    ),
    /**
     * Where uploaded theme assets are stored: `s3` (any S3-compatible bucket — MinIO locally, R2
     * or S3 in production) or `memory` (tests). Defaults to memory outside production; production
     * must use s3. The bucket must be publicly readable at TENDR_ASSET_ORIGIN.
     */
    ASSET_STORE_DRIVER: z.preprocess(blankAsUnset, z.enum(['s3', 'memory']).optional()),
    /** S3 endpoint (MinIO: http://localhost:9100). Unset = AWS S3 for the region. */
    ASSET_S3_ENDPOINT: z.preprocess(blankAsUnset, z.string().url().optional()),
    ASSET_S3_REGION: z.preprocess(blankAsUnset, z.string().default('auto')),
    ASSET_S3_BUCKET: z.preprocess(blankAsUnset, optionalString),
    ASSET_S3_ACCESS_KEY_ID: z.preprocess(blankAsUnset, optionalString),
    ASSET_S3_SECRET_ACCESS_KEY: z.preprocess(blankAsUnset, optionalString),
    /** `true` for MinIO (bucket in the path, not the host name). */
    ASSET_S3_FORCE_PATH_STYLE: z.preprocess(
      blankAsUnset,
      z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
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
    if (e.NEAR_FAKE_TIMELOCK_SECONDS !== undefined && !e.NEAR_FAKE_SIMULATE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEAR_FAKE_TIMELOCK_SECONDS'],
        message: 'NEAR_FAKE_TIMELOCK_SECONDS only applies to the contract simulator',
      });
    }
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
      // Every public origin is https and not local: the defaults are localhost, so an unset
      // variable fails here by name.
      const publicOrigins: [string, string][] = [
        ['CHECKOUT_BASE_URL', e.CHECKOUT_BASE_URL],
        ['WEB_URL', e.WEB_URL],
        ['API_BASE_URL', e.API_BASE_URL],
        ...e.CORS_ORIGINS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((o): [string, string] => ['CORS_ORIGINS', o]),
      ];
      for (const [name, value] of publicOrigins) {
        let ok = false;
        try {
          const u = new URL(value);
          ok = u.protocol === 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1';
        } catch {
          ok = false;
        }
        if (!ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `must be an https URL on a non-local host in production (got ${value})`,
          });
        }
      }
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
      if (!e.WEB_INTERNAL_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEB_INTERNAL_TOKEN'],
          message: 'required in production (the web server reads payment links with it)',
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
    const assetDriver = e.ASSET_STORE_DRIVER ?? (e.NODE_ENV === 'production' ? 's3' : 'memory');
    if (e.NODE_ENV === 'production') {
      if (assetDriver !== 's3') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ASSET_STORE_DRIVER'],
          message: 'memory is not allowed in production (set ASSET_STORE_DRIVER=s3)',
        });
      }
      if (!e.TENDR_ASSET_ORIGIN.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TENDR_ASSET_ORIGIN'],
          message: 'must be https in production',
        });
      }
    }
    if (assetDriver === 's3') {
      for (const key of [
        'ASSET_S3_BUCKET',
        'ASSET_S3_ACCESS_KEY_ID',
        'ASSET_S3_SECRET_ACCESS_KEY',
      ] as const) {
        if (!e[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when ASSET_STORE_DRIVER=s3',
          });
        }
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
    ASSET_STORE_DRIVER:
      e.ASSET_STORE_DRIVER ?? (e.NODE_ENV === 'production' ? ('s3' as const) : ('memory' as const)),
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
