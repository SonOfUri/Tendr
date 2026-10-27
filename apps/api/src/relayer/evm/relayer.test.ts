// The live EVM relayer end to end against a mocked JSON-RPC node (ruling P2): the real submit
// pipeline, EvmSender and outcome handling, on a test-mode session (quotes come from the 1Click
// simulator; only the relayer is live).
import type { Merchant } from '@prisma/client';
import { TENDR_FORWARDER_ABI } from '@tendr/contracts';
import { Interface, Transaction, Wallet } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../../checkout/oneclick/index.js';
import { resetTokenCache } from '../../checkout/tokens.js';
import { scopedDb } from '../../db/scoped.js';
import { resetFeeCache, setFeeDeps } from '../../gas/fees.js';
import { putGasPolicy } from '../../gas/policy.js';
import { getKeyVault } from '../../keyvault/index.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getRedis } from '../../lib/redis.js';
import { FakeEvmNode, RpcRefusal } from '../../test/fake-evm-node.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../../test/helpers.js';
import { isolatedSimStore } from '../../test/sim-1click.js';
import { gaslessQuote, pollEvmRelays, resetRelayers } from '../index.js';
import { EvmGasless, EvmGaslessRelayer } from './index.js';
import { EvmRpc } from './rpc.js';
import { EvmSender } from './sender.js';

const sim1click = isolatedSimStore();
const USDC = 'nep141:usdc.test';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const FORWARDER = '0x19bebc71495490a99ca6f50f107076967380cf09';
const iface = new Interface(TENDR_FORWARDER_ABI as unknown as string);

describe('EVM gasless relayer (live path, mocked JSON-RPC)', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let node: FakeEvmNode;
  let sender: EvmSender;
  let relayer: EvmGaslessRelayer;
  let shopper: Wallet;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    resetFeeCache();
    resetOneClickProviders({ simulated: new SimulatedOneClick({ store: sim1click.store() }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Live cost pricing reads the native coin's price: ETH on Base at $2500.
    setFeeDeps({
      tokens: async () =>
        new Map([
          [
            'nep141:base.omft.near',
            {
              assetId: 'nep141:base.omft.near',
              symbol: 'ETH',
              blockchain: 'base',
              decimals: 18,
              priceUsd: '2500',
            },
          ],
        ]),
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
    node = new FakeEvmNode();
    sender = new EvmSender({
      kv: getKeyVault(),
      redis: getRedis(),
      rpc: (chain) => new EvmRpc(chain, 'http://rpc.test', node.fetch),
    });
    await getRedis().del(`tendr:evm-nonce:base:${await sender.address()}`);
    relayer = new EvmGaslessRelayer(new EvmGasless(false), () => sender);
    shopper = Wallet.createRandom() as unknown as Wallet;
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    setFeeDeps(null);
    resetTokenCache();
    resetOneClickProviders();
    resetRelayers();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  /** A sponsored eip3009 quote, its relayer context, and the shopper's signatures. */
  async function sponsoredQuote() {
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
    const s = res.json() as { id: string; client_secret: string };
    const qr = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${s.client_secret}` },
      payload: {
        origin_asset: USDC_BASE,
        wallet_address: shopper.address,
        gasless_method: 'eip3009',
      },
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const quoteId = qr.json().id as string;
    const scope = { merchantId: merchant.id, livemode: false };
    const shopperCtx = { ...scope, db: scopedDb(scope), sessionId: s.id };
    const { q } = await gaslessQuote(shopperCtx, quoteId);
    const prepared = await relayer.prepare(q, {});
    const signatures: Record<string, { message: Record<string, unknown>; signature: string }> = {};
    for (const { kind, typed_data } of prepared.to_sign) {
      const td = typed_data as {
        domain: Record<string, unknown>;
        types: Record<string, { name: string; type: string }[]>;
        message: Record<string, string>;
      };
      const { EIP712Domain: _domain, ...types } = td.types;
      signatures[kind] = {
        message: { ...td.message },
        signature: await shopper.signTypedData(td.domain, types, td.message),
      };
    }
    return { s, q, signatures, sponsorshipId: q.quote.gasSponsorshipId! };
  }

  it('relays one forwarder transaction and records it; confirmation settles at the estimate', async () => {
    const { q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    expect(res).toMatchObject({ submissionId: sponsorshipId, status: 'submitted' });

    expect(node.sent).toHaveLength(1);
    const tx = Transaction.from(node.sent[0]!);
    expect(tx.hash).toBe(res.txHash);
    expect(tx.to!.toLowerCase()).toBe(FORWARDER);
    const [payment, fee] = iface.decodeFunctionData('payWithAuthorizations', tx.data);
    expect(payment.to.toLowerCase()).toBe(q.quote.depositAddress.toLowerCase());
    expect(payment.value.toString()).toBe(q.quote.amountIn.toFixed());
    expect(payment.from.toLowerCase()).toBe(shopper.address.toLowerCase());
    expect(fee.value).toBe(0n);

    let sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({
      status: 'submitted',
      txHash: tx.hash,
      reservationState: 'reserved',
    });
    expect(sp.relayerTxId).toMatch(/^rtx_/);
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: q.quote.id } });
    expect(quote.depositTxHash).toBe(tx.hash);

    // Mined: the poller applies the outcome.
    node.mine(tx.hash!, 1, 80_000n);
    expect(await pollEvmRelays(sender)).toBe(1);
    sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ status: 'confirmed', reservationState: 'settled' });
    expect(sp.gasUsed!.toFixed()).toBe('80000');
    // 80 000 gas × 1.1 gwei × $2500 = $0.22 (the merchant was charged the $0.048 estimate).
    expect(sp.costUsd!.toFixed()).toBe('0.22');
    const m = await prisma.gasBudgetMonth.findFirstOrThrow({ where: { merchantId: merchant.id } });
    expect(m.spentUsd.toFixed()).toBe('0.048');
    expect(m.reservedUsd.toFixed()).toBe('0');
    // Relayed and mined, still not paid: only the watcher marks payments.
    expect(await prisma.payment.count()).toBe(0);
    expect(await pollEvmRelays(sender)).toBe(0);
  });

  it('a payload that does not match makes no RPC call at all', async () => {
    const { q, signatures } = await sponsoredQuote();
    signatures.payment!.message.value = '1';
    await expect(relayer.submit(q, { signatures })).rejects.toMatchObject({
      code: 'GASLESS_PAYLOAD_MISMATCH',
    });
    expect(node.calls).toHaveLength(0);
  });

  it('a dry run that reverts: 409, nothing sent, reservation released, session still open', async () => {
    const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
    node.once('eth_estimateGas', () => {
      throw new RpcRefusal(3, 'execution reverted: FiatTokenV2: authorization is used or canceled');
    });
    const err = await relayer.submit(q, { signatures }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'GASLESS_SUBMIT_FAILED', status: 409 });
    expect(node.count('eth_sendRawTransaction')).toBe(0);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ status: 'failed', reservationState: 'released' });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PENDING_DEPOSIT',
    );
  });

  it('reverted on chain: failed, reservation released, the burned gas is a Tendr loss', async () => {
    const { q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    node.mine(res.txHash!, 0, 40_000n);
    await pollEvmRelays(sender);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({
      status: 'failed',
      reservationState: 'released',
      sponsor: 'tendr',
      lastError: 'reverted on chain',
    });
    expect(sp.lossRecognizedAt).not.toBeNull();
    expect(sp.costUsd!.toFixed()).toBe('0.11');
  });
});
