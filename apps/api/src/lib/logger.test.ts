import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from './logger.js';

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts credential fields regardless of case', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('error', 'x', {
      Authorization: 'Bearer tdr_test_abc',
      apiKey: 'tdr_test_abc',
      ENV_KEYVAULT_JSON: 'private-key-bundle',
      nested: { privateKey: 'k', clientSecret: 's', walletSignature: 'w' },
      merchantId: 'mer_1',
    });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      Authorization: '[REDACTED]',
      apiKey: '[REDACTED]',
      ENV_KEYVAULT_JSON: '[REDACTED]',
      nested: {
        privateKey: '[REDACTED]',
        clientSecret: '[REDACTED]',
        walletSignature: '[REDACTED]',
      },
      merchantId: 'mer_1',
    });
  });
});

describe('RPC URL redaction (final review m4)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.EVM_RPC_URLS;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.TRON_RPC_URL;
    (await import('../env.js')).loadEnv();
  });

  it('never logs a provider key from any configured RPC URL, in any field or the message', async () => {
    process.env.EVM_RPC_URLS = JSON.stringify({
      base: 'https://base-mainnet.g.alchemy.com/v2/alc_KEY_base_123456789',
      arb: 'https://arb.example.quiknode.pro/0123456789abcdef0123456789abcdef/',
    });
    process.env.SOLANA_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=hel-1234567890abcdef';
    process.env.TRON_RPC_URL = 'https://tron.example.com/rpc?token=trx_secret_9876543210';
    (await import('../env.js')).loadEnv();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('warn', 'failed: https://base-mainnet.g.alchemy.com/v2/alc_KEY_base_123456789', {
      err: 'EvmTransportError: eth_call: request to https://base-mainnet.g.alchemy.com/v2/alc_KEY_base_123456789 failed',
      nested: {
        e: [
          'fetch https://arb.example.quiknode.pro/0123456789abcdef0123456789abcdef/ ECONNRESET',
          'POST https://mainnet.helius-rpc.com/?api-key=hel-1234567890abcdef 429',
          'POST https://tron.example.com/rpc?token=trx_secret_9876543210 timeout',
        ],
      },
    });
    const text = String(spy.mock.calls[0]?.[0]);
    for (const secret of [
      'alc_KEY_base_123456789',
      '0123456789abcdef0123456789abcdef',
      'hel-1234567890abcdef',
      'trx_secret_9876543210',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('base-mainnet.g.alchemy.com');
    expect(text).toContain('[redacted]');
  });

  it('redacts key-like parts of RPC URLs that are not configured too', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('warn', 'x', {
      err: 'https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161 and https://rpc.ankr.com/eth?apikey=abc123',
    });
    const text = String(spy.mock.calls[0]?.[0]);
    expect(text).not.toContain('9aa3d95b3bc440fa88ea12eaa4456161');
    expect(text).not.toContain('abc123');
    expect(text).toContain('mainnet.infura.io/v3/[redacted]');
  });

  it('logs a URL with a malformed % escape instead of throwing', async () => {
    process.env.EVM_RPC_URLS = JSON.stringify({
      base: 'https://rpc.example.com/v2/%E0%A4%A_bad_escape_key',
    });
    (await import('../env.js')).loadEnv();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() =>
      log('error', 'boom', {
        err: 'POST https://x.example.com/rpc%E0%A4%A?apikey=secret_123456 failed',
      }),
    ).not.toThrow();
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('secret_123456');
  });
});
