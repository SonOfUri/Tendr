import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://x/y', REDIS_URL: 'redis://localhost:6380' };
const gcp = {
  GCP_PROJECT_ID: 'p1',
  GCP_KMS_LOCATION: 'global',
  GCP_KMS_KEYRING: 'tendr',
  GCP_CREDENTIALS_JSON: '{"type":"service_account","client_email":"a@b","private_key":"k"}',
};
/** Production has no WebAuthn defaults, and needs a 1Click API key and an FX API key. */
const webauthn = {
  WEBAUTHN_RP_ID: 'usetendr.tech',
  WEBAUTHN_ORIGINS: 'https://dashboard.usetendr.tech',
  ONECLICK_API_KEY: 'jwt',
  FX_API_KEY: 'oxr',
};

describe('loadEnv keyvault rules', () => {
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

  it('defaults the mail driver: log in development, memory in test, unconfigured in production', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).MAIL_DRIVER).toBe('log');
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).MAIL_DRIVER).toBe('memory');
    expect(loadEnv(prod).MAIL_DRIVER).toBe('unconfigured');
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
