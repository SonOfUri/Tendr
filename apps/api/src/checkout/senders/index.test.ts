import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../env.js';
import { eventLog } from '../../near/events.js';
import { FakeNearClient } from '../../near/fake.js';
import {
  BitcoinSenderResolver,
  DEFAULT_EVM_RPC_URLS,
  EvmSenderResolver,
  NearSenderResolver,
  SENDER_LOOKUP_TIMEOUT_MS,
  SenderResolvers,
  SolanaSenderResolver,
  TRANSFER_TOPIC,
  TronSenderResolver,
  evmRpcUrls,
  liveSenderResolvers,
  tronHexToBase58,
  type FetchLike,
} from './index.js';

let logSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => logSpy.mockRestore());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that records calls and answers from `answer(url, body)`. */
function fakeFetch(answer: (url: string, body: Record<string, unknown>) => Response) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const f: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ url, init, body });
    return answer(url, body);
  };
  return { f, calls };
}

const input = (
  chain: string,
  hashes: string[],
  depositAddress = 'dep',
  originAsset = 'nep141:x',
) => ({
  chain,
  originAsset,
  depositAddress,
  originTxHashes: hashes,
});

const pad = (addr: string) => `0x${'0'.repeat(24)}${addr.replace(/^0x/, '').toLowerCase()}`;

describe('EVM sender', () => {
  const DEPOSIT = '0x' + 'd'.repeat(40);
  const RELAYER = '0x' + 'a'.repeat(40);
  const OWNER = '0x' + 'b'.repeat(40);
  const OTHER = '0x' + 'c'.repeat(40);
  const evmFetch = (opts: { receipt?: unknown; tx?: unknown } = {}) =>
    fakeFetch((_url, body) => {
      if (body.method === 'eth_getTransactionByHash') {
        return json({ result: opts.tx === undefined ? { from: RELAYER } : opts.tx });
      }
      return json({
        result:
          opts.receipt === undefined
            ? {
                logs: [
                  { topics: [`0x${TRANSFER_TOPIC}`, pad(OWNER), pad(DEPOSIT)] },
                  { topics: [`0x${TRANSFER_TOPIC}`, pad(OTHER), pad(OTHER)] }, // not to the deposit
                  { topics: ['0x' + '1'.repeat(64), pad(OTHER), pad(DEPOSIT)] }, // not a Transfer
                ],
              }
            : opts.receipt,
      });
    });

  it('screens tx.from plus every ERC-20 Transfer `from` into the deposit address', async () => {
    const { f, calls } = evmFetch();
    const r = new EvmSenderResolver(() => evmRpcUrls({}), f);
    await expect(r.resolve(input('base', ['0xh'], DEPOSIT))).resolves.toEqual([RELAYER, OWNER]);
    expect(calls.map((c) => [c.url, c.body.method])).toEqual([
      [DEFAULT_EVM_RPC_URLS.base, 'eth_getTransactionByHash'],
      [DEFAULT_EVM_RPC_URLS.base, 'eth_getTransactionReceipt'],
    ]);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed: unknown tx, missing receipt, HTTP error, no RPC → []', async () => {
    for (const opts of [{ tx: null }, { receipt: null }]) {
      const r = new EvmSenderResolver(() => evmRpcUrls({}), evmFetch(opts).f);
      await expect(r.resolve(input('eth', ['0x1'], DEPOSIT))).resolves.toEqual([]);
    }
    const down = new EvmSenderResolver(() => evmRpcUrls({}), fakeFetch(() => json({}, 503)).f);
    await expect(down.resolve(input('eth', ['0x1'], DEPOSIT))).resolves.toEqual([]);
    const { f, calls } = evmFetch();
    await expect(
      new EvmSenderResolver(() => evmRpcUrls({}), f).resolve(input('gnosis', ['0x1'], DEPOSIT)),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('one hash failing makes the whole lookup [] (never a partial list)', async () => {
    const { f } = fakeFetch((_url, body) => {
      const hash = (body.params as string[])[0];
      if (hash === '0xbad') return json({}, 500);
      return body.method === 'eth_getTransactionByHash'
        ? json({ result: { from: RELAYER } })
        : json({ result: { logs: [] } });
    });
    const r = new EvmSenderResolver(() => evmRpcUrls({}), f);
    await expect(r.resolve(input('eth', ['0xgood'], DEPOSIT))).resolves.toEqual([RELAYER]);
    await expect(r.resolve(input('eth', ['0xgood', '0xbad'], DEPOSIT))).resolves.toEqual([]);
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
  const DEPOSIT = 'Dep1111111111111111111111111111111111111111';
  const PAYER = 'Payer11111111111111111111111111111111111111';
  const SOL_SRC = 'SolSrc1111111111111111111111111111111111111';
  const AUTH = 'Auth111111111111111111111111111111111111111';
  const SRC_OWNER = 'Owner11111111111111111111111111111111111111';
  const DEP_ATA = 'DepAta11111111111111111111111111111111111111';
  const SRC_ATA = 'SrcAta11111111111111111111111111111111111111';

  it('screens the fee payer plus SOL and SPL transfer sources into the deposit address', async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        result: {
          transaction: {
            message: {
              accountKeys: [PAYER, DEP_ATA, SRC_ATA, DEPOSIT].map((pubkey) => ({ pubkey })),
              instructions: [
                {
                  program: 'system',
                  parsed: {
                    type: 'transfer',
                    info: { source: SOL_SRC, destination: DEPOSIT, lamports: 5 },
                  },
                },
                {
                  program: 'system',
                  parsed: { type: 'transfer', info: { source: 'Elsewhere', destination: 'X' } },
                },
              ],
            },
          },
          meta: {
            preTokenBalances: [{ accountIndex: 2, owner: SRC_OWNER, mint: 'M' }],
            postTokenBalances: [{ accountIndex: 1, owner: DEPOSIT, mint: 'M' }],
            innerInstructions: [
              {
                instructions: [
                  {
                    program: 'spl-token',
                    parsed: {
                      type: 'transferChecked',
                      info: { source: SRC_ATA, destination: DEP_ATA, authority: AUTH },
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    const r = new SolanaSenderResolver('https://sol.example', f);
    await expect(r.resolve(input('sol', ['SIG'], DEPOSIT))).resolves.toEqual([
      PAYER,
      SOL_SRC,
      AUTH,
      SRC_OWNER,
    ]);
    expect(calls[0]!.body).toMatchObject({
      method: 'getTransaction',
      params: ['SIG', expect.objectContaining({ encoding: 'jsonParsed' })],
    });
  });

  it('is [] for an unknown signature', async () => {
    const { f } = fakeFetch(() => json({ result: null }));
    await expect(
      new SolanaSenderResolver('https://sol.example', f).resolve(input('sol', ['SIG'], DEPOSIT)),
    ).resolves.toEqual([]);
  });
});

describe('Tron sender', () => {
  const OWNER = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
  const FROM_HEX = 'b'.repeat(40);
  const DEP_HEX = 'd'.repeat(40);
  const DEPOSIT = tronHexToBase58(`41${DEP_HEX}`);

  it('screens owner_address plus every TRC-20 Transfer `from` into the deposit address', async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith('gettransactionbyid')
        ? json({
            raw_data: {
              contract: [{ parameter: { value: { owner_address: OWNER, contract_address: 'T' } } }],
            },
          })
        : json({
            log: [
              { topics: [TRANSFER_TOPIC, '0'.repeat(24) + FROM_HEX, '0'.repeat(24) + DEP_HEX] },
              { topics: [TRANSFER_TOPIC, '0'.repeat(24) + 'e'.repeat(40), '0'.repeat(64)] },
            ],
          }),
    );
    const r = new TronSenderResolver('https://tron.example', f);
    await expect(r.resolve(input('tron', ['0xABCD'], DEPOSIT))).resolves.toEqual([
      OWNER,
      tronHexToBase58(`41${FROM_HEX}`),
    ]);
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['https://tron.example/wallet/gettransactionbyid', { value: 'ABCD', visible: true }],
      ['https://tron.example/wallet/gettransactioninfobyid', { value: 'ABCD' }],
    ]);
    expect(DEPOSIT).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('is [] for an unknown tx ({})', async () => {
    const { f } = fakeFetch(() => json({}));
    await expect(
      new TronSenderResolver('https://t.example', f).resolve(input('tron', ['ab'], DEPOSIT)),
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
  const scope = {
    livemode: true,
    parentAccountId: 'tendr.near',
    intentsContractId: 'intents.near',
  };

  it('NEAR: signer + delegate sender + ft_transfer source and predecessor into the deposit', async () => {
    const fake = new FakeNearClient(scope);
    const DEPOSIT = 'f'.repeat(64);
    fake.scriptTxStatus('H', {
      hash: 'H',
      signerId: 'relayer.near',
      receiverId: 'usdc.near',
      delegateSenderIds: ['shopper.near'],
      receipts: [
        {
          receiptId: 'r1',
          executorId: 'usdc.near',
          ok: true,
          predecessorId: 'wallet-contract.near',
          logs: [
            eventLog('nep141', '1.0.0', 'ft_transfer', [
              { old_owner_id: 'funds-owner.near', new_owner_id: DEPOSIT, amount: '5' },
            ]),
          ],
        },
        {
          receiptId: 'r2',
          executorId: 'usdc.near',
          ok: true,
          logs: [
            eventLog('nep141', '1.0.0', 'ft_transfer', [
              { old_owner_id: 'unrelated.near', new_owner_id: 'someone.near', amount: '5' },
            ]),
          ],
        },
      ],
    });
    const r = new NearSenderResolver(() => fake);
    await expect(r.resolve(input('near', ['H'], DEPOSIT, 'nep141:usdc.near'))).resolves.toEqual([
      'relayer.near',
      'shopper.near',
      'funds-owner.near',
      'wallet-contract.near',
    ]);
    expect(fake.calls[0]).toEqual({ kind: 'txStatus', hash: 'H', accountId: 'usdc.near' });
    // An unknown hash among them: [] (never partial).
    await expect(
      r.resolve(input('near', ['H', 'unknown'], DEPOSIT, 'nep141:usdc.near')),
    ).resolves.toEqual([]);
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
    const live = liveSenderResolvers(() => new FakeNearClient(scope), f);
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
