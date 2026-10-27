// The Pimlico paymaster proxy: the live path against a mocked Pimlico and a mocked chain RPC
// (never the real ones) on a test-mode session (quotes from the 1Click simulator), and the
// per-quote paymaster URL end to end in test mode.
import type { Merchant } from '@prisma/client';
import { AbiCoder, Interface, Wallet, toBeHex, zeroPadValue } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../../checkout/oneclick/index.js';
import { resetTokenCache } from '../../checkout/tokens.js';
import { pollDeposit, registerWatcherHooks } from '../../checkout/watcher.js';
import { scopedDb } from '../../db/scoped.js';
import { lossCapReached } from '../../gas/loss-cap.js';
import { putGasPolicy } from '../../gas/policy.js';
import { releaseStaleReservations } from '../../gas/quote-fee.js';
import { evmAddress, getKeyVault } from '../../keyvault/index.js';
import { newId } from '../../lib/ids.js';
import { prisma } from '../../lib/prisma.js';
import { getRedis } from '../../lib/redis.js';
import { fakeNearClient, resetNearClients } from '../../near/client.js';
import { clearSecretCache, putSecret } from '../../secrets/secrets.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../../test/helpers.js';
import { isolatedSimStore } from '../../test/sim-1click.js';
import { resetRelayers } from '../index.js';
import { SUBMITS_PER_ADDRESS_PER_HOUR, releaseEndedSessionReservations } from '../submissions.js';
import { resetAccountCache } from './accounts.js';
import {
  COINBASE_SMART_WALLET_FACTORIES,
  COINBASE_SMART_WALLET_IMPLEMENTATIONS,
  SAFE_4337_MODULES,
  SAFE_PROXY_RUNTIME_PREFIX,
  SAFE_SINGLETONS,
  SOLADY_ERC1967_PROXY_RUNTIME,
} from './known-accounts.js';
import {
  PAYMASTER_GIVE_UP_MS,
  PAYMASTER_VALIDITY_GRACE_MS,
  PaymasterProxy,
  PimlicoClient,
  SIMULATED_PAYMASTER,
  paymasterTokenHash,
  pimlicoValidUntil,
  pollPaymasterOps,
  resetPaymasters,
  setPaymaster,
  type JsonRpcResponse,
} from './pimlico.js';
import { EvmRpc } from './rpc.js';
import {
  ENTRY_POINT_V07,
  ENTRY_POINT_V08,
  SAFE_MULTISEND_CALL_ONLY,
  parseUserOp,
  userOpHash,
} from './user-op.js';

const sim1click = isolatedSimStore();
const USDC = 'nep141:usdc.test';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const KEY = 'pim_SUPERSECRETKEY123';
const PM = '0x777777777777aec03fd955926dbf81597e66834c';
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const GAS_PRICE = 10_000_000n; // 0.01 gwei
const SAFE_METADATA = 'a2646970667358221220' + 'ab'.repeat(32) + '64736f6c6343' + '000706' + '0033';

const erc20 = new Interface(['function transfer(address,uint256)']);
const accounts = new Interface([
  'function execute(bytes32 mode, bytes executionCalldata)',
  'function executeBatch((address,uint256,bytes)[] calls)',
  'function executeUserOp(address to, uint256 value, bytes data, uint8 operation)',
]);
type Call = { to: string; value: bigint; data: string };
const transfer = (to: string, amount: bigint | string): Call => ({
  to: TOKEN,
  value: 0n,
  data: erc20.encodeFunctionData('transfer', [to, BigInt(amount)]),
});
/** ERC-7579 batch `execute`. */
const batch7579 = (calls: Call[]) =>
  accounts.encodeFunctionData('execute', [
    '0x01' + '00'.repeat(31),
    AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,uint256,bytes)[]'],
      [calls.map((c) => [c.to, c.value, c.data])],
    ),
  ]);
/** Coinbase Smart Wallet `executeBatch`. */
const cbBatch = (calls: Call[]) =>
  accounts.encodeFunctionData('executeBatch', [calls.map((c) => [c.to, c.value, c.data])]);

/** Pimlico verifying-paymaster data: mode 0 | validUntil | validAfter | 65-byte signature. */
const pmData = (validUntil: number) =>
  '0x00' + validUntil.toString(16).padStart(12, '0') + '0'.repeat(12) + 'cd'.repeat(65);

type Req = { url: string; method: string; params: unknown[] };

/** A mocked Pimlico endpoint: records every request; answers per method. */
class FakePimlico {
  calls: Req[] = [];
  receipts = new Map<string, unknown>();
  fail: string | null = null;
  dataResult: Record<string, unknown> = {};
  fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    this.calls.push({ url: String(url), method: body.method, params: body.params });
    if (this.fail) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: this.fail } }),
      );
    }
    let result: unknown = null;
    if (body.method === 'pm_getPaymasterStubData') {
      result = {
        paymaster: PM,
        paymasterData: '0x01',
        paymasterVerificationGasLimit: '0x7530',
        paymasterPostOpGasLimit: '0x1',
        isFinal: true,
        extra: 'dropped',
      };
    } else if (body.method === 'pm_getPaymasterData') {
      result = this.dataResult;
    } else if (body.method === 'eth_getUserOperationReceipt') {
      result = this.receipts.get(String(body.params[0])) ?? null;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
}

/** A mocked chain RPC: account code, storage, `isModuleEnabled`, gas price. */
class FakeChain {
  code = new Map<string, string>();
  storage = new Map<string, string>();
  modules = new Set<string>();
  calls: string[] = [];
  down = false;
  fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    this.calls.push(body.method);
    if (this.down) throw new Error('connection refused');
    let result: unknown = null;
    const p = body.params as [string, string];
    if (body.method === 'eth_getCode') result = this.code.get(p[0].toLowerCase()) ?? '0x';
    else if (body.method === 'eth_getStorageAt') {
      result = this.storage.get(`${p[0].toLowerCase()}:${BigInt(p[1])}`) ?? '0x' + '0'.repeat(64);
    } else if (body.method === 'eth_call') {
      const { to, data } = body.params[0] as { to: string; data: string };
      const module = '0x' + data.slice(-40);
      result = zeroPadValue(
        this.modules.has(`${to.toLowerCase()}:${module}`) ? '0x01' : '0x00',
        32,
      );
    } else if (body.method === 'eth_gasPrice') result = toBeHex(GAS_PRICE);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  }) as typeof fetch;
  coinbase(address: string, impl = COINBASE_SMART_WALLET_IMPLEMENTATIONS[0]!) {
    this.code.set(address.toLowerCase(), SOLADY_ERC1967_PROXY_RUNTIME);
    this.storage.set(
      `${address.toLowerCase()}:${BigInt('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')}`,
      zeroPadValue(impl, 32),
    );
  }
  safe(address: string, opts: { module?: boolean } = {}) {
    this.code.set(address.toLowerCase(), SAFE_PROXY_RUNTIME_PREFIX + SAFE_METADATA);
    this.storage.set(`${address.toLowerCase()}:0`, zeroPadValue(SAFE_SINGLETONS[0]!, 32));
    if (opts.module !== false) this.modules.add(`${address.toLowerCase()}:${SAFE_4337_MODULES[0]}`);
  }
}

describe('Pimlico paymaster proxy', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let wallet: string;
  let pimlico: FakePimlico;
  let chain: FakeChain;
  let proxy: PaymasterProxy;
  let logs: string[];
  let validUntil: number;
  let PM_DATA: string;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    resetPaymasters();
    resetAccountCache();
    clearSecretCache();
    resetNearClients();
    fakeNearClient(false);
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Bean Shop', defaultGasPayer: 'merchant' });
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC,
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    await putGasPolicy(
      { merchantId: merchant.id, livemode: false, actor: { by: 'api_key', apiKeyId: 'key_x' } },
      { enabled: true },
    );
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    // The smart account's address (a fresh one per test: limits are keyed by address). By
    // default a Coinbase Smart Wallet on the mocked chain.
    wallet = (Wallet.createRandom() as unknown as Wallet).address;
    await putSecret(KEY, 'pimlico');
    pimlico = new FakePimlico();
    validUntil = Math.floor(Date.now() / 1000) + 30 * 60;
    PM_DATA = pmData(validUntil);
    pimlico.dataResult = { paymaster: PM, paymasterData: PM_DATA };
    chain = new FakeChain();
    chain.coinbase(wallet);
    // The key comes from the stored secret (purpose `pimlico`).
    proxy = new PaymasterProxy(true, {
      pimlico: new PimlicoClient({ fetch: pimlico.fetch }),
      rpc: (c) => new EvmRpc(c, 'http://rpc.test', chain.fetch),
      policyId: () => 'sp_tendr',
    });
  });
  afterEach(async () => {
    // The API key never reaches a log line.
    expect(logs.join('\n')).not.toContain(KEY);
    await app.close();
    vi.restoreAllMocks();
    resetTokenCache();
    resetOneClickProviders();
    resetRelayers();
    resetPaymasters();
    resetNearClients();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  async function newSession(gasPayer?: 'shopper') {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${testKey}` },
      payload: {
        amount: '25.00',
        amount_currency: 'USD',
        external_ref: `order-${Math.random().toString(36).slice(2)}`,
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
        ...(gasPayer ? { gas_payer: gasPayer } : {}),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; client_secret: string };
  }

  async function quoteOn(s: { id: string; client_secret: string }, gasPayer?: 'shopper') {
    const qr = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${s.client_secret}` },
      payload: { origin_asset: USDC_BASE, wallet_address: wallet, gasless_method: 'paymaster' },
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: qr.json().id } });
    const scope = { merchantId: merchant.id, livemode: false };
    const ctx = { ...scope, db: scopedDb(scope), sessionId: s.id };
    const feeTo = evmAddress((await getKeyVault().publicKey('gas-fees-evm')).raw);
    const payment = transfer(quote.depositAddress, quote.amountIn.toFixed(0));
    const fee = quote.networkFeeAmount ? transfer(feeTo, quote.networkFeeAmount.toFixed(0)) : null;
    const calls = gasPayer === 'shopper' ? [payment, fee!] : [payment];
    return { s, ctx, quote, calls, payment, fee, feeTo };
  }

  /** A `paymaster` quote for the smart wallet; the merchant sponsors unless `shopper`. */
  async function paymasterQuote(gasPayer?: 'shopper') {
    return quoteOn(await newSession(gasPayer), gasPayer);
  }

  function userOp(callData: string, over: Record<string, unknown> = {}) {
    return {
      sender: wallet,
      nonce: '0x0',
      callData,
      callGasLimit: toBeHex(100_000n),
      verificationGasLimit: toBeHex(150_000n),
      preVerificationGas: toBeHex(50_000n),
      maxFeePerGas: toBeHex(GAS_PRICE),
      maxPriorityFeePerGas: toBeHex(1_000_000n),
      paymaster: PM,
      paymasterVerificationGasLimit: '0x7530',
      paymasterPostOpGasLimit: '0x1',
      paymasterData: '0x01',
      signature: '0x' + 'ff'.repeat(65),
      ...over,
    };
  }

  const rpc = (method: string, op: unknown, extra: unknown[] = [], ep = ENTRY_POINT_V07) => ({
    jsonrpc: '2.0',
    id: 7,
    method,
    params: [op, ep, '0x2105', ...extra],
  });

  type Q = Awaited<ReturnType<typeof paymasterQuote>>;
  const ask = (p: Pick<Q, 'ctx' | 'quote'>, body: unknown) => proxy.handle(p.ctx, body, p.quote.id);

  const errorOf = (r: JsonRpcResponse) => ('error' in r ? r.error : null);
  const resultOf = (r: JsonRpcResponse) => {
    if ('error' in r) throw new Error(`unexpected error ${JSON.stringify(r.error)}`);
    return r.result as Record<string, unknown>;
  };
  const month = () =>
    prisma.gasBudgetMonth.findFirstOrThrow({ where: { merchantId: merchant.id } });
  const client = () => new PimlicoClient({ fetch: pimlico.fetch });

  function transferLog(from: string, to: string, amount: bigint) {
    return {
      address: TOKEN,
      topics: [TRANSFER_TOPIC0, zeroPadValue(from, 32), zeroPadValue(to.toLowerCase(), 32)],
      data: zeroPadValue(toBeHex(amount), 32),
    };
  }
  const receipt = (
    cost: bigint,
    used: bigint,
    success = true,
    logs: unknown[] = [],
    tx = 'ab',
  ) => ({
    success,
    actualGasCost: toBeHex(cost),
    actualGasUsed: toBeHex(used),
    logs,
    receipt: { transactionHash: '0x' + tx.repeat(32) },
  });

  it('forwards a sponsored payment and records the submission at pm_getPaymasterData', async () => {
    const p = await paymasterQuote();
    const op = userOp(cbBatch(p.calls));

    const stub = resultOf(
      await ask(p, rpc('pm_getPaymasterStubData', op, [{ sponsorshipPolicyId: 'evil' }])),
    );
    // Pimlico's isFinal is never passed on: the wallet must come back for pm_getPaymasterData.
    expect(stub).toEqual({
      paymaster: PM,
      paymasterData: '0x01',
      paymasterVerificationGasLimit: '0x7530',
      paymasterPostOpGasLimit: '0x1',
      isFinal: false,
    });
    expect(
      (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: p.quote.gasSponsorshipId! } }))
        .quoteId,
    ).toBeNull();

    const res = await ask(p, rpc('pm_getPaymasterData', op));
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { paymaster: PM, paymasterData: PM_DATA },
    });
    expect(JSON.stringify(res)).not.toContain(KEY);

    expect(pimlico.calls.map((c) => c.method)).toEqual([
      'pm_getPaymasterStubData',
      'pm_getPaymasterData',
    ]);
    for (const c of pimlico.calls) {
      expect(c.url).toBe(`https://api.pimlico.io/v2/8453/rpc?apikey=${KEY}`);
      expect(c.params.slice(1)).toEqual([
        ENTRY_POINT_V07,
        '0x2105',
        { sponsorshipPolicyId: 'sp_tendr' },
      ]);
    }
    // The account code was checked on chain, and the gas price.
    expect(chain.calls).toContain('eth_getCode');
    expect(chain.calls).toContain('eth_gasPrice');

    const sp = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: p.quote.gasSponsorshipId! },
    });
    const expectedHash = userOpHash(
      parseUserOp({ ...op, paymasterData: PM_DATA }),
      ENTRY_POINT_V07,
      8453,
    );
    expect(sp).toMatchObject({
      quoteId: p.quote.id,
      method: 'paymaster',
      provider: 'pimlico',
      sponsor: 'merchant',
      status: 'submitted',
      reservationState: 'reserved',
      signerAddress: wallet.toLowerCase(),
      userOpHash: expectedHash,
    });
    expect(sp.paymasterData).toMatchObject({ validUntil, hashes: [expectedHash], nonce: '0x0' });
  });

  describe('refuses anything but the quoted payment, without calling Pimlico', () => {
    const cases: [string, (p: Q) => unknown][] = [
      [
        'another recipient',
        (p) => userOp(cbBatch([transfer(wallet, p.quote.amountIn.toFixed(0))])),
      ],
      [
        'another amount',
        (p) =>
          userOp(
            cbBatch([transfer(p.quote.depositAddress, BigInt(p.quote.amountIn.toFixed(0)) - 1n)]),
          ),
      ],
      ['an extra call appended', (p) => userOp(cbBatch([...p.calls, transfer(wallet, 1n)]))],
      ['native value on the call', (p) => userOp(cbBatch([{ ...p.payment, value: 1n }]))],
      ['another token', (p) => userOp(cbBatch([{ ...p.payment, to: '0x' + '11'.repeat(20) }]))],
      ['another sender', (p) => userOp(cbBatch(p.calls), { sender: '0x' + '22'.repeat(20) })],
      ['an unknown account format', () => userOp('0x47e1da2a' + '00'.repeat(96))],
      [
        'a Safe delegatecall to something other than MultiSendCallOnly',
        (p) =>
          userOp(
            accounts.encodeFunctionData('executeUserOp', [
              '0x' + '33'.repeat(20),
              0n,
              p.payment.data,
              1,
            ]),
          ),
      ],
      [
        'an EIP-7702 authorization',
        (p) => userOp(cbBatch(p.calls), { eip7702Auth: { address: wallet, chainId: '0x2105' } }),
      ],
      [
        'a v0.6 user operation',
        (p) => ({ ...userOp(cbBatch(p.calls)), initCode: '0x', paymasterAndData: '0x' }),
      ],
    ];
    for (const [name, build] of cases) {
      it(name, async () => {
        const p = await paymasterQuote();
        for (const method of ['pm_getPaymasterStubData', 'pm_getPaymasterData']) {
          const err = errorOf(await ask(p, rpc(method, build(p))));
          expect(err?.code, name).toBeOneOf([-32001, -32602]);
        }
        expect(pimlico.calls).toEqual([]);
        const sp = await prisma.gasSponsorship.findUniqueOrThrow({
          where: { id: p.quote.gasSponsorshipId! },
        });
        expect(sp.quoteId).toBeNull();
        // Refused operations do not count against the wallet's limit.
        const key = `tendr:gasless:submit:addr:${wallet.toLowerCase()}:${Math.floor(Date.now() / 3_600_000)}`;
        expect(await getRedis().get(key)).toBeNull();
      });
    }

    it('another chain, another entry point, or an unknown method', async () => {
      const p = await paymasterQuote();
      const op = userOp(cbBatch(p.calls));
      const wrongChain = {
        ...rpc('pm_getPaymasterData', op),
        params: [op, ENTRY_POINT_V07, '0x1'],
      };
      expect(errorOf(await ask(p, wrongChain))).toMatchObject({
        code: -32001,
        data: { code: 'GASLESS_PAYLOAD_MISMATCH', field: 'chainId' },
      });
      const v06 = rpc('pm_getPaymasterData', op, [], '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789');
      expect(errorOf(await ask(p, v06))?.code).toBe(-32602);
      expect(errorOf(await ask(p, rpc('pm_sponsorUserOperation', op)))).toMatchObject({
        code: -32601,
      });
      expect(errorOf(await ask(p, { hello: 1 }))?.code).toBe(-32600);
      expect(pimlico.calls).toEqual([]);
    });

    it('a quote for another method is not sponsored', async () => {
      const s = await newSession();
      const qr = await app.inject({
        method: 'POST',
        url: '/v1/checkout/client/quote',
        headers: { authorization: `Bearer ${s.client_secret}` },
        payload: { origin_asset: USDC_BASE, wallet_address: wallet, gasless_method: 'eip3009' },
      });
      const quote = await prisma.quote.findUniqueOrThrow({ where: { id: qr.json().id } });
      const scope = { merchantId: merchant.id, livemode: false };
      const ctx = { ...scope, db: scopedDb(scope), sessionId: s.id };
      const op = userOp(cbBatch([transfer(quote.depositAddress, quote.amountIn.toFixed(0))]));
      expect(errorOf(await ask({ ctx, quote }, rpc('pm_getPaymasterData', op)))).toMatchObject({
        code: -32001,
        data: { code: 'GASLESS_NOT_AVAILABLE' },
      });
      expect(pimlico.calls).toEqual([]);
    });

    it('gas limits or fees that would cost far more than the quote', async () => {
      const p = await paymasterQuote();
      const op = userOp(cbBatch(p.calls), { callGasLimit: toBeHex(100_000_000_000n) });
      expect(errorOf(await ask(p, rpc('pm_getPaymasterData', op)))).toMatchObject({
        code: -32001,
        data: { field: 'gas' },
      });
      expect(pimlico.calls).toEqual([]);
    });

    it('gas fees above twice the live gas price (I1-c)', async () => {
      const p = await paymasterQuote();
      for (const over of [
        { maxFeePerGas: toBeHex(GAS_PRICE * 2n + 1n) },
        {
          maxPriorityFeePerGas: toBeHex(GAS_PRICE * 2n + 1n),
          maxFeePerGas: toBeHex(GAS_PRICE * 2n + 1n),
        },
      ]) {
        expect(
          errorOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls), over)))),
        ).toMatchObject({
          code: -32001,
          data: { field: 'gas' },
        });
      }
      // At exactly twice: accepted.
      resultOf(
        await ask(
          p,
          rpc(
            'pm_getPaymasterData',
            userOp(cbBatch(p.calls), { maxFeePerGas: toBeHex(GAS_PRICE * 2n) }),
          ),
        ),
      );
    });
  });

  describe('known smart-account code only (I1-b)', () => {
    it('unknown code, another Coinbase implementation, or an EOA: refused before Pimlico', async () => {
      const p = await paymasterQuote();
      const op = userOp(cbBatch(p.calls));
      for (const setup of [
        () => chain.code.set(wallet.toLowerCase(), '0x6080604052'),
        () => chain.coinbase(wallet, '0x' + '44'.repeat(20)),
        () => chain.code.delete(wallet.toLowerCase()),
      ]) {
        resetAccountCache();
        setup();
        for (const m of ['pm_getPaymasterStubData', 'pm_getPaymasterData']) {
          expect(errorOf(await ask(p, rpc(m, op)))?.code).toBe(-32602);
        }
      }
      expect(pimlico.calls).toEqual([]);
    });

    it('the call format must match the verified account (a Coinbase wallet sending 7579 calls)', async () => {
      const p = await paymasterQuote();
      expect(
        errorOf(await ask(p, rpc('pm_getPaymasterData', userOp(batch7579(p.calls)))))?.code,
      ).toBe(-32602);
      expect(pimlico.calls).toEqual([]);
    });

    it('a Safe with the 4337 module enabled is sponsored; without it, refused', async () => {
      const p = await paymasterQuote();
      chain.code.clear();
      chain.storage.clear();
      chain.safe(wallet, { module: false });
      const multi = new Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [
        '0x00' +
          p.payment.to.slice(2) +
          '00'.repeat(32) +
          zeroPadValue(toBeHex((p.payment.data.length - 2) / 2), 32).slice(2) +
          p.payment.data.slice(2),
      ]);
      const single = userOp(
        accounts.encodeFunctionData('executeUserOp', [p.payment.to, 0n, p.payment.data, 0]),
      );
      expect(errorOf(await ask(p, rpc('pm_getPaymasterStubData', single)))?.code).toBe(-32602);
      chain.modules.add(`${wallet.toLowerCase()}:${SAFE_4337_MODULES[0]}`);
      resetAccountCache();
      resultOf(await ask(p, rpc('pm_getPaymasterStubData', single)));
      const batched = userOp(
        accounts.encodeFunctionData('executeUserOp', [SAFE_MULTISEND_CALL_ONLY[0]!, 0n, multi, 1]),
      );
      resultOf(await ask(p, rpc('pm_getPaymasterData', batched)));
    });

    it('counterfactual: only the known Coinbase factory', async () => {
      const p = await paymasterQuote();
      chain.code.delete(wallet.toLowerCase());
      const factoryData = '0x3ffba36f' + '00'.repeat(64);
      const bad = userOp(cbBatch(p.calls), { factory: '0x' + '55'.repeat(20), factoryData });
      expect(errorOf(await ask(p, rpc('pm_getPaymasterData', bad)))?.code).toBe(-32602);
      const good = userOp(cbBatch(p.calls), {
        factory: COINBASE_SMART_WALLET_FACTORIES[0],
        factoryData,
        // A deployment needs more verification gas.
        verificationGasLimit: toBeHex(400_000n),
      });
      resultOf(await ask(p, rpc('pm_getPaymasterData', good)));
    });

    it('the chain RPC down: unavailable, nothing sponsored', async () => {
      const p = await paymasterQuote();
      chain.down = true;
      expect(
        errorOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls))))),
      ).toMatchObject({
        code: -32603,
        data: { code: 'PROVIDER_UNAVAILABLE' },
      });
      expect(pimlico.calls).toEqual([]);
    });
  });

  it('unrecovered cost (I1-d) counts toward the daily loss cap', async () => {
    const p = await paymasterQuote();
    expect(await lossCapReached(false, new Date())).toBe(false);
    await prisma.gasSponsorship.create({
      data: {
        id: newId('gas'),
        merchantId: merchant.id,
        livemode: false,
        sessionId: p.s.id,
        chain: 'base',
        method: 'paymaster',
        provider: 'pimlico',
        sponsor: 'merchant',
        status: 'confirmed',
        costUsd: '1000',
        unrecoveredUsd: '999',
        unrecoveredAt: new Date(),
      },
    });
    expect(await lossCapReached(false, new Date())).toBe(true);
  });

  it('the daily loss cap stops paymaster sponsorship in both modes (I1-a)', async () => {
    const sponsored = await paymasterQuote();
    const paying = await paymasterQuote('shopper');
    await prisma.gasSponsorship.create({
      data: {
        id: newId('gas'),
        merchantId: merchant.id,
        livemode: false,
        sessionId: sponsored.s.id,
        chain: 'base',
        method: 'paymaster',
        provider: 'pimlico',
        sponsor: 'tendr',
        status: 'failed',
        costUsd: '1000',
        lossRecognizedAt: new Date(),
      },
    });
    for (const p of [sponsored, paying]) {
      for (const m of ['pm_getPaymasterStubData', 'pm_getPaymasterData']) {
        expect(errorOf(await ask(p, rpc(m, userOp(cbBatch(p.calls)))))).toMatchObject({
          code: -32001,
          data: { code: 'GASLESS_NOT_AVAILABLE' },
        });
      }
    }
    expect(pimlico.calls).toEqual([]);
  });

  describe("Pimlico's signature validity (I2)", () => {
    it('decodes validUntil from verifying-mode paymaster data only', () => {
      expect(pimlicoValidUntil(pmData(1_900_000_000))).toBe(1_900_000_000);
      expect(pimlicoValidUntil('0x02' + pmData(1).slice(4))).toBeNull(); // another mode
      expect(pimlicoValidUntil('0x01')).toBeNull();
    });

    it('beyond the give-up horizon, unset or unreadable: refused, nothing recorded', async () => {
      const p = await paymasterQuote();
      const horizon = Math.floor((p.quote.deadline.getTime() + PAYMASTER_GIVE_UP_MS) / 1000);
      for (const data of [pmData(horizon + 1), pmData(0), '0xabcdef']) {
        pimlico.dataResult = { paymaster: PM, paymasterData: data };
        expect(
          errorOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls))))),
        ).toMatchObject({
          code: -32603,
        });
      }
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: p.quote.gasSponsorshipId! },
      });
      expect(sp.quoteId).toBeNull();
    });

    it('given up only once validUntil has passed', async () => {
      const p = await paymasterQuote();
      resultOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls)))));
      const id = p.quote.gasSponsorshipId!;
      const at = (ms: number) => () => new Date(ms);
      const end = validUntil * 1000 + PAYMASTER_VALIDITY_GRACE_MS;
      expect(
        await pollPaymasterOps({ pimlico: client(), livemode: false, now: at(end - 1000) }),
      ).toBe(0);
      expect(
        await pollPaymasterOps({ pimlico: client(), livemode: false, now: at(end + 1000) }),
      ).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
      expect(sp).toMatchObject({ status: 'failed', reservationState: 'reserved' });
      expect(sp.gasUsed).toBeNull();
      // The stale-quote sweep may now release it: no loss.
      expect(await releaseStaleReservations(new Date(end + 1000))).toBe(1);
      const released = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
      expect(released).toMatchObject({ reservationState: 'released', sponsor: 'merchant' });
      expect(released.lossRecognizedAt).toBeNull();
    });
  });

  it('shopper pays in the token: the fee transfer is required exactly; revenue from the receipt', async () => {
    const p = await paymasterQuote('shopper');
    expect(p.quote.networkFeePaidBy).toBe('buyer');
    for (const calls of [
      [p.payment],
      [p.payment, transfer(p.feeTo, BigInt(p.quote.networkFeeAmount!.toFixed(0)) - 1n)],
      [p.fee!, p.payment],
    ]) {
      expect(errorOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(calls)))))?.code).toBe(
        -32001,
      );
    }
    expect(pimlico.calls).toEqual([]);

    resultOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls)))));
    const sp = await prisma.gasSponsorship.findFirstOrThrow({
      where: { quoteId: p.quote.id, sponsor: 'shopper' },
    });
    expect(sp).toMatchObject({
      method: 'paymaster',
      provider: 'pimlico',
      status: 'submitted',
      feeMode: 'token',
    });

    // Mined, costing $0.22: fee revenue from the operation's own Transfer to gas-fees-evm
    // (capped at the fee), and the cost above the fee's value is an unrecovered loss.
    const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
    pimlico.receipts.set(
      sp.userOpHash!,
      receipt(88_000_000_000_000n, 150_000n, true, [
        transferLog(wallet, p.quote.depositAddress, BigInt(p.quote.amountIn.toFixed(0))),
        transferLog(wallet, p.feeTo, fee + 5n),
      ]),
    );
    expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(1);
    const done = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } });
    expect(done).toMatchObject({
      status: 'confirmed',
      txHash: '0x' + 'ab'.repeat(32),
      sponsor: 'shopper',
    });
    expect(done.feeCollected!.toFixed()).toBe(fee.toString());
    expect(done.costUsd!.toFixed()).toBe('0.22');
    expect(done.unrecoveredUsd!.toFixed()).toBe(done.costUsd!.minus(done.estimateUsd!).toFixed());
    expect(done.unrecoveredAt).not.toBeNull();

    await sim.simulate(p.quote.depositAddress, 'exact', { senderAddress: wallet });
    await pollDeposit(p.quote.depositAddress, { livemode: false });
    const pay = await prisma.payment.findFirstOrThrow({ where: { quoteId: p.quote.id } });
    const rev = await prisma.revenueEntry.findMany({
      where: { paymentId: pay.id, reference: sp.id },
    });
    expect(rev.map((r) => [r.source, r.amount.toFixed()])).toEqual([
      ['gas_reimbursement', fee.toString()],
    ]);
  });

  describe('the same quote again', () => {
    it('the same operation gets the same data; another nonce is refused while in flight', async () => {
      const p = await paymasterQuote();
      const op = userOp(cbBatch(p.calls));
      const first = resultOf(await ask(p, rpc('pm_getPaymasterData', op)));
      pimlico.dataResult = { paymaster: PM, paymasterData: pmData(validUntil - 60) };
      const again = resultOf(
        await ask(p, rpc('pm_getPaymasterData', { ...op, paymasterData: PM_DATA })),
      );
      expect(again).toEqual(first);
      expect(pimlico.count('pm_getPaymasterData')).toBe(1);

      const other = userOp(cbBatch(p.calls), { nonce: '0x1' });
      expect(errorOf(await ask(p, rpc('pm_getPaymasterData', other)))).toMatchObject({
        code: -32001,
        data: { code: 'CONFLICT' },
      });
      expect(pimlico.count('pm_getPaymasterData')).toBe(1);
    });

    it('the same sender and nonce with re-estimated gas replaces it; every hash is polled', async () => {
      const p = await paymasterQuote();
      const op = userOp(cbBatch(p.calls));
      resultOf(await ask(p, rpc('pm_getPaymasterData', op)));
      const id = p.quote.gasSponsorshipId!;
      const firstHash = (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } }))
        .userOpHash!;
      const PM_DATA2 = pmData(validUntil - 60);
      pimlico.dataResult = { paymaster: PM, paymasterData: PM_DATA2 };
      const reEstimated = { ...op, callGasLimit: toBeHex(120_000n) };
      expect(resultOf(await ask(p, rpc('pm_getPaymasterData', reEstimated)))).toEqual({
        paymaster: PM,
        paymasterData: PM_DATA2,
      });
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
      const secondHash = userOpHash(
        parseUserOp({ ...reEstimated, paymasterData: PM_DATA2 }),
        ENTRY_POINT_V07,
        8453,
      );
      expect(sp.userOpHash).toBe(secondHash);
      expect(sp.paymasterData).toMatchObject({ hashes: [firstHash, secondHash] });

      // The first one is what landed.
      pimlico.receipts.set(firstHash, receipt(88_000_000_000_000n, 150_000n));
      expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(1);
      expect(await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'confirmed',
        userOpHash: firstHash,
      });
    });
  });

  it('a released sponsorship is refused', async () => {
    const p = await paymasterQuote();
    await prisma.gasSponsorship.update({
      where: { id: p.quote.gasSponsorshipId! },
      data: { reservationState: 'released' },
    });
    expect(
      errorOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls))))),
    ).toMatchObject({
      code: -32001,
      data: { code: 'SPONSORSHIP_RELEASED' },
    });
    expect(pimlico.calls).toEqual([]);
  });

  it('Pimlico refusing: an error without its message or the key, nothing recorded', async () => {
    const p = await paymasterQuote();
    pimlico.fail = `policy rejected for apikey=${KEY} ${encodeURIComponent(KEY)}`;
    const res = await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls))));
    expect(errorOf(res)).toMatchObject({ code: -32603, data: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(
      (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: p.quote.gasSponsorshipId! } }))
        .quoteId,
    ).toBeNull();
  });

  it('rate limits: counted after validation, per wallet', async () => {
    const p = await paymasterQuote();
    const key = `tendr:gasless:submit:addr:${wallet.toLowerCase()}:${Math.floor(Date.now() / 3_600_000)}`;
    await getRedis().set(key, String(SUBMITS_PER_ADDRESS_PER_HOUR), 'EX', 3600);
    expect(
      errorOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls))))),
    ).toMatchObject({
      code: -32005,
      data: { code: 'RATE_LIMITED' },
    });
    expect(pimlico.calls).toEqual([]);
    await getRedis().del(key);
  });

  it('EntryPoint v0.8 operations are sponsored and hashed as v0.8', async () => {
    const p = await paymasterQuote();
    const op = userOp(cbBatch(p.calls));
    resultOf(await ask(p, rpc('pm_getPaymasterData', op, [], ENTRY_POINT_V08)));
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: p.quote.gasSponsorshipId! },
    });
    expect(sp.userOpHash).toBe(
      userOpHash(parseUserOp({ ...op, paymasterData: PM_DATA }), ENTRY_POINT_V08, 8453),
    );
  });

  it('paymaster gas limits missing everywhere: refused', async () => {
    const p = await paymasterQuote();
    const op = userOp(cbBatch(p.calls), {
      paymasterVerificationGasLimit: undefined,
      paymasterPostOpGasLimit: undefined,
    });
    expect(errorOf(await ask(p, rpc('pm_getPaymasterData', op)))?.code).toBe(-32602);
  });

  describe('outcomes (polled from Pimlico)', () => {
    it('mined: confirmed with its cost (above the estimate: unrecovered); settled at collection', async () => {
      const p = await paymasterQuote();
      resultOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls)))));
      let sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: p.quote.gasSponsorshipId! },
      });
      expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(0);
      expect(
        await releaseStaleReservations(new Date(p.quote.deadline.getTime() + 10 * 60_000)),
      ).toBe(0);
      pimlico.receipts.set(sp.userOpHash!, receipt(88_000_000_000_000n, 150_000n, true, [], 'cd'));
      expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(1);
      sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } });
      expect(sp).toMatchObject({
        status: 'confirmed',
        reservationState: 'reserved',
        sponsor: 'merchant',
      });
      expect(sp.costUsd!.toFixed()).toBe('0.22');
      // The merchant is charged the estimate; Tendr loses the rest.
      expect(sp.unrecoveredUsd!.toFixed()).toBe(sp.costUsd!.minus(sp.estimateUsd!).toFixed());
      expect((await month()).spentUsd.toFixed()).toBe('0');

      await sim.simulate(p.quote.depositAddress, 'exact', { senderAddress: wallet });
      await pollDeposit(p.quote.depositAddress, { livemode: false });
      const pay = await prisma.payment.findFirstOrThrow({ where: { quoteId: p.quote.id } });
      sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } });
      expect(sp).toMatchObject({ reservationState: 'settled', recoveredFromPaymentId: pay.id });
      expect((await month()).spentUsd.toFixed()).toBe(p.quote.networkFeeUsd!.toFixed());
    });

    it('reverted then the session expires: released, the gas is a Tendr loss', async () => {
      const p = await paymasterQuote();
      resultOf(await ask(p, rpc('pm_getPaymasterData', userOp(cbBatch(p.calls)))));
      const id = p.quote.gasSponsorshipId!;
      const hash = (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } })).userOpHash!;
      pimlico.receipts.set(hash, receipt(44_000_000_000_000n, 90_000n, false, [], 'ef'));
      await prisma.session.update({ where: { id: p.s.id }, data: { status: 'EXPIRED' } });
      expect(await releaseEndedSessionReservations()).toBe(0);
      expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(1);
      expect(await releaseEndedSessionReservations()).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
      expect(sp).toMatchObject({
        status: 'failed',
        reservationState: 'released',
        sponsor: 'tendr',
      });
      expect(sp.costUsd!.toFixed()).toBe('0.11');
      expect(sp.lossRecognizedAt).not.toBeNull();
    });
  });

  describe('per-quote paymaster URL (ruling T6-f, test mode)', () => {
    async function prepared(gasPayer?: 'shopper') {
      const p = await paymasterQuote(gasPayer);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/checkout/client/gasless/prepare',
        headers: { authorization: `Bearer ${p.s.client_secret}` },
        payload: { quote_id: p.quote.id },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { paymaster_url: string; calls: { to: string; data: string }[] };
      const path = new URL(body.paymaster_url).pathname;
      return { ...p, body, path, token: path.split('/').pop()! };
    }
    const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: path,
        headers,
        payload: payload as Record<string, unknown>,
      });

    it('prepare returns the calls and the URL; the wallet calls it with no secret; simulated, mined, paid', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      // A test-mode token never reaches the live proxy.
      const live = new PaymasterProxy(true, {});
      const liveSpy = vi.spyOn(live, 'handle');
      setPaymaster(true, live);
      const p = await prepared();
      expect(p.body).toMatchObject({ method: 'paymaster', to_sign: [], fee_amount: '0' });
      expect(p.body.calls).toEqual([
        { to: TOKEN, value: '0x0', data: p.payment.data.toLowerCase() },
      ]);
      expect(p.path).toMatch(/^\/v1\/checkout\/paymaster\/[A-Za-z0-9_-]{43}$/);
      // Stored hashed only.
      const q = await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } });
      expect(q.paymasterTokenHash).toBe(paymasterTokenHash(p.token));
      expect(JSON.stringify(q)).not.toContain(p.token);

      const op = userOp(cbBatch(p.calls));
      const stub = await post(p.path, rpc('pm_getPaymasterStubData', op), {
        origin: 'https://keys.coinbase.com',
      });
      expect(stub.statusCode).toBe(200);
      expect(stub.headers['access-control-allow-origin']).toBe('*');
      expect(stub.json().result).toMatchObject({ paymaster: SIMULATED_PAYMASTER, isFinal: false });
      const data = await post(p.path, rpc('pm_getPaymasterData', op));
      expect(data.json().result.paymaster).toBe(SIMULATED_PAYMASTER);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: p.quote.gasSponsorshipId! },
      });
      expect(sp).toMatchObject({ status: 'confirmed', method: 'paymaster', provider: 'pimlico' });

      expect(await prisma.payment.count()).toBe(0);
      await pollDeposit(p.quote.depositAddress, { livemode: false });
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { quoteId: p.quote.id } })).status,
      ).toBe('SETTLED');

      const unknown = await post(p.path, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      });
      expect(unknown.json()).toMatchObject({ id: 1, error: { code: -32601 } });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(liveSpy).not.toHaveBeenCalled();
      // The capability never reaches a log line.
      expect(logs.join('\n')).not.toContain(p.token);
    });

    it('CORS preflight from any origin, without credentials', async () => {
      const p = await prepared();
      const res = await app.inject({
        method: 'OPTIONS',
        url: p.path,
        headers: {
          origin: 'https://wallet.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-headers']).toContain('content-type');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('an unknown, malformed or stale token is 401; nothing is called', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const p = await prepared();
      const op = userOp(cbBatch(p.calls));
      for (const bad of [
        'A'.repeat(43),
        'short',
        p.token.slice(0, 42) + (p.token.endsWith('A') ? 'B' : 'A'),
      ]) {
        const res = await post(`/v1/checkout/paymaster/${bad}`, rpc('pm_getPaymasterData', op));
        expect(res.statusCode).toBe(401);
      }
      // A second prepare issues a new URL: the old one stops working.
      const again = await app.inject({
        method: 'POST',
        url: '/v1/checkout/client/gasless/prepare',
        headers: { authorization: `Bearer ${p.s.client_secret}` },
        payload: { quote_id: p.quote.id },
      });
      expect(again.statusCode).toBe(200);
      expect((await post(p.path, rpc('pm_getPaymasterStubData', op))).statusCode).toBe(401);
      // The client secret does not open the paymaster URL either (it is not the credential).
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await prisma.gasSponsorship.count({ where: { quoteId: { not: null } } })).toBe(0);
    });

    it("a token is bound to its quote: another quote's calls are refused", async () => {
      const a = await prepared();
      const b = await paymasterQuote();
      const res = await post(a.path, rpc('pm_getPaymasterData', userOp(cbBatch(b.calls))));
      expect(res.json().error).toMatchObject({
        code: -32001,
        data: { code: 'GASLESS_PAYLOAD_MISMATCH' },
      });
      expect(await prisma.gasSponsorship.count({ where: { quoteId: { not: null } } })).toBe(0);
    });

    it('the quote superseded by a re-quote: refused, the newer quote is not used', async () => {
      const p = await prepared();
      const newer = await quoteOn(p.s);
      expect(newer.quote.id).not.toBe(p.quote.id);
      for (const calls of [p.calls, newer.calls]) {
        const res = await post(p.path, rpc('pm_getPaymasterData', userOp(cbBatch(calls))));
        expect(res.json().error.data.code).toBe('QUOTE_EXPIRED');
      }
    });

    it('per-token limit', async () => {
      const p = await prepared();
      await getRedis().set(
        `tendr:gasless:pm-url:tok:${paymasterTokenHash(p.token)}`,
        '40',
        'EX',
        60,
      );
      const res = await post(p.path, rpc('pm_getPaymasterStubData', userOp(cbBatch(p.calls))));
      expect(res.json().error).toMatchObject({ code: -32005, data: { code: 'RATE_LIMITED' } });
    });

    it('a paymaster quote for a token off the allow-list is refused at quote time', async () => {
      const s = await newSession();
      const qr = await app.inject({
        method: 'POST',
        url: '/v1/checkout/client/quote',
        headers: { authorization: `Bearer ${s.client_secret}` },
        payload: {
          origin_asset: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
          wallet_address: wallet,
          gasless_method: 'paymaster',
        },
      });
      expect(qr.statusCode, qr.body).toBe(400);
    });
  });
});
