import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from './logger.js';

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts credential fields regardless of case', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('error', 'x', {
      Authorization: 'Bearer tdr_test_abc',
      apiKey: 'tdr_test_abc',
      nested: { privateKey: 'k', clientSecret: 's', walletSignature: 'w' },
      merchantId: 'mer_1',
    });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      Authorization: '[REDACTED]',
      apiKey: '[REDACTED]',
      nested: {
        privateKey: '[REDACTED]',
        clientSecret: '[REDACTED]',
        walletSignature: '[REDACTED]',
      },
      merchantId: 'mer_1',
    });
  });
});
