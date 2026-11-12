import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';
import { assetUrl } from './storage/object-store.js';
import { createHash } from 'node:crypto';
import { KEY_NAMES } from './keyvault/keys.js';

const base = { DATABASE_URL: 'postgresql://x/y', REDIS_URL: 'redis://localhost:6380' };

describe('Tidepool configuration', () => {
  it('pins Test infrastructure and preserves Live settings', () => {
    const e = loadEnv({
      ...base,
      NODE_ENV: 'development',
      TEST_PAYMENT_PROVIDER: 'tidepool',
      NEAR_CLIENT_DRIVER: 'rpc',
      INTENTS_CONTRACT_TEST: 'wrong.testnet',
      NEAR_RPC_URL_TEST: 'https://example.com',
      INTENTS_CONTRACT_LIVE: 'intents.near',
    });
    expect(e.INTENTS_CONTRACT_TEST).toBe('verifier.tidepool-sandbox.testnet');
    expect(e.NEAR_RPC_URL_TEST).toBe('https://rpc.testnet.fastnear.com');
    expect(e.INTENTS_CONTRACT_LIVE).toBe('intents.near');
  });
  it('refuses simulator drivers outside unit tests', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'development', TEST_PAYMENT_PROVIDER: 'tidepool' }),
    ).toThrow(/TEST_PAYMENT_PROVIDER/);
    expect(loadEnv(base).TEST_PAYMENT_PROVIDER).toBe('simulated');
  });
});

describe('AI provider configuration', () => {
  it('uses the NEAR gateway and rejects mismatched endpoints or unsupported reasoning profiles', () => {
    const near = {
      ...base,
      AI_PROVIDER: 'near-ai',
      AI_MODEL: 'z-ai/glm-5.3-flash',
      NEARAI_API_KEY: 'near-test-credential',
    };
    expect(loadEnv(near)).toMatchObject({
      AI_PROVIDER: 'near-ai',
      AI_BASE_URL: 'https://cloud-api.near.ai/v1',
      NEARAI_API_KEY: 'near-test-credential',
    });
    expect(() => loadEnv({ ...near, AI_BASE_URL: 'https://api.openai.com/v1' })).toThrow(
      /AI_BASE_URL/,
    );
    expect(() => loadEnv({ ...near, AI_MODEL: 'unknown-model' })).toThrow(/AI_MODEL/);
    expect(loadEnv({ ...near, AI_MODEL: 'Qwen/Qwen3.6-35B-A3B-FP8' }).AI_PROVIDER).toBe('near-ai');
    expect(loadEnv(base).AI_BASE_URL).toBe('https://api.openai.com/v1');
  });
  it('defaults off and requires an explicit model before enabling', () => {
    expect(loadEnv(base).AI_PROVIDER).toBe('disabled');
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'openai-compatible' })).toThrow(/AI_MODEL/);
    expect(
      loadEnv({ ...base, AI_PROVIDER: 'openai-compatible', AI_MODEL: 'configured-model' }).AI_MODEL,
    ).toBe('configured-model');
  });
  it('requires a clean HTTPS endpoint and bounded request limits', () => {
    for (const AI_BASE_URL of [
      'not-a-url',
      'http://example.com/v1',
      'https://user:pass@example.com/v1',
      'https://example.com/v1?key=secret',
    ]) {
      expect(() => loadEnv({ ...base, AI_BASE_URL })).toThrow(/AI_BASE_URL/);
    }
    expect(() => loadEnv({ ...base, AI_DAILY_REQUEST_LIMIT: '0' })).toThrow(
      /AI_DAILY_REQUEST_LIMIT/,
    );
  });
});

describe('live screening policy', () => {
  it('defaults to Chainalysis and requires an explicit valid disabled setting', () => {
    expect(loadEnv(base).SCREENING_MODE).toBe('chainalysis');
    expect(loadEnv({ ...base, SCREENING_MODE: '' }).SCREENING_MODE).toBe('chainalysis');
    expect(loadEnv({ ...base, SCREENING_MODE: 'disabled' }).SCREENING_MODE).toBe('disabled');
    expect(() => loadEnv({ ...base, SCREENING_MODE: 'false' })).toThrow(/SCREENING_MODE/);
  });
});
const gcp = {
  GCP_PROJECT_ID: 'p1',
  GCP_KMS_LOCATION: 'global',
  GCP_KMS_KEYRING: 'tendr',
  GCP_CREDENTIALS_JSON: '{"type":"service_account","client_email":"a@b","private_key":"k"}',
};
/** Production's public origins: all https, none local. */
const origins = {
  CHECKOUT_BASE_URL: 'https://pay.usetendr.tech',
  WEB_URL: 'https://app.usetendr.tech',
  API_BASE_URL: 'https://api.usetendr.tech',
  CORS_ORIGINS: 'https://app.usetendr.tech',
};
/** Production's theme-asset store: an s3 bucket served from an https origin. */
const assets = {
  TENDR_ASSET_ORIGIN: 'https://assets.usetendr.tech',
  ASSET_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  ASSET_S3_BUCKET: 'tendr-assets',
  ASSET_S3_ACCESS_KEY_ID: 'ak',
  ASSET_S3_SECRET_ACCESS_KEY: 'sk',
};
/**
 * Production has no WebAuthn defaults, and needs a 1Click API key, an FX API key and an asset
 * store.
 */
const webauthn = {
  WEBAUTHN_RP_ID: 'usetendr.tech',
  WEBAUTHN_ORIGINS: 'https://dashboard.usetendr.tech',
  ONECLICK_API_KEY: 'jwt',
  FX_API_KEY: 'oxr',
  WEB_INTERNAL_TOKEN: 'i'.repeat(32),
  RESEND_API_KEY: 're_test',
  ...origins,
  ...assets,
};

describe('loadEnv keyvault rules', () => {
  it('accepts an explicit software vault in production and rejects missing or malformed bundles', () => {
    const key = (name: string) => createHash('sha256').update(name).digest('base64');
    const serialized = JSON.stringify({
      v: 1,
      kek: key('kek'),
      keys: Object.fromEntries(KEY_NAMES.map((name) => [name, key(name)])),
    });
    const settings = { ...base, ...webauthn, NODE_ENV: 'production', KEYVAULT_DRIVER: 'env' };
    expect(() => loadEnv(settings)).toThrow(/ENV_KEYVAULT_JSON/);
    expect(() => loadEnv({ ...settings, ENV_KEYVAULT_JSON: 'invalid-secret' })).toThrow(
      /ENV_KEYVAULT_JSON/,
    );
    expect(loadEnv({ ...settings, ENV_KEYVAULT_JSON: serialized }).KEYVAULT_DRIVER).toBe('env');
  });

  it('requires the API asset URL when serving a private bucket publicly', () => {
    expect(() => loadEnv({ ...base, ASSET_PUBLIC_PROXY: 'true' })).toThrow(/TENDR_ASSET_ORIGIN/);
    expect(
      loadEnv({
        ...base,
        ASSET_PUBLIC_PROXY: 'true',
        TENDR_ASSET_ORIGIN: 'http://localhost:4000/v1/assets',
      }).ASSET_PUBLIC_PROXY,
    ).toBe(true);
    expect(loadEnv(base).ASSET_PUBLIC_PROXY).toBe(false);
  });
  it('rejects KEYVAULT_DRIVER=local in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', KEYVAULT_DRIVER: 'local' })).toThrow(
      /KEYVAULT_DRIVER.*production/,
    );
    // The default driver is local, so production must set it explicitly.
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/KEYVAULT_DRIVER/);
  });

  it('accepts local outside production', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).KEYVAULT_DRIVER).toBe('local');
  });

  it('requires the GCP settings when KEYVAULT_DRIVER=gcp', () => {
    expect(() => loadEnv({ ...base, KEYVAULT_DRIVER: 'gcp' })).toThrow(
      /GCP_PROJECT_ID.*GCP_KMS_LOCATION.*GCP_KMS_KEYRING.*GCP_CREDENTIALS_JSON/,
    );
    expect(() =>
      loadEnv({ ...base, ...gcp, KEYVAULT_DRIVER: 'gcp', GCP_CREDENTIALS_JSON: 'not json' }),
    ).toThrow(/GCP_CREDENTIALS_JSON/);
  });

  it('accepts gcp in production with the KEK defaulting to tendr-kek', () => {
    const e = loadEnv({
      ...base,
      ...gcp,
      ...webauthn,
      NODE_ENV: 'production',
      KEYVAULT_DRIVER: 'gcp',
    });
    expect(e.KEYVAULT_DRIVER).toBe('gcp');
    expect(e.GCP_KMS_KEK).toBe('tendr-kek');
  });
});

describe('loadEnv worker health', () => {
  it('binds 0.0.0.0 in production and 127.0.0.1 otherwise, unless WORKER_HEALTH_HOST is set', () => {
    const prod = loadEnv({
      ...base,
      ...gcp,
      ...webauthn,
      NODE_ENV: 'production',
      KEYVAULT_DRIVER: 'gcp',
    });
    expect(prod.WORKER_HEALTH_HOST).toBe('0.0.0.0');
    expect(prod.WORKER_HEALTH_PORT).toBe(4100);
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).WORKER_HEALTH_HOST).toBe('127.0.0.1');
    expect(loadEnv({ ...base, WORKER_HEALTH_HOST: '::' }).WORKER_HEALTH_HOST).toBe('::');
  });
});

describe('loadEnv api host', () => {
  it('binds 0.0.0.0 in production and 127.0.0.1 otherwise, unless API_HOST is set', () => {
    const prod = loadEnv({
      ...base,
      ...gcp,
      ...webauthn,
      NODE_ENV: 'production',
      KEYVAULT_DRIVER: 'gcp',
    });
    expect(prod.API_HOST).toBe('0.0.0.0');
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).API_HOST).toBe('127.0.0.1');
    expect(loadEnv({ ...base, API_HOST: '::' }).API_HOST).toBe('::');
  });
});

describe('loadEnv NEAR settings', () => {
  it('defaults the NEAR client to fake outside production and rpc in production', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).NEAR_CLIENT_DRIVER).toBe('fake');
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).NEAR_CLIENT_DRIVER).toBe('fake');
    const prod = loadEnv({
      ...base,
      ...gcp,
      ...webauthn,
      NODE_ENV: 'production',
      KEYVAULT_DRIVER: 'gcp',
    });
    expect(prod.NEAR_CLIENT_DRIVER).toBe('rpc');
  });

  it('rejects the fake NEAR client in production', () => {
    expect(() =>
      loadEnv({
        ...base,
        ...gcp,
        NODE_ENV: 'production',
        KEYVAULT_DRIVER: 'gcp',
        NEAR_CLIENT_DRIVER: 'fake',
      }),
    ).toThrow(/NEAR_CLIENT_DRIVER/);
  });

  it('NEAR_FAKE_SIMULATE: off by default, on only with the fake driver', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).NEAR_FAKE_SIMULATE).toBe(false);
    expect(
      loadEnv({ ...base, NODE_ENV: 'development', NEAR_FAKE_SIMULATE: '1' }).NEAR_FAKE_SIMULATE,
    ).toBe(true);
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'development',
        NEAR_CLIENT_DRIVER: 'rpc',
        NEAR_FAKE_SIMULATE: '1',
      }),
    ).toThrow(/NEAR_FAKE_SIMULATE/);
    expect(() =>
      loadEnv({
        ...base,
        ...gcp,
        ...webauthn,
        NODE_ENV: 'production',
        KEYVAULT_DRIVER: 'gcp',
        NEAR_FAKE_SIMULATE: '1',
      }),
    ).toThrow(/NEAR_FAKE_SIMULATE/);
  });

  it('NEAR_FAKE_TIMELOCK_SECONDS: only with the contract simulator', () => {
    const dev = { ...base, NODE_ENV: 'development' };
    expect(loadEnv(dev).NEAR_FAKE_TIMELOCK_SECONDS).toBeUndefined();
    expect(
      loadEnv({ ...dev, NEAR_FAKE_SIMULATE: '1', NEAR_FAKE_TIMELOCK_SECONDS: '5' })
        .NEAR_FAKE_TIMELOCK_SECONDS,
    ).toBe(5);
    expect(() => loadEnv({ ...dev, NEAR_FAKE_TIMELOCK_SECONDS: '5' })).toThrow(
      /NEAR_FAKE_TIMELOCK_SECONDS/,
    );
    expect(() =>
      loadEnv({ ...dev, NEAR_FAKE_SIMULATE: '1', NEAR_FAKE_TIMELOCK_SECONDS: '0' }),
    ).toThrow(/NEAR_FAKE_TIMELOCK_SECONDS/);
  });

  it('API tests never run the contract simulator (setup-env pins it off)', () => {
    expect(process.env.NEAR_FAKE_SIMULATE).toBe('0');
  });

  it('defaults the per-mode accounts and parses caps as yocto bigints', () => {
    const e = loadEnv({ ...base, FUNDING_DAILY_CAP_YOCTO: '7000000000000000000000000' });
    expect(e).toMatchObject({
      NEAR_PARENT_ACCOUNT_LIVE: 'tendr.near',
      NEAR_PARENT_ACCOUNT_TEST: 'tendr.testnet',
      INTENTS_CONTRACT_LIVE: 'intents.near',
      INTENTS_CONTRACT_TEST: 'intents-mock.tendr.testnet',
      FUNDING_DAILY_CAP_YOCTO: 7n * 10n ** 24n,
      FUNDING_PER_ACCOUNT_YOCTO: 10n ** 24n,
    });
    expect(() => loadEnv({ ...base, FUNDING_PER_ACCOUNT_YOCTO: '1.5' })).toThrow(
      /FUNDING_PER_ACCOUNT_YOCTO/,
    );
  });

  it('requires code hashes to be base58 32-byte hashes', () => {
    const hash = '4GJwVp4E5Rr6JqDnENmZwbDwYxx5d7KtLBBrnLqkdbzh';
    expect(
      loadEnv({ ...base, MERCHANT_ACCOUNT_CODE_HASH_TEST: hash }).MERCHANT_ACCOUNT_CODE_HASH_TEST,
    ).toBe(hash);
    expect(() => loadEnv({ ...base, MERCHANT_ACCOUNT_CODE_HASH_LIVE: 'abc' })).toThrow(
      /MERCHANT_ACCOUNT_CODE_HASH_LIVE/,
    );
  });
});

describe('loadEnv dashboard auth and mail', () => {
  const prod = {
    ...base,
    ...gcp,
    NODE_ENV: 'production',
    KEYVAULT_DRIVER: 'gcp',
    WEBAUTHN_RP_ID: 'usetendr.tech',
    WEBAUTHN_ORIGINS: 'https://dashboard.usetendr.tech',
    ONECLICK_API_KEY: 'jwt',
    FX_API_KEY: 'oxr',
    WEB_INTERNAL_TOKEN: 'i'.repeat(32),
    RESEND_API_KEY: 're_test',
    ...origins,
    ...assets,
  };

  it('defaults WebAuthn to localhost and parses the origin list', () => {
    const e = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(e.WEBAUTHN_RP_ID).toBe('localhost');
    expect(e.WEBAUTHN_RP_NAME).toBe('Tendr');
    expect(e.WEBAUTHN_ORIGINS).toEqual(['http://localhost:3000']);
    const custom = loadEnv({
      ...base,
      WEBAUTHN_ORIGINS: 'https://dashboard.usetendr.tech, https://checkout.usetendr.tech',
    });
    expect(custom.WEBAUTHN_ORIGINS).toEqual([
      'https://dashboard.usetendr.tech',
      'https://checkout.usetendr.tech',
    ]);
  });

  it('defaults the mail driver: log in development, memory in test, resend in production', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).MAIL_DRIVER).toBe('log');
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).MAIL_DRIVER).toBe('memory');
    expect(loadEnv(prod).MAIL_DRIVER).toBe('resend');
  });

  it('refuses the memory and log mail drivers and a localhost RP ID in production', () => {
    expect(() => loadEnv({ ...prod, MAIL_DRIVER: 'memory' })).toThrow(/MAIL_DRIVER/);
    expect(() => loadEnv({ ...prod, MAIL_DRIVER: 'log' })).toThrow(/MAIL_DRIVER/);
    expect(() => loadEnv({ ...prod, WEBAUTHN_RP_ID: 'localhost' })).toThrow(/WEBAUTHN_RP_ID/);
    expect(() => loadEnv({ ...prod, WEBAUTHN_ORIGINS: 'http://localhost:3000' })).toThrow(
      /WEBAUTHN_ORIGINS/,
    );
  });
});

describe('loadEnv production origins', () => {
  const prod = { ...base, ...gcp, ...webauthn, NODE_ENV: 'production', KEYVAULT_DRIVER: 'gcp' };

  it('accepts four https, non-local origins', () => {
    const e = loadEnv(prod);
    expect(e.CHECKOUT_BASE_URL).toBe('https://pay.usetendr.tech');
  });

  it.each([
    ['CHECKOUT_BASE_URL', { CHECKOUT_BASE_URL: 'http://pay.usetendr.tech' }],
    ['WEB_URL', { WEB_URL: 'http://localhost:3000' }],
    ['CORS_ORIGINS', { CORS_ORIGINS: 'https://app.usetendr.tech,http://localhost:3000' }],
    ['CORS_ORIGINS', { CORS_ORIGINS: 'https://127.0.0.1' }],
  ])('rejects a bad %s', (name, patch) => {
    expect(() => loadEnv({ ...prod, ...patch })).toThrow(new RegExp(name));
  });

  it('rejects an unset API_BASE_URL (localhost default)', () => {
    const { API_BASE_URL: _unused, ...without } = prod;
    expect(() => loadEnv(without)).toThrow(/API_BASE_URL/);
  });

  it('keeps the localhost defaults outside production', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).API_BASE_URL).toBe(
      'http://localhost:4000',
    );
  });
});

describe('loadEnv web internal token', () => {
  const prod = {
    ...base,
    ...gcp,
    ...webauthn,
    NODE_ENV: 'production',
    KEYVAULT_DRIVER: 'gcp',
  };

  it('WEB_INTERNAL_TOKEN required and ≥ 32 chars in production', () => {
    const { WEB_INTERNAL_TOKEN: _unused, ...withoutToken } = prod;
    expect(() => loadEnv(withoutToken)).toThrow(/WEB_INTERNAL_TOKEN/);
    expect(() => loadEnv({ ...prod, WEB_INTERNAL_TOKEN: 'short' })).toThrow(/WEB_INTERNAL_TOKEN/);
    expect(loadEnv(prod).WEB_INTERNAL_TOKEN).toBe(prod.WEB_INTERNAL_TOKEN);
    // Optional elsewhere.
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).WEB_INTERNAL_TOKEN).toBeUndefined();
  });
});

describe('loadEnv merchant account seed balance', () => {
  it('defaults within the per-account funding cap', () => {
    const e = loadEnv({ ...base, NODE_ENV: 'test' });
    expect(e.MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO).toBe(5n * 10n ** 23n);
  });

  it('rejects a seed balance above FUNDING_PER_ACCOUNT_YOCTO', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'test',
        FUNDING_PER_ACCOUNT_YOCTO: '100',
        MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO: '101',
      }),
    ).toThrow(/MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO/);
  });
});

describe('loadEnv 1Click and fee accounts', () => {
  const prod = { ...base, ...gcp, ...webauthn, NODE_ENV: 'production', KEYVAULT_DRIVER: 'gcp' };

  it('defaults the 1Click base URL and the mode fee accounts', () => {
    const e = loadEnv({ ...base, NODE_ENV: 'test' });
    expect(e.ONECLICK_BASE_URL).toBe('https://1click.chaindefuser.com');
    expect(e.ONECLICK_API_KEY).toBeUndefined();
    expect(e.FEE_ACCOUNT_LIVE).toBe('fees.tendr.near');
    expect(e.FEE_ACCOUNT_TEST).toBe('fees.tendr.testnet');
  });

  it('requires ONECLICK_API_KEY in production', () => {
    const { ONECLICK_API_KEY: _key, ...noKey } = prod;
    expect(() => loadEnv(noKey)).toThrow(/ONECLICK_API_KEY/);
    expect(loadEnv(prod).ONECLICK_API_KEY).toBe('jwt');
  });

  it('rejects a fee account that is not a NEAR account id', () => {
    expect(() => loadEnv({ ...base, FEE_ACCOUNT_LIVE: 'Fees.Tendr.near' })).toThrow(
      /FEE_ACCOUNT_LIVE/,
    );
    expect(() => loadEnv({ ...base, FEE_ACCOUNT_TEST: 'fees..testnet' })).toThrow(
      /FEE_ACCOUNT_TEST/,
    );
    expect(() => loadEnv({ ...base, ONECLICK_BASE_URL: 'not a url' })).toThrow(/ONECLICK_BASE_URL/);
  });
});

describe('loadEnv checkout base url', () => {
  it('defaults to http://localhost:3000 and treats blank as unset', () => {
    expect(loadEnv(base).CHECKOUT_BASE_URL).toBe('http://localhost:3000');
    expect(loadEnv({ ...base, CHECKOUT_BASE_URL: ' ' }).CHECKOUT_BASE_URL).toBe(
      'http://localhost:3000',
    );
    expect(loadEnv({ ...base, CHECKOUT_BASE_URL: 'https://pay.tendr.xyz' }).CHECKOUT_BASE_URL).toBe(
      'https://pay.tendr.xyz',
    );
  });

  it('rejects a non-URL', () => {
    expect(() => loadEnv({ ...base, CHECKOUT_BASE_URL: 'not a url' })).toThrow(/CHECKOUT_BASE_URL/);
    expect(() => loadEnv({ ...base, CHECKOUT_BASE_URL: 'ftp://pay.tendr.xyz' })).toThrow(
      /CHECKOUT_BASE_URL/,
    );
  });
});

describe('loadEnv TENDR_SPONSOR_LOSS_CAP_USD', () => {
  it('defaults to $50, treats blank as unset, accepts a decimal and rejects junk', () => {
    expect(loadEnv(base).TENDR_SPONSOR_LOSS_CAP_USD).toBe('50');
    expect(loadEnv({ ...base, TENDR_SPONSOR_LOSS_CAP_USD: ' ' }).TENDR_SPONSOR_LOSS_CAP_USD).toBe(
      '50',
    );
    expect(
      loadEnv({ ...base, TENDR_SPONSOR_LOSS_CAP_USD: '12.5' }).TENDR_SPONSOR_LOSS_CAP_USD,
    ).toBe('12.5');
    expect(() => loadEnv({ ...base, TENDR_SPONSOR_LOSS_CAP_USD: '-1' })).toThrow(
      /TENDR_SPONSOR_LOSS_CAP_USD/,
    );
  });
});

describe('loadEnv live-mode switch', () => {
  it('is off by default and parses like FEE_SWEEP_ENABLED', () => {
    expect(loadEnv(base).LIVE_MODE_ENABLED).toBe(false);
    expect(loadEnv({ ...base, LIVE_MODE_ENABLED: ' ' }).LIVE_MODE_ENABLED).toBe(false);
    expect(loadEnv({ ...base, LIVE_MODE_ENABLED: 'true' }).LIVE_MODE_ENABLED).toBe(true);
    expect(loadEnv({ ...base, LIVE_MODE_ENABLED: '1' }).LIVE_MODE_ENABLED).toBe(true);
    expect(loadEnv({ ...base, LIVE_MODE_ENABLED: '0' }).LIVE_MODE_ENABLED).toBe(false);
    expect(() => loadEnv({ ...base, LIVE_MODE_ENABLED: 'yes' })).toThrow(/LIVE_MODE_ENABLED/);
  });
});

describe('loadEnv gas-fee sweep and alerts', () => {
  it('defaults: sweep off, $20 threshold, no fee account, $50 low-balance alert', () => {
    const e = loadEnv(base);
    expect(e.FEE_SWEEP_ENABLED).toBe(false);
    expect(e.FEE_SWEEP_THRESHOLD_USD).toBe('20');
    expect(e.TENDR_FEE_ACCOUNT_NEAR).toBeUndefined();
    expect(e.GAS_LOW_BALANCE_USD).toBe('50');
  });
  it('parses the gate, the decimals and the NEAR account; rejects junk', () => {
    const e = loadEnv({
      ...base,
      FEE_SWEEP_ENABLED: 'true',
      FEE_SWEEP_THRESHOLD_USD: '25.5',
      TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near',
      GAS_LOW_BALANCE_USD: ' ',
    });
    expect(e.FEE_SWEEP_ENABLED).toBe(true);
    expect(e.FEE_SWEEP_THRESHOLD_USD).toBe('25.5');
    expect(e.TENDR_FEE_ACCOUNT_NEAR).toBe('fees.tendr.near');
    expect(e.GAS_LOW_BALANCE_USD).toBe('50');
    expect(() => loadEnv({ ...base, FEE_SWEEP_ENABLED: 'yes' })).toThrow(/FEE_SWEEP_ENABLED/);
    expect(() => loadEnv({ ...base, TENDR_FEE_ACCOUNT_NEAR: 'Not An Account' })).toThrow(
      /TENDR_FEE_ACCOUNT_NEAR/,
    );
    expect(() => loadEnv({ ...base, GAS_LOW_BALANCE_USD: '-1' })).toThrow(/GAS_LOW_BALANCE_USD/);
  });
});

describe('loadEnv EVM relayer', () => {
  it('defaults the forwarder to the CREATE2 address and leaves fee caps unset', () => {
    const e = loadEnv(base);
    expect(e.EVM_FORWARDER_ADDRESS).toBe('0x19BEBC71495490A99cA6F50F107076967380cf09');
    expect(e.EVM_MAX_FEE_GWEI_BASE).toBeUndefined();
    expect(e.EVM_MAX_FEE_GWEI_ETH).toBeUndefined();
    expect(loadEnv({ ...base, EVM_MAX_FEE_GWEI_ARB: ' ' }).EVM_MAX_FEE_GWEI_ARB).toBeUndefined();
  });

  it('accepts overrides and rejects junk', () => {
    const e = loadEnv({
      ...base,
      EVM_FORWARDER_ADDRESS: '0x1234567890abcdef1234567890abcdef12345678',
      EVM_MAX_FEE_GWEI_BASE: '0.5',
      EVM_MAX_FEE_GWEI_ETH: '80',
    });
    expect(e.EVM_FORWARDER_ADDRESS).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(e.EVM_MAX_FEE_GWEI_BASE).toBe('0.5');
    expect(e.EVM_MAX_FEE_GWEI_ETH).toBe('80');
    expect(() => loadEnv({ ...base, EVM_FORWARDER_ADDRESS: '0x1234' })).toThrow(
      /EVM_FORWARDER_ADDRESS/,
    );
    expect(() => loadEnv({ ...base, EVM_MAX_FEE_GWEI_POL: '-1' })).toThrow(/EVM_MAX_FEE_GWEI_POL/);
    expect(() => loadEnv({ ...base, EVM_MAX_FEE_GWEI_BSC: 'lots' })).toThrow(
      /EVM_MAX_FEE_GWEI_BSC/,
    );
  });

  it('takes an optional Pimlico sponsorship policy id', () => {
    expect(loadEnv(base).PIMLICO_SPONSORSHIP_POLICY_ID).toBeUndefined();
    expect(
      loadEnv({ ...base, PIMLICO_SPONSORSHIP_POLICY_ID: ' ' }).PIMLICO_SPONSORSHIP_POLICY_ID,
    ).toBeUndefined();
    expect(
      loadEnv({ ...base, PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_sharp_wolf' })
        .PIMLICO_SPONSORSHIP_POLICY_ID,
    ).toBe('sp_sharp_wolf');
    expect(() => loadEnv({ ...base, PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_x&apikey=evil' })).toThrow(
      /PIMLICO_SPONSORSHIP_POLICY_ID/,
    );
  });

  it('picks the Pimlico Solana network (mainnet unless devnet)', () => {
    expect(loadEnv(base).PIMLICO_SOLANA_NETWORK).toBe('mainnet');
    expect(loadEnv({ ...base, PIMLICO_SOLANA_NETWORK: ' ' }).PIMLICO_SOLANA_NETWORK).toBe(
      'mainnet',
    );
    expect(loadEnv({ ...base, PIMLICO_SOLANA_NETWORK: 'devnet' }).PIMLICO_SOLANA_NETWORK).toBe(
      'devnet',
    );
    expect(() => loadEnv({ ...base, PIMLICO_SOLANA_NETWORK: 'testnet' })).toThrow(
      /PIMLICO_SOLANA_NETWORK/,
    );
  });
});

describe('loadEnv gas fee pricing and chain RPCs', () => {
  it('defaults the margin to 2000 bps and the Solana and Tron RPCs to public mainnet', () => {
    const e = loadEnv(base);
    expect(e.GAS_FEE_MARGIN_BPS).toBe(2000);
    expect(e.SOLANA_RPC_URL).toBe('https://api.mainnet-beta.solana.com');
    expect(e.TRON_RPC_URL).toBe('https://api.trongrid.io');
    expect(loadEnv({ ...base, GAS_FEE_MARGIN_BPS: ' ' }).GAS_FEE_MARGIN_BPS).toBe(2000);
  });

  it('accepts overrides and rejects junk', () => {
    const e = loadEnv({
      ...base,
      GAS_FEE_MARGIN_BPS: '500',
      SOLANA_RPC_URL: 'https://sol.example/rpc',
      TRON_RPC_URL: 'https://tron.example',
    });
    expect(e.GAS_FEE_MARGIN_BPS).toBe(500);
    expect(e.SOLANA_RPC_URL).toBe('https://sol.example/rpc');
    expect(e.TRON_RPC_URL).toBe('https://tron.example');
    expect(() => loadEnv({ ...base, GAS_FEE_MARGIN_BPS: '-1' })).toThrow(/GAS_FEE_MARGIN_BPS/);
    expect(() => loadEnv({ ...base, GAS_FEE_MARGIN_BPS: '1.5' })).toThrow(/GAS_FEE_MARGIN_BPS/);
    expect(() => loadEnv({ ...base, GAS_FEE_MARGIN_BPS: '10001' })).toThrow(/GAS_FEE_MARGIN_BPS/);
    expect(() => loadEnv({ ...base, SOLANA_RPC_URL: 'not a url' })).toThrow(/SOLANA_RPC_URL/);
    expect(() => loadEnv({ ...base, TRON_RPC_URL: 'ftp://x' })).toThrow(/TRON_RPC_URL/);
  });

  it('has no Tron forwarder by default and accepts only a base58 Tron address', () => {
    expect(loadEnv(base).TRON_FORWARDER_ADDRESS).toBeUndefined();
    expect(
      loadEnv({ ...base, TRON_FORWARDER_ADDRESS: ' ' }).TRON_FORWARDER_ADDRESS,
    ).toBeUndefined();
    const t = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    expect(loadEnv({ ...base, TRON_FORWARDER_ADDRESS: t }).TRON_FORWARDER_ADDRESS).toBe(t);
    expect(() =>
      loadEnv({ ...base, TRON_FORWARDER_ADDRESS: '0x19BEBC71495490A99cA6F50F107076967380cf09' }),
    ).toThrow(/TRON_FORWARDER_ADDRESS/);
  });
});

describe('loadEnv checkout pricing', () => {
  it('defaults slippage to 100 bps and the gas cap to $2', () => {
    const e = loadEnv(base);
    expect(e.CHECKOUT_SLIPPAGE_BPS).toBe(100);
    expect(e.CHECKOUT_GAS_MAX_USD).toBe('2');
  });

  it('treats an empty or blank override as unset, not 0', () => {
    expect(loadEnv({ ...base, CHECKOUT_SLIPPAGE_BPS: '' }).CHECKOUT_SLIPPAGE_BPS).toBe(100);
    expect(loadEnv({ ...base, CHECKOUT_SLIPPAGE_BPS: '  ' }).CHECKOUT_SLIPPAGE_BPS).toBe(100);
    expect(loadEnv({ ...base, CHECKOUT_GAS_MAX_USD: '' }).CHECKOUT_GAS_MAX_USD).toBe('2');
  });

  it('accepts overrides', () => {
    const e = loadEnv({ ...base, CHECKOUT_SLIPPAGE_BPS: '50', CHECKOUT_GAS_MAX_USD: '1.5' });
    expect(e.CHECKOUT_SLIPPAGE_BPS).toBe(50);
    expect(e.CHECKOUT_GAS_MAX_USD).toBe('1.5');
  });

  it('rejects out-of-range or malformed values', () => {
    expect(() => loadEnv({ ...base, CHECKOUT_SLIPPAGE_BPS: '10001' })).toThrow(
      /CHECKOUT_SLIPPAGE_BPS/,
    );
    expect(() => loadEnv({ ...base, CHECKOUT_SLIPPAGE_BPS: '1.5' })).toThrow(
      /CHECKOUT_SLIPPAGE_BPS/,
    );
    expect(() => loadEnv({ ...base, CHECKOUT_GAS_MAX_USD: '-1' })).toThrow(/CHECKOUT_GAS_MAX_USD/);
    expect(() => loadEnv({ ...base, CHECKOUT_GAS_MAX_USD: '2e3' })).toThrow(/CHECKOUT_GAS_MAX_USD/);
  });
});

describe('loadEnv FX', () => {
  const prod = {
    ...base,
    ...gcp,
    ...webauthn,
    NODE_ENV: 'production',
    KEYVAULT_DRIVER: 'gcp',
  };

  it('defaults to the fixed provider outside production, openexchangerates in production', () => {
    const dev = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(dev.FX_PROVIDER).toBe('fixed');
    expect(dev.FX_FIXED_RATES).toEqual({});
    expect(loadEnv(prod).FX_PROVIDER).toBe('openexchangerates');
  });

  it('refuses the fixed provider and a missing FX_API_KEY in production only', () => {
    expect(() => loadEnv({ ...prod, FX_PROVIDER: 'fixed' })).toThrow(/FX_PROVIDER/);
    const { FX_API_KEY: _key, ...noKey } = prod;
    expect(() => loadEnv(noKey)).toThrow(/FX_API_KEY/);
    // Outside production a missing key is allowed: live non-USD sessions are then 503.
    expect(loadEnv({ ...base, FX_PROVIDER: 'openexchangerates' }).FX_API_KEY).toBeUndefined();
    expect(() => loadEnv({ ...base, FX_PROVIDER: 'ecb' })).toThrow(/FX_PROVIDER/);
  });

  it('parses FX_FIXED_RATES as currency → positive decimal string', () => {
    const e = loadEnv({ ...base, FX_FIXED_RATES: '{"NGN":"1602.04","JPY":"151.5"}' });
    expect(e.FX_FIXED_RATES).toEqual({ NGN: '1602.04', JPY: '151.5' });
    for (const bad of ['not json', '[]', '{"NGN":1602.04}', '{"NGN":"0"}', '{"ngn":"1"}']) {
      expect(() => loadEnv({ ...base, FX_FIXED_RATES: bad }), bad).toThrow(/FX_FIXED_RATES/);
    }
  });
});

describe('loadEnv theme asset store', () => {
  const prod = { ...base, ...gcp, ...webauthn, NODE_ENV: 'production', KEYVAULT_DRIVER: 'gcp' };

  it('defaults to memory outside production and s3 in production', () => {
    const dev = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(dev.ASSET_STORE_DRIVER).toBe('memory');
    expect(dev.ASSET_S3_REGION).toBe('auto');
    expect(dev.ASSET_S3_FORCE_PATH_STYLE).toBe(false);
    expect(dev.TENDR_ASSET_ORIGIN).toBe('http://localhost:9100/tendr-assets');
    expect(loadEnv(prod).ASSET_STORE_DRIVER).toBe('s3');
    const minio = loadEnv({
      ...base,
      ASSET_STORE_DRIVER: 's3',
      ASSET_S3_ENDPOINT: 'http://localhost:9100',
      ASSET_S3_BUCKET: 'tendr-assets',
      ASSET_S3_ACCESS_KEY_ID: 'minio',
      ASSET_S3_SECRET_ACCESS_KEY: 'minio-secret',
      ASSET_S3_FORCE_PATH_STYLE: 'true',
    });
    expect(minio.ASSET_S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('s3 needs a bucket and keys; production needs s3 and an https origin', () => {
    expect(() => loadEnv({ ...base, ASSET_STORE_DRIVER: 's3' })).toThrow(/ASSET_S3_BUCKET/);
    expect(() => loadEnv({ ...prod, ASSET_STORE_DRIVER: 'memory' })).toThrow(/ASSET_STORE_DRIVER/);
    const { ASSET_S3_SECRET_ACCESS_KEY: _sk, ...noSecret } = prod;
    expect(() => loadEnv(noSecret)).toThrow(/ASSET_S3_SECRET_ACCESS_KEY/);
    expect(() => loadEnv({ ...prod, TENDR_ASSET_ORIGIN: 'http://assets.usetendr.tech' })).toThrow(
      /TENDR_ASSET_ORIGIN/,
    );
    const { TENDR_ASSET_ORIGIN: _o, ...noOrigin } = prod;
    expect(() => loadEnv(noOrigin)).toThrow(/TENDR_ASSET_ORIGIN/);
  });
});

describe('loadEnv asset origin', () => {
  it('drops trailing slashes so asset urls never have //', () => {
    expect(
      loadEnv({ ...base, TENDR_ASSET_ORIGIN: 'https://cdn.example/tendr//' }).TENDR_ASSET_ORIGIN,
    ).toBe('https://cdn.example/tendr');
    expect(assetUrl('assets/m/a.png')).toBe('https://cdn.example/tendr/assets/m/a.png');
    expect(
      loadEnv({ ...base, TENDR_ASSET_ORIGIN: 'https://cdn.example/' }).TENDR_ASSET_ORIGIN,
    ).toBe('https://cdn.example');
    expect(loadEnv(base).TENDR_ASSET_ORIGIN).toBe('http://localhost:9100/tendr-assets');
  });
});
