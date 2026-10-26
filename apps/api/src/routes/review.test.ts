import type { Merchant } from '@prisma/client';
import { HOLD_NOTICE, LEGAL_ACK_PHRASE, type MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryMailer, setMailer } from '../auth/mailer.js';
import { setExchangeAddresses } from '../checkout/exchanges.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import {
  draftReturn,
  onRefundProposalExecuted,
  queueHeldReturn,
  registerRefundHooks,
  setRefundDeps,
  sweepReturns,
} from '../checkout/refunds.js';
import { onScreeningAllowed } from '../checkout/screening.js';
import { resetTokenCache } from '../checkout/tokens.js';
import {
  onReturnNeeded,
  pollDeposit,
  registerWatcherHooks,
  setWatcherDeps,
} from '../checkout/watcher.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { createApiKey, createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';

const sim1click = isolatedSimStore();
const ETH = 'nep141:eth.omft.near';
const USDC = 'nep141:usdc.test'; // the settlement asset: blockchain "near", 6 decimals, $1
const SANCTIONED = '0x000000000000000000000000000000000000dEaD';
const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
const NEAR_DEST = 'legal-cleared.testnet';
const NEAR_FEE = 10_000n; // $0.01 NEAR return fee in USDC base units

describe('review queue', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let fake: FakeNearClient;
  let accountNear: string;
  let owner: Login;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetNearClients();
    fake = fakeNearClient(false);
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    registerRefundHooks();
    setMailer(new MemoryMailer());
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Bean Shop' });
    const account = await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    accountNear = account.nearAccountId as string;
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC,
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    owner = await member('owner');
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    vi.restoreAllMocks();
    setWatcherDeps(null);
    setRefundDeps(null);
    setExchangeAddresses(null);
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

  async function member(
    role: MerchantUserRole,
    opts: { stepUp?: boolean; m?: Merchant } = {},
  ): Promise<Login> {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', (opts.m ?? merchant).id, false, {
      userId: user.id,
      role,
      isSigner: role === 'owner',
    });
    return loginAs(user.id, opts);
  }

  const dash = (
    method: 'GET' | 'POST',
    url: string,
    who: Login,
    payload?: unknown,
    opts: { livemode?: boolean; merchantId?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: dashHeaders(who, {
        merchantId: opts.merchantId ?? merchant.id,
        livemode: opts.livemode ?? false,
      }),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const ack = (paymentId: string, who = owner, phrase = LEGAL_ACK_PHRASE, opts = {}) =>
    dash('POST', `/v1/review/${paymentId}/acknowledge-legal`, who, { phrase }, opts);
  const refund = (paymentId: string, body: object = {}, who = owner, opts = {}) =>
    dash('POST', `/v1/review/${paymentId}/refund`, who, body, opts);

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

  async function paid(scenario: 'exact' | 'overpay', sender?: string) {
    const s = await newSession();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/client/quote',
      headers: { authorization: `Bearer ${s.client_secret}` },
      payload: { origin_asset: ETH },
    });
    expect(res.statusCode, res.body).toBe(201);
    const q = res.json() as { id: string; deposit_address: string };
    await sim.simulate(q.deposit_address, scenario, sender ? { senderAddress: sender } : {});
    await pollDeposit(q.deposit_address, { livemode: false });
    const p = await prisma.payment.findFirstOrThrow({ where: { quoteId: q.id } });
    return { s, q, p };
  }

  const held = async () => {
    const r = await paid('exact', SANCTIONED);
    expect(r.p.status).toBe('HELD');
    return r;
  };
  const delivered = async (depositAddress: string) =>
    BigInt((await sim.status(depositAddress)).swapDetails.amountOut!);

  it('lists held, screening-unresolved, return and needs-address items for this store and mode', async () => {
    const h = await held();
    const ex = await paid('overpay', BINANCE); // exchange sender → needs_address
    const unresolved = await createRow('Payment', merchant.id, false, {
      status: 'SCREENING_PENDING',
      screeningUnresolvedAt: new Date(),
    });
    // Other store and the other mode: never listed.
    const other = await createMerchant();
    await createRow('Payment', other.id, false, { status: 'HELD', heldReason: 'sanctions' });
    await createRow('Payment', merchant.id, true, { status: 'HELD', heldReason: 'sanctions' });

    const viewer = await member('viewer');
    const res = await dash('GET', '/v1/review', viewer);
    expect(res.statusCode, res.body).toBe(200);
    const q = res.json();
    expect(q.notice).toBe(HOLD_NOTICE);
    expect(q.held.map((x: { payment_id: string }) => x.payment_id)).toEqual([h.p.id]);
    expect(q.held[0]).toMatchObject({
      notice: HOLD_NOTICE,
      held_reason: 'sanctions',
      legal_ack_at: null,
      sender_address: SANCTIONED,
    });
    expect(q.screening_unresolved.map((x: { payment_id: string }) => x.payment_id)).toEqual([
      unresolved.id,
    ]);
    expect(q.needs_address).toHaveLength(1);
    expect(q.needs_address[0]).toMatchObject({ payment_id: ex.p.id, needs_address: true });
    expect(q.returns).toEqual([]);
    // Nothing anywhere offers a release.
    expect(res.body).not.toMatch(/release/i);

    const live = await dash('GET', '/v1/review', viewer, undefined, { livemode: true });
    expect(live.json().held).toHaveLength(1);
    expect(live.json().held[0].payment_id).not.toBe(h.p.id);
  });

  it('the legal acknowledgement: owner only, step-up, the exact phrase; recorded once', async () => {
    const { p } = await held();
    const admin = await member('admin');
    let res = await ack(p.id, admin);
    expect(res.statusCode).toBe(403);
    const noStepUp = await member('owner', { stepUp: false });
    res = await ack(p.id, noStepUp);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    for (const phrase of [
      '',
      'i have legal clearance to refund this payment',
      `${LEGAL_ACK_PHRASE}.`,
      ` ${LEGAL_ACK_PHRASE}`,
    ]) {
      res = await ack(p.id, owner, phrase);
      expect(res.statusCode, phrase).toBe(400);
    }
    expect((await dash('POST', `/v1/review/${p.id}/acknowledge-legal`, owner, {})).statusCode).toBe(
      400,
    );
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).legalAckAt).toBeNull();

    res = await ack(p.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ payment_id: p.id, legal_ack_by_user_id: owner.userId });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.legalAckAt).not.toBeNull();
    expect(row.legalAckByUserId).toBe(owner.userId);
    expect(row.status).toBe('HELD'); // nothing is released
    expect((await ack(p.id)).statusCode).toBe(200);
    const events = await prisma.event.findMany({
      where: { aggregateId: p.id, type: 'payment.legal_acknowledged' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ user_id: owner.userId, phrase: LEGAL_ACK_PHRASE });
  });

  it('acknowledging is refused for a payment that is not held, or of another store or mode', async () => {
    const { p } = await paid('exact');
    expect(p.status).toBe('SETTLED');
    expect((await ack(p.id)).statusCode).toBe(409);
    const other = await createMerchant();
    const theirs = await createRow('Payment', other.id, false, {
      status: 'HELD',
      heldReason: 'sanctions',
    });
    expect((await ack(theirs.id)).statusCode).toBe(404);
    const live = await createRow('Payment', merchant.id, true, {
      status: 'HELD',
      heldReason: 'sanctions',
    });
    expect((await ack(live.id)).statusCode).toBe(404);
    expect((await ack(live.id, owner, LEGAL_ACK_PHRASE, { livemode: true })).statusCode).toBe(200);
    expect((await refund(theirs.id, {})).statusCode).toBe(404);
  });

  it('a held refund needs the acknowledgement and another destination, screened, then drafts', async () => {
    const { q, p } = await held();
    const finance = await member('finance');
    const viewer = await member('viewer');
    expect((await refund(p.id, {}, viewer)).statusCode).toBe(403);
    let res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' }, finance);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LEGAL_ACK_REQUIRED');
    expect(await prisma.accountProposal.count()).toBe(0);

    expect((await ack(p.id)).statusCode).toBe(200);
    res = await refund(p.id, {}, finance);
    expect(res.statusCode).toBe(400); // never back to the sanctioned sender
    res = await refund(p.id, { destination: SANCTIONED, chain: 'eth' }, finance);
    expect(res.statusCode).toBe(400);
    setRefundDeps({
      screen: async (_c, i) => ({ decision: i.address === 'bad.testnet' ? 'block' : 'allow' }),
    });
    res = await refund(p.id, { destination: 'bad.testnet', chain: 'near' }, finance);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('WALLET_NOT_ALLOWED');
    expect(await prisma.accountProposal.count()).toBe(0);
    const noStepUp = await loginAs(finance.userId, { stepUp: false });
    res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' }, noStepUp);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');

    res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' }, finance);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json().refund;
    // Re-netted from the gross for the NEAR return fee ($0.01), not the sender chain's.
    const gross = await delivered(q.deposit_address);
    expect(out).toMatchObject({
      reason: 'sanctions',
      destination: NEAR_DEST,
      destination_chain: 'near',
      amount: (gross - NEAR_FEE).toString(),
      return_fee: NEAR_FEE.toString(),
    });
    expect(out.proposal_id).not.toBeNull();
    const prop = await prisma.accountProposal.findUniqueOrThrow({ where: { id: out.proposal_id } });
    expect(prop.action).toMatchObject({
      refund: { destination: NEAR_DEST, destination_chain: 'near', payment_id: p.id },
    });
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: out.id } });
    expect(r.acknowledgedLegalAt).not.toBeNull();
    expect(
      await prisma.event.count({ where: { aggregateId: r.id, type: 'refund.review_redrafted' } }),
    ).toBe(1);
    // Asking again while the proposal can still execute is refused; nothing new is drafted.
    res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' }, finance);
    expect(res.statusCode).toBe(409);
    expect(await prisma.accountProposal.count()).toBe(1);
  });

  it("C40: a held payment's excess goes through review only, even after the sanctions return executed", async () => {
    const { p } = await paid('overpay', SANCTIONED);
    expect(p.status).toBe('HELD');
    const ctx = { merchantId: merchant.id, livemode: false };
    const sanctions = (await queueHeldReturn(ctx, p.id))!;
    const over = await prisma.refund.findFirstOrThrow({
      where: { paymentId: p.id, reason: 'overpaid' },
    });
    // Created in review state: no destination, never auto-drafted.
    expect(over).toMatchObject({ destination: null, reviewReason: 'sanctions', proposalId: null });

    // The sanctions return goes out (ack + merchant destination) and executes.
    expect((await ack(p.id)).statusCode).toBe(200);
    let res = await refund(p.id, {
      refund_id: sanctions.id,
      destination: NEAR_DEST,
      chain: 'near',
    });
    expect(res.statusCode, res.body).toBe(200);
    const proposalId = res.json().refund.proposal_id as string;
    await onRefundProposalExecuted(
      await prisma.event.create({
        data: {
          id: newId('evt'),
          merchantId: merchant.id,
          livemode: false,
          aggregateType: 'account_proposal',
          aggregateId: proposalId,
          type: 'account.proposal.executed',
          payload: { proposalId, kind: 'refund', txHash: 'tx-1' },
        },
      }),
    );
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'REFUNDED',
    );

    // The excess is not auto-drafted: not by the sweeper, not by draftReturn — even with the
    // review reason cleared and the sanctioned sender as its destination.
    await sweepReturns();
    expect(await prisma.accountProposal.count()).toBe(1);
    await prisma.refund.update({
      where: { id: over.id },
      data: { reviewReason: null, destination: SANCTIONED, destinationChain: 'eth' },
    });
    await expect(draftReturn(ctx, over.id)).rejects.toMatchObject({ code: 'LEGAL_ACK_REQUIRED' });
    await sweepReturns();
    expect(await prisma.accountProposal.count()).toBe(1);

    // It is in the review queue, with the held payment.
    const queue = (await dash('GET', '/v1/review', owner)).json();
    const item = queue.held.find((x: { payment_id: string }) => x.payment_id === p.id);
    expect(item.refunds.map((r: { id: string }) => r.id)).toContain(over.id);

    // It drafts only with a merchant destination (never the sanctioned sender).
    res = await refund(p.id, { refund_id: over.id });
    expect(res.statusCode).toBe(400);
    res = await refund(p.id, { refund_id: over.id, destination: SANCTIONED, chain: 'eth' });
    expect(res.statusCode).toBe(400);
    res = await refund(p.id, { refund_id: over.id, destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund).toMatchObject({
      reason: 'overpaid',
      asset: ETH,
      destination: NEAR_DEST,
    });
    expect(res.json().refund.proposal_id).not.toBeNull();
    expect(await prisma.accountProposal.count()).toBe(2);
  });

  it('C41: a held payment with an excess: each return drafts on its own (refund_id), the first without one', async () => {
    const { p } = await paid('overpay', SANCTIONED);
    const over = await prisma.refund.findFirstOrThrow({
      where: { paymentId: p.id, reason: 'overpaid' },
    });
    expect((await ack(p.id)).statusCode).toBe(200);
    // No refund_id while the order amount's return is not queued yet: it is queued and drafted
    // (never "Say which refund" because the excess row already exists).
    let res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund).toMatchObject({ reason: 'sanctions' });
    // The queue still offers the excess, with its own state.
    const queue = (await dash('GET', '/v1/review', owner)).json();
    const item = queue.held.find((x: { payment_id: string }) => x.payment_id === p.id);
    expect(
      item.refunds.map((r: { reason: string; proposal_id: string | null }) => [
        r.reason,
        r.proposal_id !== null,
      ]),
    ).toEqual([
      ['overpaid', false],
      ['sanctions', true],
    ]);
    res = await refund(p.id, { refund_id: over.id, destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund).toMatchObject({ reason: 'overpaid', asset: ETH });
    expect(await prisma.accountProposal.count()).toBe(2);
  });

  it('C41: a held order amount kept small never strands a large excess', async () => {
    const { p } = await paid('overpay', SANCTIONED);
    // Only $0.50 verifiably reached the account for the order: under $1 net, kept.
    await prisma.settlementClaim.updateMany({
      where: { paymentId: p.id },
      data: { amount: '500000' },
    });
    // A $100 excess (0.04 ETH at $2500) is waiting in review.
    const over = await prisma.refund.findFirstOrThrow({
      where: { paymentId: p.id, reason: 'overpaid' },
    });
    await prisma.refund.update({
      where: { id: over.id },
      data: { amount: '40000000000000000', returnFee: '200000000000000' },
    });
    expect((await ack(p.id)).statusCode).toBe(200);
    let res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ refund: null, kept_small_overpayment: true });
    res = await refund(p.id, { refund_id: over.id, destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund).toMatchObject({ reason: 'overpaid', destination: NEAR_DEST });
    expect(res.json().refund.proposal_id).not.toBeNull();
  });

  it('re-drafting waits until the old proposal is verified ended ON CHAIN', async () => {
    const { p } = await paid('overpay');
    const [r] = await prisma.refund.findMany({ where: { paymentId: p.id } });
    const first = r!.proposalId!;
    expect(first).toBeTruthy();

    // Still a live draft: refused.
    let res = await refund(p.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROPOSAL_STILL_LIVE');

    // Cancelled in Postgres only; the sweeper detaches it into review.
    await prisma.accountProposal.update({ where: { id: first }, data: { status: 'cancelled' } });
    await sweepReturns();
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({
      proposalId: null,
      reviewReason: 'proposal_cancelled',
    });

    // The chain says it is live (a relay landed): refused, and the mirror follows the chain.
    fake.scriptView(accountNear, 'get_proposal', () => ({
      id: 'x',
      status: 'pending',
      approvals: [],
      valid_approvals: 0,
      ready_at: null,
    }));
    res = await refund(p.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROPOSAL_STILL_LIVE');
    expect(await prisma.accountProposal.count()).toBe(1);

    // The view cannot be read: refused (503), nothing drafted.
    await prisma.accountProposal.update({ where: { id: first }, data: { status: 'cancelled' } });
    await prisma.refund.update({
      where: { id: r!.id },
      data: { proposalId: null, reviewReason: 'proposal_cancelled' },
    });
    fake.scriptView(accountNear, 'get_proposal', () => {
      throw new Error('rpc down');
    });
    res = await refund(p.id);
    expect(res.statusCode).toBe(503);
    expect(await prisma.accountProposal.count()).toBe(1);

    // A relay claim inside its lease: refused even if the view says absent.
    fake.scriptView(accountNear, 'get_proposal', () => null);
    await prisma.accountProposal.update({
      where: { id: first },
      data: { relayClaimedAt: new Date() },
    });
    res = await refund(p.id);
    expect(res.json().error.code).toBe('PROPOSAL_STILL_LIVE');

    // Verified absent on chain, no relay in flight: drafted again, same net amount.
    await prisma.accountProposal.update({ where: { id: first }, data: { relayClaimedAt: null } });
    res = await refund(p.id);
    expect(res.statusCode, res.body).toBe(200);
    const again = res.json().refund;
    expect(again.proposal_id).not.toBe(first);
    expect(again.amount).toBe(r!.amount.toFixed(0));
    expect(await prisma.accountProposal.count()).toBe(2);
  });

  it('a re-draft maps how the old proposal ended ON CHAIN, not the stale mirror status', async () => {
    const outcomes = () =>
      prisma.event.findMany({
        where: { type: { in: ['refund.cancelled', 'refund.failed'] } },
        orderBy: { createdAt: 'asc' },
      });
    for (const [chainStatus, type, status, reviewReason] of [
      ['expired', 'refund.cancelled', 'expired', 'proposal_expired'],
      ['failed', 'refund.failed', 'failed', 'transfer_failed'],
    ] as const) {
      const { p } = await paid('overpay');
      const [r] = await prisma.refund.findMany({ where: { paymentId: p.id } });
      const old = r!.proposalId!;
      // Cancelled in Postgres through a stale claim (still linked); the chain says how it ended.
      await prisma.accountProposal.update({
        where: { id: old },
        data: { status: 'cancelled', relayClaimedAt: new Date(Date.now() - 10 * 60_000) },
      });
      fake.scriptView(accountNear, 'get_proposal', () => ({
        id: 'x',
        status: chainStatus,
        approvals: [],
        valid_approvals: 0,
        ready_at: null,
      }));
      const res = await refund(p.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().refund.proposal_id).not.toBe(old);
      const ended = (await outcomes()).filter(
        (e) => (e.payload as { refund_id: string }).refund_id === r!.id,
      );
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({ type, payload: { status, proposal_id: old } });
      const flagged = await prisma.event.findFirstOrThrow({
        where: { type: 'refund.needs_review', aggregateId: r!.id },
      });
      expect(flagged.payload).toMatchObject({ review_reason: reviewReason });
    }
  });

  it('an amount_unknown held return is re-sized from the verified delivered amount', async () => {
    const { q, p } = await held();
    // Held before the swap's transfer was verified (no claim; M-3 claims one when it can).
    await prisma.settlementClaim.deleteMany({ where: { paymentId: p.id } });
    const real = await sim.status(q.deposit_address);
    const spy = vi.spyOn(sim, 'status').mockResolvedValue({
      ...real,
      swapDetails: { ...real.swapDetails, amountOut: undefined },
    });
    const queued = (await queueHeldReturn({ merchantId: merchant.id, livemode: false }, p.id))!;
    expect(queued.reviewReason).toBe('amount_unknown');
    await ack(p.id);
    let res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AMOUNT_UNKNOWN');
    spy.mockRestore();
    res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    const gross = BigInt(real.swapDetails.amountOut!);
    expect(res.json().refund).toMatchObject({
      id: queued.id,
      amount: (gross - NEAR_FEE).toString(),
      review_reason: null,
    });
  });

  it('the sweeper retries an acknowledged held return set up from review, never an unacknowledged one', async () => {
    const { p } = await held();
    const r = (await queueHeldReturn({ merchantId: merchant.id, livemode: false }, p.id))!;
    await prisma.refund.update({
      where: { id: r.id },
      data: { destination: NEAR_DEST, destinationChain: 'near' },
    });
    await sweepReturns();
    expect(await prisma.accountProposal.count()).toBe(0);
    await prisma.refund.update({ where: { id: r.id }, data: { acknowledgedLegalAt: new Date() } });
    await sweepReturns();
    expect(
      (await prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).proposalId,
    ).not.toBeNull();
  });

  it('two concurrent refund requests with different destinations leave one consistent proposal', async () => {
    const { p } = await held();
    await ack(p.id);
    const screened: string[] = [];
    setRefundDeps({
      screen: async (_c, i) => {
        screened.push(i.address);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { decision: 'allow' };
      },
    });
    const finance = await member('finance');
    const [a, b] = await Promise.all([
      refund(p.id, { destination: 'dest-a.testnet', chain: 'near' }, finance),
      refund(p.id, { destination: 'dest-b.testnet', chain: 'near' }, owner),
    ]);
    const proposals = await prisma.accountProposal.findMany();
    expect(proposals).toHaveLength(1);
    const [row] = await prisma.refund.findMany({ where: { paymentId: p.id } });
    const action = (proposals[0]!.action as { refund: { destination: string; amount: string } })
      .refund;
    expect(row!.proposalId).toBe(proposals[0]!.id);
    expect(action.destination).toBe(row!.destination);
    expect(action.amount).toBe(row!.amount.toFixed(0));
    const [pending] = await prisma.event.findMany({
      where: { aggregateId: row!.id, type: 'refund.pending' },
    });
    expect(pending!.payload).toMatchObject({ destination: row!.destination });
    for (const res of [a, b]) {
      if (res.statusCode === 200) {
        expect(res.json().refund.destination).toBe(row!.destination);
      } else {
        expect(res.statusCode, res.body).toBe(409);
      }
    }
    expect([a.statusCode, b.statusCode]).toContain(200);
    // The drafted destination was screened.
    expect(screened).toContain(row!.destination);
  });

  it('draftReturn refuses a row changed after the caller wrote it, and screens an unscreened address', async () => {
    const { p } = await held();
    await ack(p.id);
    const ctx = { merchantId: merchant.id, livemode: false };
    const r = (await queueHeldReturn(ctx, p.id))!;
    await prisma.refund.update({
      where: { id: r.id },
      data: {
        destination: 'dest-b.testnet',
        destinationChain: 'near',
        acknowledgedLegalAt: new Date(),
      },
    });
    await expect(
      draftReturn(ctx, r.id, {
        screenedAddress: 'dest-a.testnet',
        expect: {
          destination: 'dest-a.testnet',
          destinationChain: 'near',
          amount: r.amount.toFixed(0),
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.accountProposal.count()).toBe(0);
    // A screened flag for another address does not skip screening the row's destination.
    const screened: string[] = [];
    setRefundDeps({
      screen: async (_c, i) => {
        screened.push(i.address);
        return { decision: 'block' };
      },
    });
    const out = await draftReturn(ctx, r.id, { screenedAddress: 'dest-a.testnet' });
    expect(screened).toEqual(['dest-b.testnet']);
    expect(out).toMatchObject({ proposalId: null, reviewReason: 'sanctions' });
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  it('a cancelled review re-draft can go to the same merchant address again', async () => {
    const { p } = await held();
    await ack(p.id);
    let res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    const first = res.json().refund.proposal_id as string;
    await prisma.accountProposal.update({ where: { id: first }, data: { status: 'cancelled' } });
    await sweepReturns();
    fake.scriptView(accountNear, 'get_proposal', () => null);
    res = await refund(p.id, { destination: NEAR_DEST, chain: 'near' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund.proposal_id).not.toBe(first);
    // The sanctioned sender stays refused.
    await prisma.accountProposal.update({
      where: { id: res.json().refund.proposal_id },
      data: { status: 'cancelled' },
    });
    await sweepReturns();
    res = await refund(p.id, { destination: SANCTIONED, chain: 'eth' });
    expect(res.statusCode).toBe(400);
  });

  it('a destination blocked as sanctioned at draft time stays refused for re-drafts', async () => {
    // The overpay return's draft screens as sanctioned: blockReturn fails it and records
    // payment.held with the blocked destination.
    setRefundDeps({ screen: async () => ({ decision: 'block' }) });
    const { p } = await paid('overpay');
    setRefundDeps(null);
    const [r] = await prisma.refund.findMany({ where: { paymentId: p.id } });
    expect(r).toMatchObject({ status: 'failed', reviewReason: 'sanctions' });
    // A later block of another destination (e.g. the list changed after a review screen).
    const ctx = { merchantId: merchant.id, livemode: false };
    await tenantTransaction(ctx, (tx) =>
      recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: p.id,
        type: 'payment.held',
        payload: { payment_id: p.id, refund_id: r!.id, blocked_destination: 'blocked.testnet' },
      }),
    );
    let res = await refund(p.id, { destination: 'blocked.testnet', chain: 'near' });
    expect(res.statusCode).toBe(409); // no acknowledgement yet
    await ack(p.id);
    res = await refund(p.id, { destination: 'blocked.testnet', chain: 'near' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/sanctioned sender/);
    res = await refund(p.id, { destination: p.senderAddress!.toLowerCase(), chain: 'eth' });
    expect(res.statusCode).toBe(400);
    expect(await prisma.accountProposal.count()).toBe(0);
  });
});
