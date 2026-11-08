import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { getSecret } from '../secrets/secrets.js';
import { providerConfig } from './provider.js';

vi.mock('../lib/prisma.js', () => ({ prisma: { secret: { findFirst: vi.fn() } } }));
vi.mock('../secrets/secrets.js', () => ({ getSecret: vi.fn() }));
const base = {
  DATABASE_URL: 'postgresql://x/y',
  REDIS_URL: 'redis://localhost:6380',
  AI_PROVIDER: 'near-ai',
  AI_MODEL: 'z-ai/glm-5.3-flash',
};

describe('provider credential isolation', () => {
  beforeEach(() => {
    vi.mocked(prisma.secret.findFirst).mockReset().mockResolvedValue(null);
    vi.mocked(getSecret).mockReset();
  });
  afterEach(() => {
    loadEnv();
  });

  it('reads the NEAR key and gateway, independently of the generic provider credential', async () => {
    loadEnv({ ...base, NEARAI_API_KEY: 'near-test-key', AI_API_KEY: 'other-provider-key' });
    expect(await providerConfig()).toMatchObject({
      provider: 'near-ai',
      url: 'https://cloud-api.near.ai/v1',
      key: 'near-test-key',
    });
    expect(prisma.secret.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purpose: 'near-ai' },
      }),
    );
  });

  it('prefers the encrypted NEAR credential over the environment', async () => {
    loadEnv({ ...base, NEARAI_API_KEY: 'near-env-key' });
    vi.mocked(prisma.secret.findFirst).mockResolvedValue({ id: 'sec_near' } as never);
    vi.mocked(getSecret).mockResolvedValue('near-stored-key');
    expect((await providerConfig()).key).toBe('near-stored-key');
    expect(getSecret).toHaveBeenCalledWith('sec_near');
  });

  it('never substitutes a key from the other provider', async () => {
    loadEnv({ ...base, AI_API_KEY: 'other-provider-key' });
    await expect(providerConfig()).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    loadEnv({ ...base, AI_PROVIDER: 'openai-compatible', NEARAI_API_KEY: 'near-test-key' });
    await expect(providerConfig()).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('does not load credentials when disabled', async () => {
    loadEnv({ ...base, AI_PROVIDER: 'disabled', NEARAI_API_KEY: 'near-test-key' });
    await expect(providerConfig()).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  });
});
