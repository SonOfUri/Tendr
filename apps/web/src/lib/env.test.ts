import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../instrumentation';
import { serverEnv, webInternalTokenProblem } from './env';

const TOKEN = 'w'.repeat(32);

afterEach(() => vi.unstubAllEnvs());

describe('WEB_INTERNAL_TOKEN', () => {
  it('is required, at least 32 characters, in production', () => {
    expect(webInternalTokenProblem(undefined, true)).toMatch(/WEB_INTERNAL_TOKEN/);
    expect(webInternalTokenProblem('', true)).toMatch(/required in production/);
    expect(webInternalTokenProblem('w'.repeat(31), true)).toMatch(/at least 32/);
    expect(webInternalTokenProblem(TOKEN, true)).toBeNull();
  });

  it('may be unset outside production, but never short (the API refuses a short one)', () => {
    expect(webInternalTokenProblem(undefined, false)).toBeNull();
    expect(webInternalTokenProblem('', false)).toBeNull();
    expect(webInternalTokenProblem('short', false)).toMatch(/at least 32/);
  });

  it('a production server fails at boot without it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('WEB_INTERNAL_TOKEN', '');
    await expect(register()).rejects.toThrow(/WEB_INTERNAL_TOKEN/);
    expect(() => serverEnv()).toThrow(/WEB_INTERNAL_TOKEN/);
    vi.stubEnv('WEB_INTERNAL_TOKEN', 'w'.repeat(20));
    await expect(register()).rejects.toThrow(/at least 32/);
    vi.stubEnv('WEB_INTERNAL_TOKEN', TOKEN);
    await expect(register()).resolves.toBeUndefined();
    expect(serverEnv().webInternalToken).toBe(TOKEN);
  });

  it('a production build (no server yet) does not need it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.stubEnv('WEB_INTERNAL_TOKEN', '');
    await expect(register()).resolves.toBeUndefined();
    expect(serverEnv().webInternalToken).toBeNull();
  });

  it('development runs without it', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WEB_INTERNAL_TOKEN', '');
    await expect(register()).resolves.toBeUndefined();
    expect(serverEnv().webInternalToken).toBeNull();
  });
});
