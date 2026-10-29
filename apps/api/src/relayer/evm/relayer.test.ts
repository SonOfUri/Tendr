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
import { resetTokenCache, tokenList } from '../../checkout/tokens.js';
import { pollDeposit, registerWatcherHooks } from '../../checkout/watcher.js';
import { fakeNearClient, resetNearClients } from '../../near/client.js';
import { scopedDb } from '../../db/scoped.js';
import { resetFeeCache, setFeeDeps } from '../../gas/fees.js';
import { putGasPolicy } from '../../gas/policy.js';
import { evmAddress, getKeyVault } from '../../keyvault/index.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getRedis } from '../../lib/redis.js';
import { FakeEvmNode, RpcRefusal } from '../../test/fake-evm-node.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../../test/helpers.js';
import { isolatedSimStore } from '../../test/sim-1click.js';
import { gaslessQuote, pollEvmRelays, resetRelayers } from '../index.js';
import { releaseEndedSessionReservations } from '../submissions.js';
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
  let sim: SimulatedOneClick;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    resetFeeCache();
    resetNearClients();
    fakeNearClient(false);
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Live cost pricing reads the native coin's price: ETH on Base at $2500 (test-mode quotes use
    // the simulator's list).
    setFeeDeps({
      tokens: async (livemode) =>
        livemode
          ? new Map([
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
            ])
          : tokenList(false),
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
    resetNearClients();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  /** A sponsored eip3009 quote, its relayer context, and the shopper's signatures. */
  async function sponsoredQuote(gasPayer?: 'shopper') {
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

  /** A `TendrPaid` log from the forwarder, as a receipt carries it. */
  function tendrPaid(
    q: { quote: { depositAddress: string; amountIn: { toFixed(): string } } },
    fee: bigint,
  ) {
    const log = iface.encodeEventLog('TendrPaid', [
      shopper.address,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      q.quote.depositAddress,
      BigInt(q.quote.amountIn.toFixed()),
      fee,
      '0x' + '00'.repeat(32),
    ]);
    return { address: FORWARDER, topics: log.topics, data: log.data };
  }

  const month = () =>
    prisma.gasBudgetMonth.findFirstOrThrow({ where: { merchantId: merchant.id } });

  it('relays one forwarder transaction; the reservation is settled only when the payment is collected', async () => {
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
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: q.quote.id } })).depositTxHash,
    ).toBe(tx.hash);

    // Mined: the outcome records the cost, but the merchant is not charged yet.
    node.mine(tx.hash!, 1, 80_000n, [tendrPaid(q, 0n)]);
    expect(await pollEvmRelays(sender)).toBe(1);
    sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ status: 'confirmed', reservationState: 'reserved' });
    expect(sp.gasUsed!.toFixed()).toBe('80000');
    // 80 000 gas × 1.1 gwei × $2500 = $0.22 (the merchant is charged the $0.048 estimate).
    expect(sp.costUsd!.toFixed()).toBe('0.22');
    expect((await month()).spentUsd.toFixed()).toBe('0');
    expect(await prisma.payment.count()).toBe(0);
    expect(await pollEvmRelays(sender)).toBe(0);

    // The payment arrives and its proceeds are collected: settled at the estimate.
    await sim.simulate(q.quote.depositAddress, 'exact', { senderAddress: shopper.address });
    await pollDeposit(q.quote.depositAddress, { livemode: false });
    const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: q.quote.id } });
    expect(p.status).toBe('SETTLED');
    sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ reservationState: 'settled', recoveredFromPaymentId: p.id });
    expect((await month()).spentUsd.toFixed()).toBe('0.048');
    expect((await month()).reservedUsd.toFixed()).toBe('0');
  });

  it('front-run: our relay reverts, the reservation stays held, then the payment arrives and it is settled', async () => {
    const { q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    node.mine(res.txHash!, 0, 40_000n);
    await pollEvmRelays(sender);
    let sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({
      status: 'failed',
      reservationState: 'reserved',
      sponsor: 'merchant',
    });
    expect(sp.lossRecognizedAt).toBeNull();

    // Someone else executed the shopper's authorization: the deposit is there all the same.
    await sim.simulate(q.quote.depositAddress, 'exact', { senderAddress: shopper.address });
    await pollDeposit(q.quote.depositAddress, { livemode: false });
    sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp.reservationState).toBe('settled');
    expect((await month()).spentUsd.toFixed()).toBe('0.048');
    // The session settled: nothing for the session-end sweep to do.
    expect(await releaseEndedSessionReservations()).toBe(0);
  });

  it('the OP-stack L1 data fee is part of the recorded relay cost (and of a loss)', async () => {
    const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
    // 80 000 gas × 1.1 gwei = 88 000 gwei, plus a 40 000 gwei L1 fee: 128 000 gwei × $2500.
    node.receipts.get(res.txHash!)!.l1Fee = 40_000_000_000_000n;
    await pollEvmRelays(sender);
    let sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp.costUsd!.toFixed()).toBe('0.32');
    await prisma.session.update({ where: { id: s.id }, data: { status: 'REFUNDED' } });
    await releaseEndedSessionReservations();
    sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ sponsor: 'tendr' });
    expect(sp.costUsd!.toFixed()).toBe('0.32');
  });

  it('partial loss: a sponsored relay costing more than its estimate records the excess (loss cap)', async () => {
    const { q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
    await pollEvmRelays(sender);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    // $0.22 actual − $0.048 the merchant is charged = $0.172 Tendr does not recover.
    expect(sp).toMatchObject({ sponsor: 'merchant', status: 'confirmed' });
    expect(sp.unrecoveredUsd!.toFixed()).toBe('0.172');
    expect(sp.unrecoveredAt).not.toBeNull();
  });

  it('the 7-day sweep releases a confirmed relay hold never collected, with its gas as a loss', async () => {
    const { releaseStuckConfirmedHolds, STUCK_HOLD_AFTER_MS } = await import('../submissions.js');
    const { q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
    await pollEvmRelays(sender);
    const deadline = q.quote.deadline.getTime();
    // Before 7 days past the quote deadline: kept (the payment may still be collected).
    expect(await releaseStuckConfirmedHolds(new Date(deadline + STUCK_HOLD_AFTER_MS - 1000))).toBe(
      0,
    );
    let sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp.reservationState).toBe('reserved');
    // After: released, the gas recognised as Tendr's loss, once.
    const at = new Date(deadline + STUCK_HOLD_AFTER_MS + 1000);
    expect(await releaseStuckConfirmedHolds(at)).toBe(1);
    sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ reservationState: 'released', sponsor: 'tendr' });
    expect(sp.costUsd!.toFixed()).toBe('0.22');
    expect(sp.lossRecognizedAt).toEqual(at);
    expect((await month()).reservedUsd.toFixed()).toBe('0');
    expect(await releaseStuckConfirmedHolds(at)).toBe(0);
  });

  it('a session that ends refunded after the relay: released, and the gas spent is a Tendr loss', async () => {
    const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
    await pollEvmRelays(sender);
    // Still in flight → not released; the stale-quote sweep never sees it (deposit reported).
    expect(await releaseEndedSessionReservations()).toBe(0);
    await prisma.session.update({ where: { id: s.id }, data: { status: 'REFUNDED' } });
    expect(await releaseEndedSessionReservations()).toBe(1);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ reservationState: 'released', sponsor: 'tendr' });
    expect(sp.costUsd!.toFixed()).toBe('0.22');
    expect(sp.lossRecognizedAt).not.toBeNull();
    expect((await month()).reservedUsd.toFixed()).toBe('0');
    expect((await month()).spentUsd.toFixed()).toBe('0');
    expect(await releaseEndedSessionReservations()).toBe(0);
  });

  it('a relay still in flight when the session expires keeps its hold until it is final', async () => {
    const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
    const res = await relayer.submit(q, { signatures });
    await prisma.session.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
    expect(await releaseEndedSessionReservations()).toBe(0);
    node.mine(res.txHash!, 0, 40_000n);
    await pollEvmRelays(sender);
    expect(await releaseEndedSessionReservations()).toBe(1);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ reservationState: 'released', sponsor: 'tendr' });
    expect(sp.costUsd!.toFixed()).toBe('0.11');
  });

  describe('shopper pays the fee in the token: revenue from what the receipt moved', () => {
    it('the fee moved → fee_collected and gas_reimbursement revenue for that amount', async () => {
      const { q, signatures } = await sponsoredQuote('shopper');
      expect(Object.keys(signatures)).toEqual(['payment', 'fee']);
      const res = await relayer.submit(q, { signatures });
      node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 48_000n)]);
      await pollEvmRelays(sender);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: res.submissionId },
      });
      expect(sp).toMatchObject({ sponsor: 'shopper', status: 'confirmed' });
      expect(sp.feeCollected!.toFixed()).toBe('48000');
      await sim.simulate(q.quote.depositAddress, 'exact', { senderAddress: shopper.address });
      await pollDeposit(q.quote.depositAddress, { livemode: false });
      const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: q.quote.id } });
      const gas = await prisma.revenueEntry.findMany({
        where: { paymentId: p.id, reference: sp.id },
      });
      expect(gas.map((g) => [g.source, g.amount.toFixed()])).toEqual([
        ['gas_reimbursement', '48000'],
      ]);
    });

    it('the fee authorization was cancelled (moved 0) → no revenue, the gas is a Tendr loss', async () => {
      const { q, signatures } = await sponsoredQuote('shopper');
      const res = await relayer.submit(q, { signatures });
      node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
      await pollEvmRelays(sender);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: res.submissionId },
      });
      expect(sp).toMatchObject({ status: 'confirmed', sponsor: 'tendr' });
      expect(sp.feeCollected!.toFixed()).toBe('0');
      expect(sp.lossRecognizedAt).not.toBeNull();
      expect(sp.costUsd!.toFixed()).toBe('0.22');
      await sim.simulate(q.quote.depositAddress, 'exact', { senderAddress: shopper.address });
      await pollDeposit(q.quote.depositAddress, { livemode: false });
      expect(await prisma.revenueEntry.count({ where: { reference: sp.id } })).toBe(0);
    });
  });

  it('a payload that does not match makes no RPC call at all', async () => {
    const { q, signatures } = await sponsoredQuote();
    signatures.payment!.message.value = '1';
    await expect(relayer.submit(q, { signatures })).rejects.toMatchObject({
      code: 'GASLESS_PAYLOAD_MISMATCH',
    });
    expect(node.calls).toHaveLength(0);
  });

  it('a dry run that reverts: 409, nothing sent, the reservation still held, session open', async () => {
    const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
    node.once('eth_estimateGas', () => {
      throw new RpcRefusal(3, 'execution reverted: FiatTokenV2: authorization is used or canceled');
    });
    const err = await relayer.submit(q, { signatures }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'GASLESS_SUBMIT_FAILED', status: 409 });
    expect(node.count('eth_sendRawTransaction')).toBe(0);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ status: 'pending', quoteId: null, reservationState: 'reserved' });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PENDING_DEPOSIT',
    );
  });

  it('a KMS failure before broadcast: not stuck, the reservation held, a retry relays', async () => {
    const { q, signatures, sponsorshipId } = await sponsoredQuote();
    const kv = getKeyVault();
    vi.spyOn(kv, 'sign').mockRejectedValueOnce(new Error('KMS unavailable'));
    await expect(relayer.submit(q, { signatures })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
    });
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ status: 'pending', quoteId: null, reservationState: 'reserved' });
    expect(sp.lastError).toMatch(/unavailable/);
    expect(node.sent).toHaveLength(0);

    // (A database failure on the row insert takes the same path: sender.test.ts.)
    const res = await relayer.submit(q, { signatures });
    expect(res).toMatchObject({ submissionId: sponsorshipId, status: 'submitted' });
    expect(node.sent).toHaveLength(1);
  });

  /** A new sponsored quote on the same session (a re-quote), as the pay page asks for it. */
  async function requote(secret: string) {
    const qr = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        origin_asset: USDC_BASE,
        wallet_address: shopper.address,
        gasless_method: 'eip3009',
      },
    });
    expect(qr.statusCode, qr.body).toBe(201);
    return prisma.quote.findUniqueOrThrow({ where: { id: qr.json().id as string } });
  }

  describe('outcomes apply per relayer transaction (N1)', () => {
    it("a broadcast the node refused never fails the retry, and the retry's own outcome is recorded", async () => {
      const { q, signatures, sponsorshipId } = await sponsoredQuote();
      node.once('eth_sendRawTransaction', () => {
        throw new RpcRefusal(-32000, 'insufficient funds for gas * price + value');
      });
      await expect(relayer.submit(q, { signatures })).rejects.toMatchObject({ status: 503 });
      const refused = await prisma.relayerTransaction.findFirstOrThrow();
      expect(refused.status).toBe('failed');
      expect(refused.outcomeHandledAt).not.toBeNull();

      // The poller runs before the retry: nothing changes.
      expect(await pollEvmRelays(sender)).toBe(0);
      let sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
      expect(sp).toMatchObject({ status: 'pending', quoteId: null, reservationState: 'reserved' });

      // The retry relays; its real outcome and gas are recorded.
      const res = await relayer.submit(q, { signatures });
      expect(res.status).toBe('submitted');
      expect(await pollEvmRelays(sender)).toBe(0);
      node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
      expect(await pollEvmRelays(sender)).toBe(1);
      sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
      expect(sp).toMatchObject({ status: 'confirmed', txHash: res.txHash });
      expect(sp.gasUsed!.toFixed()).toBe('80000');
      expect(sp.relayerTxId).not.toBe(refused.id);
    });

    it("an outcome for another transaction than the submission's is ignored", async () => {
      const { q, signatures, sponsorshipId } = await sponsoredQuote();
      await relayer.submit(q, { signatures });
      const { applyRelayOutcome } = await import('../submissions.js');
      const applied = await applyRelayOutcome(sponsorshipId, {
        status: 'failed',
        txHash: null,
        gasUsed: 1n,
        costUsd: '1',
        reason: 'x',
        feeMoved: null,
        relayerTxId: 'rtx_someoneelse',
      });
      expect(applied).toBe(false);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
      expect(sp.status).toBe('submitted');
    });
  });

  describe('superseded holds are released when the session is paid on another quote (N2)', () => {
    it('a re-quote after a failed relay releases the old hold with its gas as a loss, once', async () => {
      const { s, q, signatures, sponsorshipId: oldId } = await sponsoredQuote();
      const res = await relayer.submit(q, { signatures });
      node.mine(res.txHash!, 0, 40_000n);
      await pollEvmRelays(sender);
      // The deadline passes; the shopper asks for a new quote.
      await prisma.quote.update({
        where: { id: q.quote.id },
        data: { deadline: new Date(Date.now() - 1000) },
      });
      const fresh = await requote(s.client_secret);
      let old = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: oldId } });
      expect(old).toMatchObject({ reservationState: 'released', sponsor: 'tendr' });
      expect(old.costUsd!.toFixed()).toBe('0.11');
      const lossAt = old.lossRecognizedAt;
      expect(lossAt).not.toBeNull();

      // Paid on the new quote (copy-address): new hold settled, old untouched, loss counted once.
      await sim.simulate(fresh.depositAddress, 'exact', { senderAddress: shopper.address });
      await pollDeposit(fresh.depositAddress, { livemode: false });
      const neu = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: fresh.gasSponsorshipId! },
      });
      expect(neu.reservationState).toBe('settled');
      old = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: oldId } });
      expect(old.lossRecognizedAt).toEqual(lossAt);
      expect((await month()).reservedUsd.toFixed()).toBe('0');
      expect((await month()).spentUsd.toFixed()).toBe('0.048');
      expect(await releaseEndedSessionReservations()).toBe(0);
    });

    it('a relay in flight at re-quote keeps its hold; it is released when another quote is collected', async () => {
      const { s, q, signatures, sponsorshipId: oldId } = await sponsoredQuote();
      const res = await relayer.submit(q, { signatures });
      // The watcher superseded the quote (as after a failed swap) while the relay is still pending.
      await prisma.quote.update({
        where: { id: q.quote.id },
        data: { supersededAt: new Date(), deadline: new Date(Date.now() - 1000) },
      });
      const fresh = await requote(s.client_secret);
      expect(
        (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: oldId } })).reservationState,
      ).toBe('reserved');
      // The old relay then reverts.
      node.mine(res.txHash!, 0, 40_000n);
      await pollEvmRelays(sender);

      await sim.simulate(fresh.depositAddress, 'exact', { senderAddress: shopper.address });
      await pollDeposit(fresh.depositAddress, { livemode: false });
      const old = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: oldId } });
      expect(old).toMatchObject({ reservationState: 'released', sponsor: 'tendr' });
      expect(old.costUsd!.toFixed()).toBe('0.11');
      expect(
        (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: fresh.gasSponsorshipId! } }))
          .reservationState,
      ).toBe('settled');
      expect((await month()).reservedUsd.toFixed()).toBe('0');
      expect((await month()).spentUsd.toFixed()).toBe('0.048');
    });
  });

  describe('a confirmed relay waits for its payment to be collected (N4)', () => {
    it('re-quote after the deadline keeps the hold, no loss; the old quote is then collected and settled', async () => {
      const { s, q, signatures, sponsorshipId: oldId } = await sponsoredQuote();
      const res = await relayer.submit(q, { signatures });
      node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
      await pollEvmRelays(sender);
      // Mined near its deadline; the watcher has not detected the deposit yet. The shopper re-quotes.
      await prisma.quote.update({
        where: { id: q.quote.id },
        data: { deadline: new Date(Date.now() - 1000) },
      });
      const fresh = await requote(s.client_secret);
      let old = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: oldId } });
      expect(old).toMatchObject({
        status: 'confirmed',
        reservationState: 'reserved',
        sponsor: 'merchant',
      });
      expect(old.lossRecognizedAt).toBeNull();
      expect(await releaseEndedSessionReservations()).toBe(0);

      // The relayed deposit is detected and collected on the old quote.
      await sim.simulate(q.quote.depositAddress, 'exact', { senderAddress: shopper.address });
      await pollDeposit(q.quote.depositAddress, { livemode: false });
      const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: q.quote.id } });
      expect(p.status).toBe('SETTLED');
      old = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: oldId } });
      expect(old).toMatchObject({ reservationState: 'settled', recoveredFromPaymentId: p.id });
      expect(old.lossRecognizedAt).toBeNull();
      // The unused re-quote's hold is released, with no loss (nothing was relayed).
      const neu = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: fresh.gasSponsorshipId! },
      });
      expect(neu).toMatchObject({ reservationState: 'released', sponsor: 'merchant' });
      expect((await month()).spentUsd.toFixed()).toBe('0.048');
      expect((await month()).reservedUsd.toFixed()).toBe('0');
      expect(
        await prisma.gasSponsorship.count({ where: { lossRecognizedAt: { not: null } } }),
      ).toBe(0);
    });

    it('a confirmed relay whose session ends refunded: released with its gas as a loss, once', async () => {
      const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
      const res = await relayer.submit(q, { signatures });
      node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
      await pollEvmRelays(sender);
      await prisma.session.update({ where: { id: s.id }, data: { status: 'REFUNDED' } });
      expect(await releaseEndedSessionReservations()).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
      expect(sp).toMatchObject({ reservationState: 'released', sponsor: 'tendr' });
      const at = sp.lossRecognizedAt;
      expect(at).not.toBeNull();
      expect(await releaseEndedSessionReservations()).toBe(0);
      expect(
        (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } }))
          .lossRecognizedAt,
      ).toEqual(at);
    });

    it('a confirmed relay is not released by the SETTLED sweep', async () => {
      const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
      const res = await relayer.submit(q, { signatures });
      node.mine(res.txHash!, 1, 80_000n, [tendrPaid(q, 0n)]);
      await pollEvmRelays(sender);
      await prisma.session.update({ where: { id: s.id }, data: { status: 'SETTLED' } });
      expect(await releaseEndedSessionReservations()).toBe(0);
      expect(
        (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } }))
          .reservationState,
      ).toBe('reserved');
    });
  });

  it('the receipt Transfer fallback never books more than the signed fee (N5)', async () => {
    const { q, signatures } = await sponsoredQuote('shopper');
    const res = await relayer.submit(q, { signatures });
    const feeTo = evmAddress((await getKeyVault().publicKey('gas-fees-evm')).raw);
    const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
    const transfer = {
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        pad(shopper.address),
        pad(feeTo),
      ],
      data: '0x' + 1_000_000n.toString(16).padStart(64, '0'),
    };
    node.mine(res.txHash!, 1, 80_000n, [transfer, tendrPaid(q, 0n)]);
    await pollEvmRelays(sender);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: res.submissionId } });
    expect(sp.feeCollected!.toFixed()).toBe('48000');
  });

  it('fee leg front-run inside the same transaction: the Transfer to the gas-fee address counts (N3)', async () => {
    const { q, signatures } = await sponsoredQuote('shopper');
    const res = await relayer.submit(q, { signatures });
    const feeTo = evmAddress((await getKeyVault().publicKey('gas-fees-evm')).raw);
    const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
    const transfer = {
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        pad(shopper.address),
        pad(feeTo),
      ],
      data: '0x' + 48_000n.toString(16).padStart(64, '0'),
    };
    node.mine(res.txHash!, 1, 80_000n, [transfer, tendrPaid(q, 0n)]);
    await pollEvmRelays(sender);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: res.submissionId } });
    expect(sp).toMatchObject({ status: 'confirmed', sponsor: 'shopper' });
    expect(sp.feeCollected!.toFixed()).toBe('48000');
    expect(sp.lossRecognizedAt).toBeNull();
  });

  describe('used or cancelled authorizations and the loss cap (final review I1)', () => {
    const AUTH_STATE = new Interface([
      'function authorizationState(address,bytes32) view returns (bool)',
    ]).getFunction('authorizationState')!.selector;
    const TRUE = '0x' + '0'.repeat(63) + '1';

    for (const leg of ['payment', 'fee'] as const) {
      it(`a cancelled ${leg} authorization is refused before any gas: nothing broadcast`, async () => {
        const { s, q, signatures } = await sponsoredQuote('shopper');
        const { gaslessNonce } = await import('./payment.js');
        const nonce = gaslessNonce(q.quote.id, leg).slice(2).toLowerCase();
        node.ethCall = (_to, data) =>
          data.startsWith(AUTH_STATE) && data.toLowerCase().endsWith(nonce)
            ? TRUE
            : '0x' + '0'.repeat(64);
        await expect(relayer.submit(q, { signatures })).rejects.toMatchObject({
          code: 'QUOTE_EXPIRED',
          status: 409,
        });
        expect(node.count('eth_estimateGas')).toBe(0);
        expect(node.count('eth_sendRawTransaction')).toBe(0);
        expect(await prisma.gasSponsorship.count({ where: { sessionId: s.id } })).toBe(0);
      });
    }

    it('an unreadable authorization state fails closed (503), nothing broadcast', async () => {
      const { q, signatures } = await sponsoredQuote();
      node.once('eth_call', () => {
        throw new Error('connection reset');
      });
      await expect(relayer.submit(q, { signatures })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
      expect(node.count('eth_sendRawTransaction')).toBe(0);
    });

    it('the daily loss cap stops options, prepare and submit; nothing broadcast', async () => {
      const { s, q, signatures } = await sponsoredQuote('shopper');
      await prisma.gasSponsorship.create({
        data: {
          id: `gas_capped${Date.now()}`,
          merchantId: merchant.id,
          livemode: false,
          sessionId: s.id,
          chain: 'base',
          method: 'eip3009',
          provider: 'relayer-evm',
          sponsor: 'tendr',
          status: 'failed',
          costUsd: '1000',
          lossRecognizedAt: new Date(),
        },
      });
      await expect(relayer.prepare(q, {})).rejects.toMatchObject({
        code: 'GASLESS_NOT_AVAILABLE',
      });
      await expect(relayer.submit(q, { signatures })).rejects.toMatchObject({
        code: 'GASLESS_NOT_AVAILABLE',
      });
      expect(node.calls).toHaveLength(0);
    });
  });

  it('re-quote is refused while a relay is claimed with an unknown outcome (final review I3)', async () => {
    const { s, q, signatures, sponsorshipId } = await sponsoredQuote();
    // The broadcast step dies after the claim without a known outcome (a 5xx to the browser).
    vi.spyOn(sender, 'send').mockRejectedValueOnce(new Error('database went away'));
    await expect(relayer.submit(q, { signatures })).rejects.toThrow('database went away');
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sponsorshipId } });
    expect(sp).toMatchObject({ status: 'pending', quoteId: q.quote.id });
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: q.quote.id } })).depositTxSubmittedAt,
    ).toBeNull();

    const qr = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${s.client_secret}` },
      payload: { origin_asset: USDC_BASE, wallet_address: shopper.address },
    });
    expect(qr.statusCode, qr.body).toBe(409);
    expect(qr.json().error.code).toBe('DEPOSIT_IN_PROGRESS');
    // The expiry paths treat the claimed relay as a deposit in flight.
    const { depositInFlight } = await import('../../checkout/in-flight.js');
    const session = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(await depositInFlight(prisma, session, new Date())).toBe('reported');
  });
});
