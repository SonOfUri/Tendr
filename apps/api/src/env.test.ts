import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://x/y', REDIS_URL: 'redis://localhost:6380' };
const gcp = {
  GCP_PROJECT_ID: 'p1',
  GCP_KMS_LOCATION: 'global',
  GCP_KMS_KEYRING: 'tendr',
  GCP_CREDENTIALS_JSON: '{"type":"service_account","client_email":"a@b","private_key":"k"}',
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
    const e = loadEnv({ ...base, ...gcp, NODE_ENV: 'production', KEYVAULT_DRIVER: 'gcp' });
    expect(e.KEYVAULT_DRIVER).toBe('gcp');
    expect(e.GCP_KMS_KEK).toBe('tendr-kek');
  });
});
