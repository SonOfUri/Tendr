import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { setLiveMode } from '../test/helpers.js';
import { AppError } from './errors.js';
import { assertLiveModeOpen, liveModeOpen, liveModeUnavailable } from './live-mode.js';

describe('live-mode switch', () => {
  afterEach(() => setLiveMode(undefined));

  it('liveModeUnavailable is a 403 LIVE_MODE_UNAVAILABLE with a plain message', () => {
    const e = liveModeUnavailable();
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('LIVE_MODE_UNAVAILABLE');
    expect(e.status).toBe(403);
    expect(e.message).toBe('Live payments are not open yet. Test mode works as usual.');
  });

  it('is closed when LIVE_MODE_ENABLED is unset', () => {
    setLiveMode(undefined);
    expect(liveModeOpen()).toBe(false);
    expect(() => assertLiveModeOpen()).toThrow(
      expect.objectContaining({ code: 'LIVE_MODE_UNAVAILABLE', status: 403 }),
    );
  });

  it('is open when LIVE_MODE_ENABLED=true', () => {
    setLiveMode(true);
    expect(loadEnv().LIVE_MODE_ENABLED).toBe(true);
    expect(liveModeOpen()).toBe(true);
    expect(() => assertLiveModeOpen()).not.toThrow();
  });
});
