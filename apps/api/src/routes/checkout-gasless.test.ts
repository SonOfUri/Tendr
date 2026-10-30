import { TEST_PAYMENT_DOMAIN_NAME, TEST_VERIFYING_CONTRACT } from '@tendr/contracts';
import type { Merchant } from '@prisma/client';
import { Wallet } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { pollDeposit, registerWatcherHooks } from '../checkout/watcher.js';
import { putGasPolicy } from '../gas/policy.js';
import { evmAddress, getKeyVault } from '../keyvault/index.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { resetRelayers } from '../relayer/index.js';
import { SUBMITS_PER_ADDRESS_PER_HOUR, SUBMITS_PER_SESSION } from '../relayer/submissions.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';

const sim1click = isolatedSimStore();
const USDC = 'nep141:usdc.test'; // settlement asset (NEAR)
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ETH = 'nep141:eth.test'; // a native coin: never gasless
const FORWARDER = '0x19bebc71495490a99ca6f50f107076967380cf09';

type ToSign = { kind: string; typed_data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signAll(items: ToSign[], wallet: Wallet) {
  const signatures: Record<string, { message: Record<string, unknown>; signature: string }> = {};
  for (const { kind, typed_data: td } of items) {
    const types = Object.fromEntries(
      Object.entries(td.types as Record<string, unknown>).filter(([n]) => n !== 'EIP712Domain'),
    ) as Record<string, { name: string; type: string }[]>;
    signatures[kind] = {
      message: { ...td.message },
      signature: await wallet.signTypedData(td.domain, types, td.message),
    };
  }
  return signatures;
}

describe('gasless checkout routes (test mode: simulated relayer)', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let shopper: Wallet;
  let fetchSpy: { mock: { calls: unknown[] } };

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    resetNearClients();
    fakeNearClient(false);
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Test mode never calls an RPC (or anything else over HTTP).
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({
      name: 'Bean Shop',
      defaultFeePayer: 'merchant',
      defaultGasPayer: 'buyer',
    });
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC,
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    // A fresh wallet per test: the per-address limit is keyed by address.
    shopper = Wallet.createRandom() as unknown as Wallet;
  });
  afterEach(async () => {
    expect(fetchSpy.mock.calls).toEqual([]);
    await app.close();
    vi.restoreAllMocks();
    resetTokenCache();
    resetOneClickProviders();
    resetNearClients();
    resetRelayers();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  async function sponsoring() {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { defaultGasPayer: 'merchant' },
    });
    await putGasPolicy(
      { merchantId: merchant.id, livemode: false, actor: { by: 'api_key', apiKeyId: 'key_x' } },
      { enabled: true },
    );
  }

  async function newSession() {
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
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; client_secret: string };
  }

  function call(method: 'GET' | 'POST', path: string, secret: string, payload?: unknown) {
    return app.inject({
      method,
      url: `/v1/checkout/client/${path}`,
      headers: { authorization: `Bearer ${secret}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  /** A session with a gasless quote for `method`, and what to sign for it. */
  async function gaslessQuote(method: 'eip3009' | 'permit' = 'eip3009', wallet = shopper) {
    const s = await newSession();
    const q = await call('POST', 'quote', s.client_secret, {
      origin_asset: USDC_BASE,
      wallet_address: wallet.address,
      gasless_method: method,
    });
    expect(q.statusCode, q.body).toBe(201);
    const quote = q.json() as { id: string; deposit_address: string; amount_in: string };
    const p = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id });
    expect(p.statusCode, p.body).toBe(200);
    return { s, quote, prepared: p.json() as { to_sign: ToSign[]; [k: string]: unknown } };
  }

  const feeAddress = async () => evmAddress((await getKeyVault().publicKey('gas-fees-evm')).raw);

  describe('options', () => {
    it('merchant sponsors: every EVM method, no fee choice', async () => {
      await sponsoring();
      const s = await newSession();
      const res = await call('POST', 'gasless/options', s.client_secret, {
        origin_asset: USDC_BASE,
        wallet_address: shopper.address,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        chain: 'base',
        family: 'evm',
        native_symbol: 'ETH',
        // Ruling T10-g: the page checks every fee leg goes exactly here.
        fee_recipient: await feeAddress(),
        // Test mode never offers the paymaster (ruling T10-f): the smart wallet would send a
        // real operation.
        options: [
          { method: 'eip3009', paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null },
          { method: 'permit', paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null },
        ],
      });
      // Options reserve nothing.
      expect(await prisma.gasSponsorship.count()).toBe(0);
    });

    it('shopper pays: the token fee on top, or the chain coin', async () => {
      const s = await newSession();
      const res = await call('POST', 'gasless/options', s.client_secret, {
        origin_asset: USDC_BASE,
        wallet_address: shopper.address,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().options[0]).toEqual({
        method: 'eip3009',
        paid_by: 'shopper',
        reason: 'shopper_choice',
        fee_modes: ['token', 'native'],
        token_fee: { amount: '48000', symbol: 'USDC', decimals: 6, usd: '0.048' },
      });
    });

    it('a native coin or a token off the allow-list has no gasless option', async () => {
      const s = await newSession();
      const res = await call('POST', 'gasless/options', s.client_secret, {
        origin_asset: ETH,
        wallet_address: shopper.address,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ native_symbol: 'ETH', fee_recipient: null, options: [] });
      const bad = await call('POST', 'gasless/options', s.client_secret, {
        origin_asset: USDC_BASE,
        wallet_address: 'alice.near',
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('prepare', () => {
    it('eip3009 sponsored: one authorization to the deposit address, deadline = quote deadline', async () => {
      await sponsoring();
      const { quote, prepared } = await gaslessQuote();
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
      expect(row.walletAddress).toBe(shopper.address);
      expect(prepared).toMatchObject({
        quote_id: quote.id,
        method: 'eip3009',
        chain: 'base',
        chain_id: 8453,
        signer: shopper.address.toLowerCase(),
        deadline: row.deadline.toISOString(),
        amount: quote.amount_in,
        fee_amount: '0',
      });
      expect(prepared.to_sign).toHaveLength(1);
      const msg = prepared.to_sign[0]!.typed_data.message;
      expect(msg.to.toLowerCase()).toBe(quote.deposit_address.toLowerCase());
      expect(msg.value).toBe(quote.amount_in);
      expect(msg.validBefore).toBe(String(Math.floor(row.deadline.getTime() / 1000)));
    });

    it('shopper pays: the fee leg goes to the gas-fees-evm address with the same deadline', async () => {
      const { prepared } = await gaslessQuote();
      expect(prepared.fee_amount).toBe('48000');
      const [pay, fee] = prepared.to_sign.map((t) => t.typed_data.message);
      expect(fee.to.toLowerCase()).toBe(await feeAddress());
      expect(fee.value).toBe('48000');
      expect(fee.validBefore).toBe(pay.validBefore);
    });

    it('permit: to the configured forwarder, for exactly amount + fee', async () => {
      const { quote, prepared } = await gaslessQuote('permit');
      const [permit, payment] = prepared.to_sign;
      expect(permit!.typed_data.message.spender.toLowerCase()).toBe(FORWARDER);
      expect(permit!.typed_data.message.value).toBe(String(BigInt(quote.amount_in) + 48_000n));
      // Test mode: every message is on the test domain at the code-less sentinel (T10-f).
      expect(permit!.typed_data.domain).toMatchObject({
        name: TEST_PAYMENT_DOMAIN_NAME,
        verifyingContract: TEST_VERIFYING_CONTRACT,
      });
      expect(payment!.typed_data.domain).toMatchObject({
        name: TEST_PAYMENT_DOMAIN_NAME,
        verifyingContract: TEST_VERIFYING_CONTRACT,
      });
    });

    it('a copy-address quote, or fee_mode native, is not gasless', async () => {
      const s = await newSession();
      const q = (await call('POST', 'quote', s.client_secret, { origin_asset: USDC_BASE })).json();
      const res = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: q.id });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('GASLESS_NOT_AVAILABLE');
      const native = (
        await call('POST', 'quote', s.client_secret, {
          origin_asset: USDC_BASE,
          wallet_address: shopper.address,
          gasless_method: 'eip3009',
          fee_mode: 'native',
        })
      ).json();
      const res2 = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: native.id });
      expect(res2.json().error.code).toBe('GASLESS_NOT_AVAILABLE');
    });

    it('a gasless quote for a token off the allow-list is refused at quote time', async () => {
      const s = await newSession();
      const res = await call('POST', 'quote', s.client_secret, {
        origin_asset: 'nep141:eth.omft.near',
        wallet_address: shopper.address,
        gasless_method: 'eip3009',
      });
      expect(res.statusCode, res.body).toBe(400);
    });
  });

  describe('submit', () => {
    it('merchant sponsors: relays and records it; paid only once detected; settled when collected', async () => {
      await sponsoring();
      const { s, quote, prepared } = await gaslessQuote();
      const signatures = await signAll(prepared.to_sign, shopper);
      const res = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signatures,
      });
      expect(res.statusCode, res.body).toBe(202);
      const body = res.json();
      expect(body.status).toBe('confirmed');
      expect(body.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

      const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: body.submission_id },
      });
      expect(sp.id).toBe(row.gasSponsorshipId);
      expect(sp).toMatchObject({
        sponsor: 'merchant',
        method: 'eip3009',
        provider: 'relayer-evm',
        status: 'confirmed',
        quoteId: quote.id,
        signerAddress: shopper.address.toLowerCase(),
        txHash: body.tx_hash,
        // Not settled by the relay: only when the payment's proceeds are collected.
        reservationState: 'reserved',
      });
      expect(sp.costUsd!.toFixed()).toBe('0.04');
      const monthRow = () =>
        prisma.gasBudgetMonth.findFirstOrThrow({
          where: { merchantId: merchant.id, livemode: false },
        });
      expect((await monthRow()).reservedUsd.toFixed()).toBe('0.048');
      expect(row.depositTxHash).toBe(body.tx_hash);

      // Relayed is not paid: no payment until the watcher sees the deposit.
      expect(await prisma.payment.count()).toBe(0);
      expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
        'PENDING_DEPOSIT',
      );
      await pollDeposit(quote.deposit_address, { livemode: false });
      const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      expect(p.status).toBe('SETTLED');
      expect(await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } })).toMatchObject(
        { reservationState: 'settled', recoveredFromPaymentId: p.id },
      );
      expect((await monthRow()).reservedUsd.toFixed()).toBe('0');
      expect((await monthRow()).spentUsd.toFixed()).toBe('0.048');

      const status = await call('GET', `gasless/submissions/${sp.id}`, s.client_secret);
      expect(status.json()).toEqual({
        id: sp.id,
        quote_id: quote.id,
        status: 'confirmed',
        tx_hash: body.tx_hash,
      });
    });

    it('shopper pays in the token: a shopper sponsorship, and the fee leg is gas_reimbursement revenue', async () => {
      const { s, quote, prepared } = await gaslessQuote('permit');
      const res = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signatures: await signAll(prepared.to_sign, shopper),
      });
      expect(res.statusCode, res.body).toBe(202);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: res.json().submission_id },
      });
      expect(sp).toMatchObject({
        sponsor: 'shopper',
        method: 'permit',
        feeMode: 'token',
        feeAsset: USDC_BASE,
        status: 'confirmed',
        reservationState: null,
      });
      expect(sp.feeAmount!.toFixed()).toBe('48000');

      await pollDeposit(quote.deposit_address, { livemode: false });
      const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      const gas = await prisma.revenueEntry.findMany({
        where: { paymentId: p.id, source: 'gas_reimbursement' },
      });
      expect(gas).toHaveLength(1);
      expect(gas[0]).toMatchObject({ reference: sp.id, assetId: USDC_BASE, txHash: sp.txHash });
      expect(gas[0]!.amount.toFixed()).toBe('48000');
      // A token fee is not also a shopper-paid `network_fee` line.
      expect(
        await prisma.revenueEntry.count({ where: { paymentId: p.id, source: 'network_fee' } }),
      ).toBe(0);
    });

    it('a sponsored quote paid by copy-address: settled at the estimate when collected', async () => {
      await sponsoring();
      const { quote } = await gaslessQuote();
      // No relay: the shopper sends from another app to the deposit address.
      await sim.simulate(quote.deposit_address, 'exact');
      await pollDeposit(quote.deposit_address, { livemode: false });
      const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      expect(p.status).toBe('SETTLED');
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: row.gasSponsorshipId! },
      });
      expect(sp).toMatchObject({
        reservationState: 'settled',
        recoveredFromPaymentId: p.id,
        quoteId: null,
      });
      const m = await prisma.gasBudgetMonth.findFirstOrThrow({
        where: { merchantId: merchant.id, livemode: false },
      });
      expect(m.spentUsd.toFixed()).toBe('0.048');
    });

    it('a quote less than a minute from its deadline is not relayed', async () => {
      await sponsoring();
      const { s, quote, prepared } = await gaslessQuote();
      await prisma.quote.update({
        where: { id: quote.id },
        data: { deadline: new Date(Date.now() + 30_000) },
      });
      const res = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signatures: await signAll(prepared.to_sign, shopper),
      });
      expect(res.json().error.code).toBe('QUOTE_EXPIRED');
    });

    it('submitting twice returns the same submission', async () => {
      await sponsoring();
      const { s, quote, prepared } = await gaslessQuote();
      const body = { quote_id: quote.id, signatures: await signAll(prepared.to_sign, shopper) };
      const a = await call('POST', 'gasless/submit', s.client_secret, body);
      const b = await call('POST', 'gasless/submit', s.client_secret, body);
      expect(b.statusCode, b.body).toBe(202);
      expect(b.json().submission_id).toBe(a.json().submission_id);
      expect(await prisma.gasSponsorship.count({ where: { quoteId: quote.id } })).toBe(1);
    });

    it("another session's quote, or its signatures, → 409 GASLESS_PAYLOAD_MISMATCH, nothing relayed", async () => {
      await sponsoring();
      const a = await gaslessQuote();
      const b = await gaslessQuote();
      const signedForB = await signAll(b.prepared.to_sign, shopper);

      // Session A submits session B's quote id.
      const cross = await call('POST', 'gasless/submit', a.s.client_secret, {
        quote_id: b.quote.id,
        signatures: signedForB,
      });
      expect(cross.statusCode, cross.body).toBe(409);
      expect(cross.json().error).toMatchObject({
        code: 'GASLESS_PAYLOAD_MISMATCH',
        details: { field: 'quote_id' },
      });
      // Session A submits B's signatures against its own quote.
      const swapped = await call('POST', 'gasless/submit', a.s.client_secret, {
        quote_id: a.quote.id,
        signatures: signedForB,
      });
      expect(swapped.statusCode, swapped.body).toBe(409);
      expect(swapped.json().error.code).toBe('GASLESS_PAYLOAD_MISMATCH');
      // Signed by another wallet.
      const other = await call('POST', 'gasless/submit', a.s.client_secret, {
        quote_id: a.quote.id,
        signatures: await signAll(a.prepared.to_sign, Wallet.createRandom() as unknown as Wallet),
      });
      expect(other.json().error).toMatchObject({
        code: 'GASLESS_PAYLOAD_MISMATCH',
        details: { field: 'payment.signer' },
      });
      // Nothing was claimed, relayed or spent; both reservations are still held.
      const rows = await prisma.gasSponsorship.findMany();
      expect(rows.every((r) => r.status === 'pending' && r.quoteId === null)).toBe(true);
      expect(rows.every((r) => r.reservationState === 'reserved')).toBe(true);
      expect(await prisma.quote.count({ where: { depositTxHash: { not: null } } })).toBe(0);
    });

    it('an expired or replaced quote → 409 QUOTE_EXPIRED', async () => {
      await sponsoring();
      const { s, quote, prepared } = await gaslessQuote();
      const signatures = await signAll(prepared.to_sign, shopper);
      await prisma.quote.update({
        where: { id: quote.id },
        data: { deadline: new Date(Date.now() - 1000) },
      });
      const res = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signatures,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('QUOTE_EXPIRED');
      expect(
        (await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id })).json()
          .error.code,
      ).toBe('QUOTE_EXPIRED');

      const fresh = await gaslessQuote();
      await call('POST', 'quote', fresh.s.client_secret, { origin_asset: USDC_BASE });
      const replaced = await call('POST', 'gasless/submit', fresh.s.client_secret, {
        quote_id: fresh.quote.id,
        signatures: await signAll(fresh.prepared.to_sign, shopper),
      });
      expect(replaced.json().error.code).toBe('QUOTE_EXPIRED');
      expect(await prisma.gasSponsorship.count({ where: { status: { not: 'pending' } } })).toBe(0);
    });

    it('a released reservation → 409 SPONSORSHIP_RELEASED (re-quote)', async () => {
      await sponsoring();
      const { s, quote, prepared } = await gaslessQuote();
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
      await prisma.gasSponsorship.update({
        where: { id: row.gasSponsorshipId! },
        data: { reservationState: 'released' },
      });
      const res = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signatures: await signAll(prepared.to_sign, shopper),
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('SPONSORSHIP_RELEASED');
    });

    it(`rate limits: ${SUBMITS_PER_SESSION} attempts per session, ${SUBMITS_PER_ADDRESS_PER_HOUR} per address per hour`, async () => {
      const { s, quote, prepared } = await gaslessQuote();
      const junk = await signAll(prepared.to_sign, Wallet.createRandom() as unknown as Wallet);
      for (let i = 0; i < SUBMITS_PER_SESSION; i++) {
        const r = await call('POST', 'gasless/submit', s.client_secret, {
          quote_id: quote.id,
          signatures: junk,
        });
        expect(r.statusCode, r.body).toBe(409);
      }
      const limited = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signatures: await signAll(prepared.to_sign, shopper),
      });
      expect(limited.statusCode, limited.body).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      // Signatures that do not verify never count against the named wallet's own limit.
      const hourNow = Math.floor(Date.now() / 3_600_000);
      expect(
        await getRedis().get(
          `tendr:gasless:submit:addr:${shopper.address.toLowerCase()}:${hourNow}`,
        ),
      ).toBeNull();

      // Per address: a fresh session for a wallet already at its hourly limit.
      const busy = Wallet.createRandom() as unknown as Wallet;
      const hour = Math.floor(Date.now() / 3_600_000);
      await getRedis().set(
        `tendr:gasless:submit:addr:${busy.address.toLowerCase()}:${hour}`,
        String(SUBMITS_PER_ADDRESS_PER_HOUR),
        'EX',
        3600,
      );
      const b = await gaslessQuote('eip3009', busy);
      const r = await call('POST', 'gasless/submit', b.s.client_secret, {
        quote_id: b.quote.id,
        signatures: await signAll(b.prepared.to_sign, busy),
      });
      expect(r.statusCode, r.body).toBe(429);
      expect(await prisma.gasSponsorship.count({ where: { quoteId: { not: null } } })).toBe(0);
    });
  });
});
