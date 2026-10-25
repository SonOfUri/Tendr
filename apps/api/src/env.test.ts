import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://x/y', REDIS_URL: 'redis://localhost:6380' };
const gcp = {
  GCP_PROJECT_ID: 'p1',
  GCP_KMS_LOCATION: 'global',
  GCP_KMS_KEYRING: 'tendr',
  GCP_CREDENTIALS_JSON: '{"type":"service_account","client_email":"a@b","private_key":"k"}',
};
/** Production has no WebAuthn defaults. */
const webauthn = {
  WEBAUTHN_RP_ID: 'usetendr.tech',
  WEBAUTHN_ORIGINS: 'https://dashboard.usetendr.tech',
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
