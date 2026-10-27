// The Pimlico paymaster proxy: the live path against a mocked Pimlico (never the real one) on a
// test-mode session (quotes from the 1Click simulator), and the test-mode route end to end.
import type { Merchant } from '@prisma/client';
import { AbiCoder, Interface, Wallet, toBeHex, zeroPadValue } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../../checkout/oneclick/index.js';
import { resetTokenCache } from '../../checkout/tokens.js';
import { pollDeposit, registerWatcherHooks } from '../../checkout/watcher.js';
import { scopedDb } from '../../db/scoped.js';
import { putGasPolicy } from '../../gas/policy.js';
import { releaseStaleReservations } from '../../gas/quote-fee.js';
import { evmAddress, getKeyVault } from '../../keyvault/index.js';
import { prisma } from '../../lib/prisma.js';
import { getRedis } from '../../lib/redis.js';
import { fakeNearClient, resetNearClients } from '../../near/client.js';
import { clearSecretCache, putSecret } from '../../secrets/secrets.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../../test/helpers.js';
import { isolatedSimStore } from '../../test/sim-1click.js';
import { resetRelayers } from '../index.js';
import { SUBMITS_PER_ADDRESS_PER_HOUR, releaseEndedSessionReservations } from '../submissions.js';
import {
  PAYMASTER_GIVE_UP_MS,
  PaymasterProxy,
  PimlicoClient,
  SIMULATED_PAYMASTER,
  pollPaymasterOps,
  resetPaymasters,
  type JsonRpcResponse,
} from './pimlico.js';
import { ENTRY_POINT_V07, ENTRY_POINT_V08, userOpHash, parseUserOp } from './user-op.js';

const sim1click = isolatedSimStore();
const USDC = 'nep141:usdc.test';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const KEY = 'pim_SUPERSECRETKEY123';
const PM = '0x777777777777aec03fd955926dbf81597e66834c';
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const erc20 = new Interface(['function transfer(address,uint256)']);
const accounts = new Interface([
  'function execute(bytes32 mode, bytes executionCalldata)',
  'function executeBatch((address,uint256,bytes)[] calls)',
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
const coinbaseBatch = (calls: Call[]) =>
  accounts.encodeFunctionData('executeBatch', [calls.map((c) => [c.to, c.value, c.data])]);

type Req = { url: string; method: string; params: unknown[] };

/** A mocked Pimlico endpoint: records every request; answers per method. */
class FakePimlico {
  calls: Req[] = [];
  receipts = new Map<string, unknown>();
  fail: string | null = null;
  dataResult: Record<string, unknown> = { paymaster: PM, paymasterData: '0xabcdef' };
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
        isFinal: false,
        extra: 'dropped',
      };
    } else if (body.method === 'pm_getPaymasterData') {
      result = this.dataResult;
    } else if (body.method === 'eth_getUserOperationReceipt') {
      result = this.receipts.get(String(body.params[0])) ?? null;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
}

describe('Pimlico paymaster proxy', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let wallet: string;
  let pimlico: FakePimlico;
  let proxy: PaymasterProxy;
  let logs: string[];

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    resetPaymasters();
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
    // The smart account's address (a fresh one per test: limits are keyed by address).
    wallet = (Wallet.createRandom() as unknown as Wallet).address;
    await putSecret(KEY, 'pimlico');
    pimlico = new FakePimlico();
    // The key comes from the stored secret (purpose `pimlico`).
    proxy = new PaymasterProxy(true, {
      pimlico: new PimlicoClient({ fetch: pimlico.fetch }),
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

  /** A `paymaster` quote for the smart wallet; the merchant sponsors unless `shopper`. */
  async function paymasterQuote(gasPayer?: 'shopper') {
    const s = await newSession(gasPayer);
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

  function userOp(callData: string, over: Record<string, unknown> = {}) {
    return {
      sender: wallet,
      nonce: '0x0',
      callData,
      callGasLimit: toBeHex(100_000n),
      verificationGasLimit: toBeHex(150_000n),
      preVerificationGas: toBeHex(50_000n),
      maxFeePerGas: toBeHex(10_000_000n), // 0.01 gwei
      maxPriorityFeePerGas: toBeHex(1_000_000n),
      paymaster: PM,
      paymasterVerificationGasLimit: '0x7530',
      paymasterPostOpGasLimit: '0x1',
      paymasterData: '0x01',
      signature: '0x' + 'ff'.repeat(65),
      ...over,
    };
  }

  const rpc = (method: string, op: unknown, extra: unknown[] = []) => ({
    jsonrpc: '2.0',
    id: 7,
    method,
    params: [op, ENTRY_POINT_V07, '0x2105', ...extra],
  });

  const errorOf = (r: JsonRpcResponse) => ('error' in r ? r.error : null);
  const resultOf = (r: JsonRpcResponse) => {
    if ('error' in r) throw new Error(`unexpected error ${JSON.stringify(r.error)}`);
    return r.result as Record<string, unknown>;
  };
  const month = () =>
    prisma.gasBudgetMonth.findFirstOrThrow({ where: { merchantId: merchant.id } });

  it('forwards a sponsored payment and records the submission at pm_getPaymasterData', async () => {
    const { ctx, quote, calls } = await paymasterQuote();
    const op = userOp(batch7579(calls));

    const stub = resultOf(
      await proxy.handle(
        ctx,
        rpc('pm_getPaymasterStubData', op, [{ sponsorshipPolicyId: 'evil' }]),
      ),
    );
    expect(stub).toEqual({
      paymaster: PM,
      paymasterData: '0x01',
      paymasterVerificationGasLimit: '0x7530',
      paymasterPostOpGasLimit: '0x1',
      isFinal: false,
    });
    // Nothing is recorded for a stub.
    expect(
      (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: quote.gasSponsorshipId! } }))
        .quoteId,
    ).toBeNull();

    const res = await proxy.handle(ctx, rpc('pm_getPaymasterData', op));
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { paymaster: PM, paymasterData: '0xabcdef' },
    });
    expect(JSON.stringify(res)).not.toContain(KEY);

    // Pimlico: the server-built URL with the stored key; our policy, never the caller's context.
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

    const sp = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: quote.gasSponsorshipId! },
    });
    const expectedHash = userOpHash(
      parseUserOp({ ...op, paymasterData: '0xabcdef' }),
      ENTRY_POINT_V07,
      8453,
    );
    expect(sp).toMatchObject({
      quoteId: quote.id,
      method: 'paymaster',
      provider: 'pimlico',
      sponsor: 'merchant',
      status: 'submitted',
      reservationState: 'reserved',
      signerAddress: wallet.toLowerCase(),
      userOpHash: expectedHash,
    });
  });

  describe('refuses anything but the quoted payment, without calling Pimlico', () => {
    const cases: [string, (p: Awaited<ReturnType<typeof paymasterQuote>>) => unknown][] = [
      [
        'another recipient',
        (p) => userOp(batch7579([transfer(wallet, p.quote.amountIn.toFixed(0))])),
      ],
      [
        'another amount',
        (p) =>
          userOp(
            batch7579([transfer(p.quote.depositAddress, BigInt(p.quote.amountIn.toFixed(0)) - 1n)]),
          ),
      ],
      ['an extra call appended', (p) => userOp(batch7579([...p.calls, transfer(wallet, 1n)]))],
      ['native value on the call', (p) => userOp(batch7579([{ ...p.payment, value: 1n }]))],
      ['another token', (p) => userOp(batch7579([{ ...p.payment, to: '0x' + '11'.repeat(20) }]))],
      ['another sender', (p) => userOp(batch7579(p.calls), { sender: '0x' + '22'.repeat(20) })],
      ['an unknown account format', () => userOp('0x47e1da2a' + '00'.repeat(96))],
      [
        'an EIP-7702 authorization',
        (p) => userOp(batch7579(p.calls), { eip7702Auth: { address: wallet, chainId: '0x2105' } }),
      ],
      [
        'a v0.6 user operation',
        (p) => ({ ...userOp(batch7579(p.calls)), initCode: '0x', paymasterAndData: '0x' }),
      ],
    ];
    for (const [name, build] of cases) {
      it(name, async () => {
        const p = await paymasterQuote();
        for (const method of ['pm_getPaymasterStubData', 'pm_getPaymasterData']) {
          const err = errorOf(await proxy.handle(p.ctx, rpc(method, build(p))));
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
      const op = userOp(batch7579(p.calls));
      const wrongChain = {
        ...rpc('pm_getPaymasterData', op),
        params: [op, ENTRY_POINT_V07, '0x1'],
      };
      expect(errorOf(await proxy.handle(p.ctx, wrongChain))).toMatchObject({
        code: -32001,
        data: { code: 'GASLESS_PAYLOAD_MISMATCH', field: 'chainId' },
      });
      const v06 = {
        ...rpc('pm_getPaymasterData', op),
        params: [op, '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x2105'],
      };
      expect(errorOf(await proxy.handle(p.ctx, v06))?.code).toBe(-32602);
      expect(
        errorOf(await proxy.handle(p.ctx, { ...rpc('pm_sponsorUserOperation', op) })),
      ).toMatchObject({ code: -32601 });
      expect(errorOf(await proxy.handle(p.ctx, { hello: 1 }))?.code).toBe(-32600);
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
      const op = userOp(batch7579([transfer(quote.depositAddress, quote.amountIn.toFixed(0))]));
      expect(errorOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', op)))).toMatchObject({
        code: -32001,
        data: { code: 'GASLESS_NOT_AVAILABLE' },
      });
      expect(pimlico.calls).toEqual([]);
    });

    it('gas limits or fees that would cost far more than the quote', async () => {
      const p = await paymasterQuote();
      const op = userOp(batch7579(p.calls), { maxFeePerGas: toBeHex(1_000_000_000_000n) });
      expect(errorOf(await proxy.handle(p.ctx, rpc('pm_getPaymasterData', op)))).toMatchObject({
        code: -32001,
        data: { field: 'gas' },
      });
      expect(pimlico.calls).toEqual([]);
    });
  });

  it('shopper pays in the token: the fee transfer to gas-fees-evm is required, exactly', async () => {
    const p = await paymasterQuote('shopper');
    expect(p.quote.networkFeePaidBy).toBe('buyer');
    // Without the fee leg, or with a smaller fee: refused.
    for (const calls of [
      [p.payment],
      [p.payment, transfer(p.feeTo, BigInt(p.quote.networkFeeAmount!.toFixed(0)) - 1n)],
      [p.fee!, p.payment],
    ]) {
      const err = errorOf(
        await proxy.handle(p.ctx, rpc('pm_getPaymasterData', userOp(coinbaseBatch(calls)))),
      );
      expect(err?.code).toBe(-32001);
    }
    expect(pimlico.calls).toEqual([]);

    const op = userOp(coinbaseBatch(p.calls));
    resultOf(await proxy.handle(p.ctx, rpc('pm_getPaymasterData', op)));
    const sp = await prisma.gasSponsorship.findFirstOrThrow({
      where: { quoteId: p.quote.id, sponsor: 'shopper' },
    });
    expect(sp).toMatchObject({
      method: 'paymaster',
      provider: 'pimlico',
      status: 'submitted',
      feeMode: 'token',
      feeAsset: USDC_BASE,
    });
    expect(sp.feeAmount!.toFixed()).toBe(p.quote.networkFeeAmount!.toFixed());

    // Mined: fee revenue from the operation's own Transfer to gas-fees-evm (capped at the fee).
    const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
    pimlico.receipts.set(sp.userOpHash!, {
      success: true,
      actualGasCost: toBeHex(88_000_000_000_000n), // 0.000088 ETH = $0.22
      actualGasUsed: toBeHex(150_000n),
      logs: [
        transferLog(wallet, p.quote.depositAddress, BigInt(p.quote.amountIn.toFixed(0))),
        transferLog(wallet, p.feeTo, fee + 5n),
        // Another wallet's fee in the same bundle is not this operation's (not in its logs).
      ],
      receipt: { transactionHash: '0x' + 'ab'.repeat(32) },
    });
    expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(1);
    const done = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } });
    expect(done).toMatchObject({ status: 'confirmed', txHash: '0x' + 'ab'.repeat(32) });
    expect(done.feeCollected!.toFixed()).toBe(fee.toString());
    expect(done.costUsd!.toFixed()).toBe('0.22');
    expect(done.gasUsed!.toFixed()).toBe('150000');
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } })).depositTxHash,
    ).toBe('0x' + 'ab'.repeat(32));

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

  function transferLog(from: string, to: string, amount: bigint) {
    return {
      address: TOKEN,
      topics: [TRANSFER_TOPIC0, zeroPadValue(from, 32), zeroPadValue(to.toLowerCase(), 32)],
      data: zeroPadValue(toBeHex(amount), 32),
    };
  }
  const client = () => new PimlicoClient({ fetch: pimlico.fetch });

  it('the same operation again gets the same data; another one is refused while in flight', async () => {
    const { ctx, calls } = await paymasterQuote();
    const op = userOp(batch7579(calls));
    const first = resultOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', op)));
    // Pimlico would answer differently now: the recorded data is returned, Pimlico not asked.
    pimlico.dataResult = { paymaster: PM, paymasterData: '0x99' };
    // The wallet sends the operation back with the paymaster data filled in: still the same.
    const again = resultOf(
      await proxy.handle(ctx, rpc('pm_getPaymasterData', { ...op, paymasterData: '0xabcdef' })),
    );
    expect(again).toEqual(first);
    expect(pimlico.calls.filter((c) => c.method === 'pm_getPaymasterData')).toHaveLength(1);

    const other = userOp(batch7579(calls), { nonce: '0x1' });
    expect(errorOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', other)))).toMatchObject({
      code: -32001,
      data: { code: 'CONFLICT' },
    });
    expect(pimlico.calls.filter((c) => c.method === 'pm_getPaymasterData')).toHaveLength(1);
  });

  it('a released sponsorship is refused', async () => {
    const { ctx, quote, calls } = await paymasterQuote();
    await prisma.gasSponsorship.update({
      where: { id: quote.gasSponsorshipId! },
      data: { reservationState: 'released' },
    });
    expect(
      errorOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', userOp(batch7579(calls))))),
    ).toMatchObject({ code: -32001, data: { code: 'SPONSORSHIP_RELEASED' } });
    expect(pimlico.calls).toEqual([]);
  });

  it('Pimlico refusing: an error without its message or the key, nothing recorded', async () => {
    const { ctx, quote, calls } = await paymasterQuote();
    pimlico.fail = `policy rejected for apikey=${KEY}`;
    const res = await proxy.handle(ctx, rpc('pm_getPaymasterData', userOp(batch7579(calls))));
    expect(errorOf(res)).toMatchObject({ code: -32603, data: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(
      (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: quote.gasSponsorshipId! } }))
        .quoteId,
    ).toBeNull();
  });

  it('rate limits: counted after validation, per wallet', async () => {
    const { ctx, calls } = await paymasterQuote();
    const key = `tendr:gasless:submit:addr:${wallet.toLowerCase()}:${Math.floor(Date.now() / 3_600_000)}`;
    await getRedis().set(key, String(SUBMITS_PER_ADDRESS_PER_HOUR), 'EX', 3600);
    expect(
      errorOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', userOp(batch7579(calls))))),
    ).toMatchObject({ code: -32005, data: { code: 'RATE_LIMITED' } });
    expect(pimlico.calls).toEqual([]);
    await getRedis().del(key);
  });

  it('EntryPoint v0.8 operations are sponsored and hashed as v0.8', async () => {
    const { ctx, quote, calls } = await paymasterQuote();
    const op = userOp(batch7579(calls));
    const req = { ...rpc('pm_getPaymasterData', op), params: [op, ENTRY_POINT_V08, '0x2105'] };
    resultOf(await proxy.handle(ctx, req));
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: quote.gasSponsorshipId! },
    });
    expect(sp.userOpHash).toBe(
      userOpHash(parseUserOp({ ...op, paymasterData: '0xabcdef' }), ENTRY_POINT_V08, 8453),
    );
  });

  describe('outcomes (polled from Pimlico)', () => {
    it('mined: confirmed with its cost; the hold is settled only when the payment is collected', async () => {
      const { ctx, quote, calls } = await paymasterQuote();
      resultOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', userOp(batch7579(calls)))));
      let sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: quote.gasSponsorshipId! },
      });
      // No receipt yet: nothing changes; the stale-quote sweep leaves the hold alone.
      expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(0);
      expect(await releaseStaleReservations(new Date(quote.deadline.getTime() + 10 * 60_000))).toBe(
        0,
      );
      pimlico.receipts.set(sp.userOpHash!, {
        success: true,
        actualGasCost: toBeHex(88_000_000_000_000n),
        actualGasUsed: toBeHex(150_000n),
        logs: [],
        receipt: { transactionHash: '0x' + 'cd'.repeat(32) },
      });
      expect(await pollPaymasterOps({ pimlico: client(), livemode: false })).toBe(1);
      sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } });
      expect(sp).toMatchObject({ status: 'confirmed', reservationState: 'reserved' });
      expect(sp.costUsd!.toFixed()).toBe('0.22');
      expect((await month()).spentUsd.toFixed()).toBe('0');
      expect(await prisma.payment.count()).toBe(0);

      await sim.simulate(quote.depositAddress, 'exact', { senderAddress: wallet });
      await pollDeposit(quote.depositAddress, { livemode: false });
      const pay = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } });
      expect(sp).toMatchObject({ reservationState: 'settled', recoveredFromPaymentId: pay.id });
      expect((await month()).spentUsd.toFixed()).toBe(quote.networkFeeUsd!.toFixed());
    });

    it('reverted then the session expires: released, the gas is a Tendr loss', async () => {
      const { s, ctx, quote, calls } = await paymasterQuote();
      resultOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', userOp(batch7579(calls)))));
      const id = quote.gasSponsorshipId!;
      const hash = (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } })).userOpHash!;
      pimlico.receipts.set(hash, {
        success: false,
        actualGasCost: toBeHex(44_000_000_000_000n),
        actualGasUsed: toBeHex(90_000n),
        logs: [],
        receipt: { transactionHash: '0x' + 'ef'.repeat(32) },
      });
      await prisma.session.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
      // Still in flight: the sweep waits.
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

    it('never sent: failed after the give-up window, no gas, the hold released without loss', async () => {
      const { ctx, quote, calls } = await paymasterQuote();
      resultOf(await proxy.handle(ctx, rpc('pm_getPaymasterData', userOp(batch7579(calls)))));
      const id = quote.gasSponsorshipId!;
      const before = new Date(quote.deadline.getTime() + PAYMASTER_GIVE_UP_MS - 1000);
      expect(
        await pollPaymasterOps({ pimlico: client(), livemode: false, now: () => before }),
      ).toBe(0);
      const after = new Date(quote.deadline.getTime() + PAYMASTER_GIVE_UP_MS + 1000);
      expect(await pollPaymasterOps({ pimlico: client(), livemode: false, now: () => after })).toBe(
        1,
      );
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
      expect(sp).toMatchObject({ status: 'failed', reservationState: 'reserved' });
      expect(sp.gasUsed).toBeNull();
      // The stale-quote sweep may now release it: no loss.
      expect(await releaseStaleReservations(after)).toBe(1);
      const released = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
      expect(released).toMatchObject({ reservationState: 'released', sponsor: 'merchant' });
      expect(released.lossRecognizedAt).toBeNull();
    });
  });

  describe('route (test mode: simulated, never Pimlico)', () => {
    it('stub and data are simulated; the operation is "mined" and the payment detected', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const { s, quote, calls } = await paymasterQuote();
      const call = (body: unknown) =>
        app.inject({
          method: 'POST',
          url: '/v1/checkout/client/gasless/paymaster',
          headers: { authorization: `Bearer ${s.client_secret}` },
          payload: body as Record<string, unknown>,
        });
      const op = userOp(batch7579(calls));
      const stub = await call(rpc('pm_getPaymasterStubData', op));
      expect(stub.statusCode).toBe(200);
      expect(stub.json().result).toMatchObject({ paymaster: SIMULATED_PAYMASTER, isFinal: false });

      const data = await call(rpc('pm_getPaymasterData', op));
      expect(data.statusCode).toBe(200);
      expect(data.json().result.paymaster).toBe(SIMULATED_PAYMASTER);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: quote.gasSponsorshipId! },
      });
      expect(sp).toMatchObject({ status: 'confirmed', method: 'paymaster', provider: 'pimlico' });
      expect(sp.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);

      // The watcher, not the proxy, marks it paid.
      expect(await prisma.payment.count()).toBe(0);
      await pollDeposit(quote.depositAddress, { livemode: false });
      const pay = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      expect(pay.status).toBe('SETTLED');

      // A mismatch through the route: a JSON-RPC error with HTTP 200.
      const bad = await call(
        rpc('pm_getPaymasterStubData', userOp(batch7579([...calls, calls[0]!]))),
      );
      expect(bad.statusCode).toBe(200);
      expect(bad.json().error.code).toBe(-32001);
      const unknown = await call({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
      expect(unknown.json()).toMatchObject({ id: 1, error: { code: -32601 } });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('needs the session client secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/checkout/client/gasless/paymaster',
        payload: { jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterStubData', params: [] },
      });
      expect(res.statusCode).toBe(401);
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
