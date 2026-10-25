import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../env.js';
import {
  HttpOneClick,
  SimulatedOneClick,
  feeAccountFor,
  providerFor,
  resetOneClickProviders,
  simulatedOneClick,
} from './index.js';

afterEach(() => {
  resetOneClickProviders();
  loadEnv();
});

describe('providerFor', () => {
  it('is the HTTP client in live mode and the shared simulated provider in test mode', () => {
    expect(providerFor(true)).toBeInstanceOf(HttpOneClick);
    expect(providerFor(true)).toBe(providerFor(true));
    expect(providerFor(false)).toBeInstanceOf(SimulatedOneClick);
    expect(providerFor(false)).toBe(simulatedOneClick());
  });

  it('can install a test-mode provider (e.g. on an isolated Redis key prefix)', () => {
    const sim = new SimulatedOneClick();
    resetOneClickProviders({ simulated: sim });
    expect(providerFor(false)).toBe(sim);
  });

  it('names the mode fee accounts', () => {
    const { FEE_ACCOUNT_LIVE: _l, FEE_ACCOUNT_TEST: _t, ...rest } = process.env;
    loadEnv(rest);
    expect(feeAccountFor(true)).toBe('fees.tendr.near');
    expect(feeAccountFor(false)).toBe('fees.tendr.testnet');
  });
});
