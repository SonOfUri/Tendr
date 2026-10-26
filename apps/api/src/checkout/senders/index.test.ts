import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../env.js';
import { FakeNearClient } from '../../near/fake.js';
import {
  BitcoinSenderResolver,
  DEFAULT_EVM_RPC_URLS,
  EvmSenderResolver,
  NearSenderResolver,
  SENDER_LOOKUP_TIMEOUT_MS,
  SenderResolvers,
  SolanaSenderResolver,
  TronSenderResolver,
  evmRpcUrls,
  liveSenderResolvers,
  type FetchLike,
} from './index.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that records calls and answers from `answer(url, body)`. */
function fakeFetch(answer: (url: string, body: unknown) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const f: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    return answer(url, body);
  };
  return { f, calls };
}

const input = (chain: string, hashes: string[], originAsset = 'nep141:x') => ({
  chain,
  originAsset,
  originTxHashes: hashes,
});

describe('EVM sender', () => {
  it('reads `from` via eth_getTransactionByHash on the chain RPC, with a timeout', async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        jsonrpc: '2.0',
        id: 1,
        result: { from: '0xAbCdEf0000000000000000000000000000000001' },
      }),
    );
    const r = new EvmSenderResolver(() => evmRpcUrls({}), f);
    await expect(r.resolve(input('base', ['0xhash']))).resolves.toEqual([
      '0xabcdef0000000000000000000000000000000001',
    ]);
    expect(calls[0]!.url).toBe(DEFAULT_EVM_RPC_URLS.base);
    expect(calls[0]!.body).toMatchObject({
      method: 'eth_getTransactionByHash',
      params: ['0xhash'],
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is [] for an unknown tx (null result), an RPC error, or a chain without an RPC', async () => {
    const r1 = new EvmSenderResolver(
      () => evmRpcUrls({}),
      fakeFetch(() => json({ result: null })).f,
    );
    await expect(r1.resolve(input('eth', ['0x1']))).resolves.toEqual([]);
    const r2 = new EvmSenderResolver(() => evmRpcUrls({}), fakeFetch(() => json({}, 503)).f);
    await expect(r2.resolve(input('eth', ['0x1']))).resolves.toEqual([]);
    const { f, calls } = fakeFetch(() => json({}));
    await expect(
      new EvmSenderResolver(() => evmRpcUrls({}), f).resolve(input('gnosis', ['0x1'])),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('EVM_RPC_URLS overrides and adds chains (long names accepted)', () => {
    const urls = evmRpcUrls({ arbitrum: 'https://arb.example', gnosis: 'https://gno.example' });
    expect(urls.arb).toBe('https://arb.example');
    expect(urls.gnosis).toBe('https://gno.example');
    expect(urls.eth).toBe(DEFAULT_EVM_RPC_URLS.eth);
    for (const k of ['eth', 'base', 'arb', 'pol', 'bsc', 'op', 'avax']) {
      expect(DEFAULT_EVM_RPC_URLS[k]).toMatch(/^https:\/\//);
    }
  });

  it('env: EVM_RPC_URLS must be a JSON object of URLs', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://x@localhost/x',
      REDIS_URL: 'redis://localhost:6379',
    } as NodeJS.ProcessEnv;
    expect(loadEnv({ ...base }).EVM_RPC_URLS).toEqual({});
    expect(loadEnv({ ...base, EVM_RPC_URLS: '{"eth":"https://e.example"}' }).EVM_RPC_URLS).toEqual({
      eth: 'https://e.example',
    });
    expect(() => loadEnv({ ...base, EVM_RPC_URLS: 'nope' })).toThrow(/EVM_RPC_URLS/);
    expect(() => loadEnv({ ...base, EVM_RPC_URLS: '{"eth":"ftp://x"}' })).toThrow(/EVM_RPC_URLS/);
    loadEnv(); // restore the process environment for the other tests
  });
});

describe('Solana sender', () => {
  it('reads the first account key (fee payer) from getTransaction', async () => {
    const payer = '7Xh8Qk1QpYb2cnfJgP4wLx9yWcVqYwz3R3vZ4kYp1aBc';
    const { f, calls } = fakeFetch(() =>
      json({
        result: {
          transaction: {
            message: { accountKeys: [payer, 'Other1111111111111111111111111111111'] },
          },
        },
      }),
    );
    await expect(
      new SolanaSenderResolver('https://sol.example', f).resolve(input('sol', ['SIG'])),
    ).resolves.toEqual([payer]);
    expect(calls[0]!.body).toMatchObject({
      method: 'getTransaction',
      params: ['SIG', expect.any(Object)],
    });
  });

  it('is [] for an unknown signature', async () => {
    const { f } = fakeFetch(() => json({ result: null }));
    await expect(
      new SolanaSenderResolver('https://sol.example', f).resolve(input('sol', ['SIG'])),
    ).resolves.toEqual([]);
  });
});

describe('Tron sender', () => {
  it('reads owner_address (base58, visible) from TronGrid gettransactionbyid', async () => {
    const owner = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
    const { f, calls } = fakeFetch(() =>
      json({
        raw_data: {
          contract: [{ parameter: { value: { owner_address: owner, contract_address: 'TX' } } }],
        },
      }),
    );
    await expect(
      new TronSenderResolver('https://tron.example', f).resolve(input('tron', ['0xABCD'])),
    ).resolves.toEqual([owner]);
    expect(calls[0]!.url).toBe('https://tron.example/wallet/gettransactionbyid');
    expect(calls[0]!.body).toEqual({ value: 'ABCD', visible: true });
  });

  it('is [] for an unknown tx ({})', async () => {
    const { f } = fakeFetch(() => json({}));
    await expect(
      new TronSenderResolver('https://t.example', f).resolve(input('tron', ['ab'])),
    ).resolves.toEqual([]);
  });
});

describe('Bitcoin sender', () => {
  const txid = 'a'.repeat(64);
  it('returns every distinct input address from mempool.space', async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        vin: [
          { prevout: { scriptpubkey_address: 'bc1qalice' } },
          { prevout: { scriptpubkey_address: 'bc1qbob' } },
          { prevout: { scriptpubkey_address: 'bc1qalice' } },
          { is_coinbase: true },
        ],
      }),
    );
    await expect(
      new BitcoinSenderResolver('https://mp.example', f).resolve(input('btc', [txid])),
    ).resolves.toEqual(['bc1qalice', 'bc1qbob']);
    expect(calls[0]!.url).toBe(`https://mp.example/api/tx/${txid}`);
  });

  it('is [] for a bad txid (no request) or a 404', async () => {
    const { f, calls } = fakeFetch(() => new Response('Transaction not found', { status: 404 }));
    const r = new BitcoinSenderResolver('https://mp.example', f);
    await expect(r.resolve(input('btc', ['nothex']))).resolves.toEqual([]);
    expect(calls).toEqual([]);
    await expect(r.resolve(input('btc', [txid]))).resolves.toEqual([]);
  });
});

describe('NEAR sender and dispatch', () => {
  it('NEAR: the transaction signer, routed by the token contract', async () => {
    const fake = new FakeNearClient({
      livemode: true,
      parentAccountId: 'tendr.near',
      intentsContractId: 'intents.near',
    });
    fake.scriptTxStatus('H', {
      hash: 'H',
      signerId: 'shopper.near',
      receiverId: 'usdc.near',
      receipts: [],
    });
    const r = new NearSenderResolver(() => fake);
    await expect(r.resolve(input('near', ['H', 'unknown'], 'nep141:usdc.near'))).resolves.toEqual([
      'shopper.near',
    ]);
    expect(fake.calls[0]).toEqual({ kind: 'txStatus', hash: 'H', accountId: 'usdc.near' });
  });

  it('dispatches by chain family; unknown chains and no hashes are []', async () => {
    const evm = { resolve: vi.fn(async () => ['0xa']) };
    const r = new SenderResolvers({ evm });
    await expect(r.resolve(input('arb', ['0x1']))).resolves.toEqual(['0xa']);
    await expect(r.resolve(input('sui', ['0x1']))).resolves.toEqual([]);
    await expect(r.resolve(input('eth', []))).resolves.toEqual([]);
    expect(evm.resolve).toHaveBeenCalledTimes(1);
  });

  it('live resolvers cover every family (EVM, Solana, Tron, Bitcoin endpoints)', async () => {
    expect(SENDER_LOOKUP_TIMEOUT_MS).toBe(5_000);
    const seen: string[] = [];
    const f: FetchLike = async (url) => {
      seen.push(url);
      return json({});
    };
    const live = liveSenderResolvers(
      () =>
        new FakeNearClient({
          livemode: true,
          parentAccountId: 'tendr.near',
          intentsContractId: 'i',
        }),
      f,
    );
    for (const chain of ['eth', 'sol', 'tron', 'btc']) {
      await live.resolve(input(chain, [chain === 'btc' ? 'b'.repeat(64) : '0x1']));
    }
    expect(seen).toEqual([
      DEFAULT_EVM_RPC_URLS.eth,
      'https://api.mainnet-beta.solana.com',
      'https://api.trongrid.io/wallet/gettransactionbyid',
      `https://mempool.space/api/tx/${'b'.repeat(64)}`,
    ]);
  });
});
