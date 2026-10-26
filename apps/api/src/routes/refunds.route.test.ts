// `POST /v1/refunds` (WooCommerce plugin spec §7, Task 5): merchant-initiated refunds become
// signer-approved `refund` proposals through the checkout-core return path. The API never moves
// funds by itself.
import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { balancesCacheKey } from '../accounts/accounts.js';
import { buildApp } from '../app.js';
import { getRedis } from '../lib/redis.js';
import { MemoryMailer, setMailer } from '../auth/mailer.js';
import { LEGAL_ACK_PHRASE } from '@tendr/contracts';
import { acknowledgeLegal, refundFromReview, reviewQueue } from '../checkout/review.js';
import type { DashboardUserPrincipal } from '../gateway/principal.js';
import {
  draftReturn,
  holdMerchantRefund,
  onRefundProposalCancelled,
  onRefundProposalExecuted,
  onRefundProposalFailed,
  queueReturn,
  registerRefundHooks,
  setRefundDeps,
  sweepReturns,
} from '../checkout/refunds.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { onScreeningAllowed } from '../checkout/screening.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { webhookData } from '../checkout/webhooks.js';
import {
  onReturnNeeded,
  pollDeposit,
  registerWatcherHooks,
  setWatcherDeps,
} from '../checkout/watcher.js';
import { resetFxCache } from '../checkout/fx.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import { dashHeaders, loginAs } from '../test/dashboard.js';
import { createApiKey, createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';

const sim1click = isolatedSimStore();
const ETH = 'nep141:eth.omft.near'; // the shopper pays in ETH on `eth`
// USDC bridged from Ethereum ($1, 6 decimals): the settlement asset, returnable to an `eth` wallet.
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const FEE_UNITS = 500_000n; // the $0.50 evm return-fee estimate in USDC base units
const usdc = (usd: string) => BigInt(Math.round(Number(usd) * 100)) * 10_000n;

describe('POST /v1/refunds', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let key: string;
  let sim: SimulatedOneClick;
  let fake: FakeNearClient;
  let balance: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const ctx = () => ({ merchantId: merchant.id, livemode: false });

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    await resetFxCache();
    resetTokenCache();
    resetNearClients();
    fake = fakeNearClient(false);
    balance = '1000000000000'; // $1M of USDC in the merchant account
    fake.scriptView(fake.scope.intentsContractId, 'mt_batch_balance_of', (args) =>
      (args as { token_ids: string[] }).token_ids.map(() => balance),
    );
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    registerRefundHooks();
    setMailer(new MemoryMailer());
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({
      name: 'Bean Shop',
      defaultFeePayer: 'payer',
      defaultGasPayer: 'buyer',
    });
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC_ETH,
      destChain: 'eth',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    key = (await createApiKey(merchant.id, { livemode: false })).raw;
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    vi.restoreAllMocks();
    setWatcherDeps(null);
    setRefundDeps(null);
    onReturnNeeded(null);
    onScreeningAllowed(null);
    setMailer(null);
    resetTokenCache();
    resetOneClickProviders();
    resetNearClients();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  async function newSession(body: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        amount: '49.00',
        amount_currency: 'USD',
        external_ref: `order-${Math.random().toString(36).slice(2)}`,
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
        ...body,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; client_secret: string };
  }

  /** A paid and settled order (exact payment in ETH from the simulated sender's `eth` wallet). */
  async function settled(body: Record<string, unknown> = {}, sender?: string) {
    const s = await newSession(body);
    const q = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${s.client_secret}` },
      payload: { origin_asset: ETH },
    });
    expect(q.statusCode, q.body).toBe(201);
    const quote = q.json() as { id: string; deposit_address: string };
    await sim.simulate(quote.deposit_address, 'exact', sender ? { senderAddress: sender } : {});
    await pollDeposit(quote.deposit_address, { livemode: false });
    const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
    expect(p.status).toBe('SETTLED');
    return { s, p };
  }

  function refund(body: Record<string, unknown>, opts: { key?: string; idem?: string } = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: {
        authorization: `Bearer ${opts.key ?? key}`,
        ...(opts.idem ? { 'idempotency-key': opts.idem } : {}),
      },
      payload: body,
    });
  }

  const refundsOf = (paymentId: string) =>
    prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });
  const eventsOf = (type: string) =>
    prisma.event.findMany({
      where: { merchantId: merchant.id, type },
      orderBy: { createdAt: 'asc' },
    });

  function proposalEvent(type: string, proposalId: string) {
    return prisma.event.create({
      data: {
        id: newId('evt'),
        merchantId: merchant.id,
        livemode: false,
        aggregateType: 'account_proposal',
        aggregateId: proposalId,
        type,
        payload: { proposalId, kind: 'refund', txHash: `tx-${proposalId}` },
      },
    });
  }
  const execute = async (proposalId: string) =>
    onRefundProposalExecuted(await proposalEvent('account.proposal.executed', proposalId));

  // ─── the brief ─────────────────────────────────────────────────────────────

  it('refund 10.00 of a 49.00 settled payment drafts one system proposal returning exactly 10.00 worth to the sender', async () => {
    const { p } = await settled();
    const res = await refund({ payment: p.id, amount: '10.00', external_ref: 'wc-101' });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'pending',
      amount_usd: '10.00',
      refund_external_ref: 'wc-101',
    });
    expect(typeof body.created).toBe('number');
    const [r] = await refundsOf(p.id);
    expect(body.id).toBe(r!.id);
    expect(r).toMatchObject({
      reason: 'merchant',
      externalRef: 'wc-101',
      assetId: USDC_ETH,
      destination: p.senderAddress,
      destinationChain: 'eth',
      reviewReason: null,
    });
    expect(r!.requestedAmountUsd!.toFixed(2)).toBe('10.00');
    // The merchant pays the network cost: the return is grossed up by the return-fee estimate.
    expect(r!.returnFee!.toFixed()).toBe(FEE_UNITS.toString());
    expect(r!.amount.toFixed()).toBe((usdc('10.00') + FEE_UNITS).toString());
    const props = await prisma.accountProposal.findMany();
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      kind: 'refund',
      status: 'draft',
      createdByUserId: null,
      refundId: r!.id,
    });
    expect(props[0]!.action).toEqual({
      refund: {
        asset: USDC_ETH,
        amount: (usdc('10.00') + FEE_UNITS).toString(),
        destination_chain: 'eth',
        destination: p.senderAddress,
        payment_id: p.id,
        route: {
          poa: { token_contract: 'eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near' },
        },
      },
    });
    // Nothing moved: the payment stays SETTLED until the signers' proposal executes.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'SETTLED',
    );
  });

  it('two partial refunds with different external_ref both draft', async () => {
    const { p } = await settled();
    expect((await refund({ payment: p.id, amount: '10.00', external_ref: 'a' })).statusCode).toBe(
      201,
    );
    expect((await refund({ payment: p.id, amount: '15.50', external_ref: 'b' })).statusCode).toBe(
      201,
    );
    const rows = await refundsOf(p.id);
    expect(rows.map((r) => r.externalRef)).toEqual(['a', 'b']);
    expect(rows.every((r) => r.proposalId !== null)).toBe(true);
    expect(await prisma.accountProposal.count()).toBe(2);
  });

  it('third refund exceeding remaining → AMOUNT_EXCEEDS_REFUNDABLE', async () => {
    const { p } = await settled();
    await refund({ payment: p.id, amount: '20.00', external_ref: 'a' });
    await refund({ payment: p.id, amount: '20.00', external_ref: 'b' });
    const res = await refund({ payment: p.id, amount: '9.01', external_ref: 'c' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
    expect(await refundsOf(p.id)).toHaveLength(2);
    // Exactly the rest is fine.
    expect((await refund({ payment: p.id, amount: '9.00', external_ref: 'd' })).statusCode).toBe(
      201,
    );
  });

  it('two concurrent refunds that together exceed → exactly one succeeds', async () => {
    const { p } = await settled();
    const res = await Promise.all([
      refund({ payment: p.id, amount: '30.00', external_ref: 'x' }),
      refund({ payment: p.id, amount: '30.00', external_ref: 'y' }),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const refused = res.find((r) => r.statusCode === 409)!;
    expect(refused.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
    expect(await refundsOf(p.id)).toHaveLength(1);
  });

  it('same external_ref + same amount → returns existing; different amount → CONFLICT', async () => {
    const { p } = await settled();
    const first = await refund({ payment: p.id, amount: '10.00', external_ref: 'wc-7' });
    expect(first.statusCode).toBe(201);
    const again = await refund({ payment: p.id, amount: '10.00', external_ref: 'wc-7' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    const other = await refund({ payment: p.id, amount: '11.00', external_ref: 'wc-7' });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('CONFLICT');
    expect(await refundsOf(p.id)).toHaveLength(1);
    expect(await prisma.accountProposal.count()).toBe(1);
  });

  it('Idempotency-Key is honoured', async () => {
    const { p } = await settled();
    const a = await refund({ payment: p.id, amount: '5.00', external_ref: 'i' }, { idem: 'k1' });
    const b = await refund({ payment: p.id, amount: '5.00', external_ref: 'i' }, { idem: 'k1' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
  });

  it('refund of an unsettled payment → PAYMENT_NOT_REFUNDABLE', async () => {
    const p = await createRow('Payment', merchant.id, false, { status: 'PROCESSING' });
    const res = await refund({ payment: p.id, amount: '1.00', external_ref: 'u' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_NOT_REFUNDABLE');
    expect(await prisma.refund.count()).toBe(0);
  });

  it('sanctioned sender → status review, no draft', async () => {
    const { p } = await settled();
    setRefundDeps({ screen: async () => ({ decision: 'block' }) });
    const res = await refund({ payment: p.id, amount: '10.00', external_ref: 's' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe('review');
    const [r] = await refundsOf(p.id);
    expect(r).toMatchObject({ reviewReason: 'sanctions', proposalId: null });
    expect(await prisma.accountProposal.count()).toBe(0);
    // The held-payment rules now apply: a later refund waits for the legal acknowledgement.
    const next = await refund({ payment: p.id, amount: '5.00', external_ref: 's2' });
    expect(next.statusCode).toBe(201);
    expect(next.json().status).toBe('review');
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  it("refund in NGN converts with the payment's stored rate", async () => {
    // Test rates: 1 USD = 1602.04 NGN → 78,500.00 NGN = 49.0006 → $49.01 (rounded up).
    const { s, p } = await settled({ amount: '78500.00', amount_currency: 'NGN' });
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.amount.toFixed(2)).toBe('49.01');
    expect(row.fxRate!.toFixed()).toBe('1602.04');
    const res = await refund({
      payment: p.id,
      amount: '16020.40',
      currency: 'NGN',
      external_ref: 'n1',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().amount_usd).toBe('10.00');
    // The rate stored on the session is the one used, never a fresh one.
    await prisma.session.update({ where: { id: s.id }, data: { fxRate: '1000' } });
    const stored = await refund({
      payment: p.id,
      amount: '5000.00',
      currency: 'NGN',
      external_ref: 'n2',
    });
    expect(stored.json().amount_usd).toBe('5.00');
    const bad = await refund({ payment: p.id, amount: '10', currency: 'EUR', external_ref: 'n3' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('UNSUPPORTED_CURRENCY');
  });

  it('a full refund in NGN after partials equals exactly the remaining amount', async () => {
    const { p } = await settled({ amount: '78500.00', amount_currency: 'NGN' });
    // 0.16 NGN = $0.0001 → rounded up to $0.01; the rest (78,499.84 NGN = $49.0005) also rounds
    // up, to $49.01 — one cent more than the $49.00 left. Clamped to exactly what is left.
    const a = await refund({ payment: p.id, amount: '0.16', currency: 'NGN', external_ref: 'p1' });
    expect(a.json().amount_usd).toBe('0.01');
    const b = await refund({
      payment: p.id,
      amount: '78499.84',
      currency: 'NGN',
      external_ref: 'p2',
    });
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json().amount_usd).toBe('49.00');
    // Far beyond what is left is still refused, never clamped.
    const c = await refund({
      payment: p.id,
      amount: '1602.04',
      currency: 'NGN',
      external_ref: 'p3',
    });
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
  });

  it('key without refunds:write → 403', async () => {
    const { p } = await settled();
    const narrow = (
      await createApiKey(merchant.id, { livemode: false, scopes: ['sessions:write'] })
    ).raw;
    const res = await refund({ payment: p.id, amount: '1.00', external_ref: 'k' }, { key: narrow });
    expect(res.statusCode).toBe(403);
    expect(await prisma.refund.count()).toBe(0);
  });

  it('cancelled refund frees its amount for a new refund', async () => {
    const { p } = await settled();
    const first = await refund({ payment: p.id, amount: '40.00', external_ref: 'c1' });
    expect(first.statusCode).toBe(201);
    expect((await refund({ payment: p.id, amount: '10.00', external_ref: 'c2' })).statusCode).toBe(
      409,
    );
    const [r] = await refundsOf(p.id);
    await onRefundProposalCancelled(
      await proposalEvent('account.proposal.cancelled', r!.proposalId!),
    );
    const [cancelled] = await eventsOf('refund.cancelled');
    expect(webhookData(cancelled!.payload, 'refund.cancelled')).toMatchObject({
      refund_id: r!.id,
      refund_external_ref: 'c1',
      status: 'cancelled',
    });
    // A store refund that ended is closed: no review item, no internal review mail, no redraft.
    expect(await eventsOf('refund.needs_review')).toEqual([]);
    const queue = await reviewQueue(ctx());
    expect(queue.returns.map((x) => x.id)).not.toContain(r!.id);
    await sweepReturns();
    expect(await prisma.accountProposal.count()).toBe(1);
    // Its amount is free again.
    const again = await refund({ payment: p.id, amount: '40.00', external_ref: 'c3' });
    expect(again.statusCode, again.body).toBe(201);
    // Replaying the cancelled one's ref reports it as cancelled (WooCommerce removed it).
    const replay = await refund({ payment: p.id, amount: '40.00', external_ref: 'c1' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe('cancelled');
  });

  // ─── rulings ───────────────────────────────────────────────────────────────

  describe('connection keys (W8)', () => {
    async function connection(o: Record<string, unknown> = {}) {
      return (await createRow('Connection', merchant.id, false, o)).id as string;
    }
    async function keyFor(connectionId: string) {
      const k = await createApiKey(merchant.id, { livemode: false });
      await prisma.apiKey.update({ where: { id: k.record.id }, data: { connectionId } });
      return k.raw;
    }
    async function settledOn(connectionId: string | null) {
      const { p, s } = await settled();
      await prisma.session.update({ where: { id: s.id }, data: { connectionId } });
      return p;
    }

    it('a re-connected site refunds payments made through its predecessor', async () => {
      const b = await connection();
      const a = await connection({ revokedAt: new Date(), replacedById: b });
      const p = await settledOn(a);
      const res = await refund(
        { payment: p.id, amount: '5.00', external_ref: 'w8' },
        {
          key: await keyFor(b),
        },
      );
      expect(res.statusCode, res.body).toBe(201);
    });

    it('a hand-made key refunds any payment of its store', async () => {
      const a = await connection();
      const p = await settledOn(a);
      const res = await refund({ payment: p.id, amount: '5.00', external_ref: 'hand' });
      expect(res.statusCode, res.body).toBe(201);
    });

    it("a connection key cannot refund another connection's payment (404)", async () => {
      const a = await connection();
      const c = await connection({ siteUrl: 'https://c.example', siteOrigin: 'https://c.example' });
      const p = await settledOn(a);
      const res = await refund(
        { payment: p.id, amount: '5.00', external_ref: 'x' },
        {
          key: await keyFor(c),
        },
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
      // Nor a dashboard-made payment, nor one found through its session.
      const dash = await settledOn(null);
      expect(
        (
          await refund(
            { payment: dash.id, amount: '5.00', external_ref: 'y' },
            { key: await keyFor(c) },
          )
        ).statusCode,
      ).toBe(404);
      expect(await prisma.refund.count()).toBe(0);
    });
  });

  it('refund_external_ref is on the refund.* payloads; external_ref stays the order', async () => {
    const { s, p } = await settled();
    const order = (await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).externalRef;
    const res = await refund({ session: s.id, amount: '10.00', external_ref: 'wc-55' });
    expect(res.statusCode, res.body).toBe(201);
    const [pending] = await eventsOf('refund.pending');
    expect(webhookData(pending!.payload, 'refund.pending')).toMatchObject({
      external_ref: order,
      refund_external_ref: 'wc-55',
      payment_id: p.id,
    });
    const [r] = await refundsOf(p.id);
    await execute(r!.proposalId!);
    const [sent] = await eventsOf('refund.sent');
    expect(webhookData(sent!.payload, 'refund.sent')).toMatchObject({
      external_ref: order,
      refund_external_ref: 'wc-55',
    });
  });

  it('partial then full refund moves the payment SETTLED → PARTIALLY_REFUNDED → REFUNDED', async () => {
    const { p } = await settled();
    await refund({ payment: p.id, amount: '10.00', external_ref: 'f1' });
    await refund({ payment: p.id, amount: '39.00', external_ref: 'f2' });
    const [r1, r2] = await refundsOf(p.id);
    await execute(r1!.proposalId!);
    let pay = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(pay.status).toBe('PARTIALLY_REFUNDED');
    expect(await eventsOf('payment.refunded')).toEqual([]);
    // A partially refunded payment can still be refunded (nothing left here, though).
    const more = await refund({ payment: p.id, amount: '0.01', external_ref: 'f3' });
    expect(more.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
    await execute(r2!.proposalId!);
    await execute(r2!.proposalId!); // replay: idempotent
    pay = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(pay.status).toBe('REFUNDED');
    const refunded = await eventsOf('payment.refunded');
    expect(refunded).toHaveLength(1);
    expect(refunded[0]!.payload).toMatchObject({ payment_id: p.id, reason: 'merchant' });
    expect(await eventsOf('refund.sent')).toHaveLength(2);
    const after = await refund({ payment: p.id, amount: '1.00', external_ref: 'f4' });
    expect(after.statusCode).toBe(409);
    expect(after.json().error.code).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  it('a gross amount beyond the merchant account balance is refused', async () => {
    const { p } = await settled();
    balance = usdc('10.00').toString(); // $10: not enough for $10 + the $0.50 network cost
    const res = await refund({ payment: p.id, amount: '10.00', external_ref: 'bal' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
    expect(await prisma.refund.count()).toBe(0);
  });

  it('a sanctioned sender: drafted from the review queue only after the legal ack, to another destination, still grossed up', async () => {
    const { p } = await settled();
    const OTHER = '0x2222222222222222222222222222222222222222';
    setRefundDeps({
      screen: async (_c, i) => ({ decision: i.address === p.senderAddress ? 'block' : 'allow' }),
    });
    const res = await refund({ payment: p.id, amount: '10.00', external_ref: 'held' });
    expect(res.json().status).toBe('review');
    const actor = {
      kind: 'dashboard_user',
      merchantId: merchant.id,
      livemode: false,
      userId: 'usr_owner',
      membershipId: 'mu_owner',
      role: 'owner',
      isSigner: true,
      permissions: [],
      sessionId: 'dss_1',
      passkeyVerifiedAt: null,
    } as unknown as DashboardUserPrincipal;
    const input = { refund_id: res.json().id, destination: OTHER, chain: 'eth' };
    await expect(refundFromReview(actor, p.id, input)).rejects.toMatchObject({
      code: 'LEGAL_ACK_REQUIRED',
    });
    await expect(
      refundFromReview(actor, p.id, { ...input, destination: p.senderAddress! }),
    ).rejects.toMatchObject({ code: 'LEGAL_ACK_REQUIRED' });
    await acknowledgeLegal(actor, p.id, { phrase: LEGAL_ACK_PHRASE });
    await expect(
      refundFromReview(actor, p.id, { ...input, destination: p.senderAddress! }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const out = await refundFromReview(actor, p.id, input);
    expect(out.kept_small_overpayment).toBe(false);
    const prop = await prisma.accountProposal.findFirstOrThrow();
    expect(prop.action).toMatchObject({
      refund: { amount: (usdc('10.00') + FEE_UNITS).toString(), destination: OTHER },
    });
  });

  describe('a closed store refund is never brought back (fix round 2)', () => {
    const OTHER = '0x2222222222222222222222222222222222222222';
    const owner = () =>
      ({
        kind: 'dashboard_user',
        merchantId: merchant.id,
        livemode: false,
        userId: 'usr_owner',
        membershipId: 'mu_owner',
        role: 'owner',
        isSigner: true,
        permissions: [],
        sessionId: 'dss_1',
        passkeyVerifiedAt: null,
      }) as unknown as DashboardUserPrincipal;

    it('a cancel that commits while refundFromReview screens wins: nothing is ever drafted', async () => {
      const { p } = await settled();
      setRefundDeps({ screen: async () => ({ decision: 'block' }) });
      const id = (await refund({ payment: p.id, amount: '10.00', external_ref: 'rr' })).json().id;
      await acknowledgeLegal(owner(), p.id, { phrase: LEGAL_ACK_PHRASE });
      // The store cancels exactly while the review action screens the new destination.
      let cancelled = 0;
      setRefundDeps({
        screen: async (_c, i) => {
          if (i.address === OTHER) {
            const res = await app.inject({
              method: 'POST',
              url: `/v1/refunds/${id}/cancel`,
              headers: { authorization: `Bearer ${key}` },
            });
            expect(res.statusCode, res.body).toBe(200);
            cancelled++;
          }
          return { decision: 'allow' };
        },
      });
      await expect(
        refundFromReview(owner(), p.id, { refund_id: id, destination: OTHER, chain: 'eth' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(cancelled).toBe(1);
      expect(await prisma.refund.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'failed',
        reviewReason: 'store_cancelled',
        destination: p.senderAddress, // as blocked; never the review action's new destination
        proposalId: null,
      });
      await sweepReturns();
      expect(await prisma.accountProposal.count()).toBe(0);
      expect(await eventsOf('refund.review_redrafted')).toEqual([]);
    });

    it('a store refund closed by detaching its ended proposal is not redrafted', async () => {
      const { p } = await settled();
      const id = (await refund({ payment: p.id, amount: '10.00', external_ref: 'dc' })).json().id;
      const r = await prisma.refund.findUniqueOrThrow({ where: { id } });
      // Its proposal was rejected on the dashboard; the contract no longer has it.
      await prisma.accountProposal.update({
        where: { id: r.proposalId! },
        data: { status: 'cancelled' },
      });
      const account = await prisma.merchantAccount.findFirstOrThrow({
        where: { merchantId: merchant.id },
      });
      fake.scriptView(account.nearAccountId!, 'get_proposal', () => null);
      // The review action itself detaches it (closing the store refund) — and must stop there.
      await expect(
        refundFromReview(owner(), p.id, { refund_id: id, destination: OTHER, chain: 'eth' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await prisma.refund.findUniqueOrThrow({ where: { id } })).toMatchObject({
        reviewReason: 'proposal_cancelled',
        proposalId: null,
        destination: p.senderAddress,
      });
      expect(await prisma.accountProposal.count()).toBe(1);
      expect(await eventsOf('refund.cancelled')).toHaveLength(1);
      await sweepReturns();
      expect(await prisma.accountProposal.count()).toBe(1);
    });

    it('a later sanctions hold never undoes an acknowledged review action', async () => {
      const { p } = await settled();
      setRefundDeps({ screen: async () => ({ decision: 'unavailable' }) });
      const id = (await refund({ payment: p.id, amount: '5.00', external_ref: 'ak' })).json().id;
      setRefundDeps(null);
      const at = new Date();
      await prisma.refund.update({ where: { id }, data: { acknowledgedLegalAt: at } });
      await prisma.payment.update({ where: { id: p.id }, data: { heldReason: 'sanctions' } });
      await holdMerchantRefund(ctx(), id);
      expect(await prisma.refund.findUniqueOrThrow({ where: { id } })).toMatchObject({
        reviewReason: null,
        destination: p.senderAddress,
        acknowledgedLegalAt: at,
      });
    });

    it("the shopper's address is refused when the account cannot cover the re-grossed return", async () => {
      const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
      const { s, p } = await settled({}, BINANCE);
      const id = (await refund({ payment: p.id, amount: '10.00', external_ref: 'eb' })).json().id;
      balance = '100'; // the account was spent meanwhile
      await getRedis().del(balancesCacheKey(merchant.id, false));
      const given = await app.inject({
        method: 'POST',
        url: '/v1/checkout/client/refund-address',
        headers: { authorization: `Bearer ${s.client_secret}` },
        payload: { address: 'bob.near', chain: 'near' },
      });
      expect(given.statusCode).toBe(409);
      expect(given.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
      expect(await prisma.refund.findUniqueOrThrow({ where: { id } })).toMatchObject({
        needsAddress: true,
        destination: null,
      });
    });
  });

  it('merchant rows never collide with the automatic return of the same payment', async () => {
    const { p } = await settled();
    await refund({ payment: p.id, amount: '10.00', external_ref: 'm1' });
    // An automatic return for the same payment still gets its own row, once.
    await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: '1000000000000000' });
    await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: '1000000000000000' });
    const rows = await refundsOf(p.id);
    expect(rows.map((r) => r.reason).sort()).toEqual(['merchant', 'overpaid']);

    // The database still holds automatic returns to one per (payment, reason), and merchant
    // refunds to one per (payment, external_ref); neither kind can pass for the other.
    const row = (o: Record<string, unknown>) =>
      prisma.refund.create({
        data: {
          id: newId('ref'),
          merchantId: merchant.id,
          livemode: false,
          paymentId: p.id,
          assetId: ETH,
          amount: '1',
          reason: 'overpaid',
          ...o,
        } as Parameters<typeof prisma.refund.create>[0]['data'],
      });
    await expect(row({})).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      row({ reason: 'merchant', externalRef: 'm1', requestedAmountUsd: '1.00' }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(row({ reason: 'merchant' })).rejects.toThrow(/refunds_merchant_fields_check/);
    await expect(row({ reason: 'late', externalRef: 'x' })).rejects.toThrow(
      /refunds_merchant_fields_check/,
    );
    await row({ reason: 'merchant', externalRef: 'm2', requestedAmountUsd: '1.00' });
  });

  // ─── fix round 1 ───────────────────────────────────────────────────────────

  describe('cancel (W14)', () => {
    const cancel = (id: string, opts: { key?: string } = {}) =>
      app.inject({
        method: 'POST',
        url: `/v1/refunds/${id}/cancel`,
        headers: { authorization: `Bearer ${opts.key ?? key}` },
      });

    /** A refund requested while screening is down: pending, no proposal yet. */
    async function undrafted(p: { id: string }, amount = '40.00', ref = 'u1') {
      setRefundDeps({ screen: async () => ({ decision: 'unavailable' }) });
      const res = await refund({ payment: p.id, amount, external_ref: ref });
      expect(res.statusCode, res.body).toBe(201);
      setRefundDeps(null);
      const r = await prisma.refund.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(r).toMatchObject({ status: 'pending', proposalId: null, reviewReason: null });
      return r;
    }

    it('cancels a pending, undrafted refund; frees its amount; never drafted after', async () => {
      const { p } = await settled();
      const r = await undrafted(p);
      expect((await refund({ payment: p.id, amount: '10.00', external_ref: 'x' })).statusCode).toBe(
        409,
      );
      const res = await cancel(r.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        id: r.id,
        status: 'cancelled',
        refund_external_ref: 'u1',
      });
      const [ev] = await eventsOf('refund.cancelled');
      expect(webhookData(ev!.payload, 'refund.cancelled')).toMatchObject({
        refund_id: r.id,
        refund_external_ref: 'u1',
        status: 'cancelled',
      });
      await sweepReturns();
      expect(await prisma.accountProposal.count()).toBe(0);
      expect((await reviewQueue(ctx())).returns.map((x) => x.id)).not.toContain(r.id);
      // Its amount is free again.
      const again = await refund({ payment: p.id, amount: '40.00', external_ref: 'u2' });
      expect(again.statusCode, again.body).toBe(201);
    });

    it('cancels a refund in review (sanctions)', async () => {
      const { p } = await settled();
      setRefundDeps({ screen: async () => ({ decision: 'block' }) });
      const id = (await refund({ payment: p.id, amount: '10.00', external_ref: 'rv' })).json().id;
      const res = await cancel(id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe('cancelled');
      expect(await prisma.refund.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'failed',
        reviewReason: 'store_cancelled',
      });
    });

    it('a refund with a proposal → 409 REFUND_HAS_PROPOSAL', async () => {
      const { p } = await settled();
      const id = (await refund({ payment: p.id, amount: '10.00', external_ref: 'hp' })).json().id;
      const res = await cancel(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('REFUND_HAS_PROPOSAL');
      expect(await eventsOf('refund.cancelled')).toEqual([]);
    });

    it('cancelling twice returns the same row, with one refund.cancelled', async () => {
      const { p } = await settled();
      const r = await undrafted(p);
      const a = await cancel(r.id);
      const b = await cancel(r.id);
      expect(b.statusCode).toBe(200);
      expect(b.json()).toEqual(a.json());
      expect(await eventsOf('refund.cancelled')).toHaveLength(1);
    });

    it('a cancel racing a draft: one of them wins, never both', async () => {
      for (let i = 0; i < 4; i++) {
        const { p } = await settled();
        const r = await undrafted(p, '5.00', `race-${i}`);
        const [drafted, res] = await Promise.all([
          draftReturn(ctx(), r.id).catch((e: unknown) => e),
          cancel(r.id),
        ]);
        const row = await prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
        const proposals = await prisma.accountProposal.count({ where: { refundId: r.id } });
        if (res.statusCode === 200) {
          expect(row).toMatchObject({ reviewReason: 'store_cancelled', proposalId: null });
          expect(proposals).toBe(0);
        } else {
          expect(res.json().error.code).toBe('REFUND_HAS_PROPOSAL');
          expect(row.proposalId).not.toBeNull();
          expect(proposals).toBe(1);
          expect((drafted as { proposalId: string }).proposalId).toBe(row.proposalId);
        }
      }
    });

    it("a connection key cannot cancel another connection's refund; a dashboard cancel needs step-up", async () => {
      const { p, s } = await settled();
      const a = (await createRow('Connection', merchant.id, false)).id as string;
      const other = (await createRow('Connection', merchant.id, false)).id as string;
      await prisma.session.update({ where: { id: s.id }, data: { connectionId: a } });
      const r = await undrafted(p);
      const k = await createApiKey(merchant.id, { livemode: false });
      await prisma.apiKey.update({ where: { id: k.record.id }, data: { connectionId: other } });
      expect((await cancel(r.id, { key: k.raw })).statusCode).toBe(404);

      const user = await createUser({ emailVerifiedAt: new Date() });
      await createRow('MerchantUser', merchant.id, false, {
        userId: user.id,
        role: 'owner',
        isSigner: true,
      });
      const dash = async (stepUp: boolean) =>
        app.inject({
          method: 'POST',
          url: `/v1/review/refunds/${r.id}/cancel`,
          headers: dashHeaders(await loginAs(user.id, { stepUp }), {
            merchantId: merchant.id,
            livemode: false,
          }),
          payload: {},
        });
      const noStepUp = await dash(false);
      expect(noStepUp.json().error.code).toBe('STEP_UP_REQUIRED');
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).reviewReason).toBe(
        null,
      );
      const ok = await dash(true);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().refund).toMatchObject({ id: r.id, review_reason: 'store_cancelled' });
    });
  });

  it('the sanctions race: a refund requested before the payment was held goes to sanctions review', async () => {
    const { p } = await settled();
    setRefundDeps({ screen: async () => ({ decision: 'unavailable' }) });
    const b = (await refund({ payment: p.id, amount: '5.00', external_ref: 'B' })).json().id;
    const c = (await refund({ payment: p.id, amount: '5.00', external_ref: 'C' })).json().id;
    setRefundDeps(null);
    // Another return of the payment screened as sanctioned in between (`blockReturn`).
    await prisma.payment.update({ where: { id: p.id }, data: { heldReason: 'sanctions' } });
    // B's own (retried) draft → sanctions review, no destination, no draft.
    const drafted = await draftReturn(ctx(), b);
    expect(drafted).toMatchObject({
      reviewReason: 'sanctions',
      destination: null,
      proposalId: null,
    });
    // C, left behind entirely: the sweeper moves it to review.
    await sweepReturns();
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: c } })).toMatchObject({
      reviewReason: 'sanctions',
      destination: null,
    });
    expect(await prisma.accountProposal.count()).toBe(0);
    const replay = await refund({ payment: p.id, amount: '5.00', external_ref: 'B' });
    expect(replay.json().status).toBe('review');
  });

  it('a transfer_failed refund frees its amount', async () => {
    const { p } = await settled();
    const first = await refund({ payment: p.id, amount: '40.00', external_ref: 'tf' });
    const [r] = await refundsOf(p.id);
    await onRefundProposalFailed(await proposalEvent('account.proposal.failed', r!.proposalId!));
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({
      reviewReason: 'transfer_failed',
    });
    expect((await eventsOf('refund.failed')).length).toBe(1);
    const again = await refund({ payment: p.id, amount: '40.00', external_ref: 'tf2' });
    expect(again.statusCode, again.body).toBe(201);
    const replay = await refund({ payment: p.id, amount: '40.00', external_ref: 'tf' });
    expect(replay.json()).toMatchObject({ id: first.json().id, status: 'cancelled' });
  });

  it('a test key cannot refund a live payment (404)', async () => {
    const live = await createRow('Payment', merchant.id, true, { status: 'SETTLED' });
    const res = await refund({ payment: live.id, amount: '1.00', external_ref: 'live' });
    expect(res.statusCode).toBe(404);
    expect(await prisma.refund.count()).toBe(0);
  });

  it('a USD request is never clamped, even a cent over', async () => {
    const { p } = await settled();
    await refund({ payment: p.id, amount: '40.00', external_ref: 'a' });
    const res = await refund({ payment: p.id, amount: '9.01', external_ref: 'b' });
    expect(res.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
  });

  it('an asset the merchant account does not list counts as a zero balance', async () => {
    const { p } = await settled();
    // Not active any more: the balance read lists nothing.
    await prisma.merchantAccount.updateMany({
      where: { merchantId: merchant.id },
      data: { status: 'provisioning' },
    });
    const res = await refund({ payment: p.id, amount: '1.00', external_ref: 'z' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE');
  });

  it("an exchange sender's refund is re-grossed for the chain the shopper chooses", async () => {
    const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
    const { s, p } = await settled({}, BINANCE);
    const res = await refund({ payment: p.id, amount: '10.00', external_ref: 'ex' });
    expect(res.json().status).toBe('review');
    let r = await prisma.refund.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(r).toMatchObject({ needsAddress: true, destination: null });
    expect(r.amount.toFixed()).toBe((usdc('10.00') + FEE_UNITS).toString());
    const given = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/refund-address',
      headers: { authorization: `Bearer ${s.client_secret}` },
      payload: { address: 'bob.near', chain: 'near' },
    });
    expect(given.statusCode, given.body).toBe(200);
    r = await prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
    // NEAR's return-fee estimate ($0.01), not the sender chain's ($0.50), on top of $10.00.
    expect(r.returnFee!.toFixed()).toBe('10000');
    expect(r.amount.toFixed()).toBe((usdc('10.00') + 10_000n).toString());
    expect(r.destination).toBe('bob.near');
    const prop = await prisma.accountProposal.findFirstOrThrow();
    expect(prop.action).toMatchObject({
      refund: { amount: r.amount.toFixed(), destination: 'bob.near' },
    });
  });
});
