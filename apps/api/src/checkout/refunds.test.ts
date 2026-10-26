import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poaRouteError } from '../accounts/encoding.js';
import { buildApp } from '../app.js';
import { MemoryMailer, setMailer } from '../auth/mailer.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import { applyProposalView, markOnChain } from '../accounts/proposals.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';
import { isExchangeAddress, setExchangeAddresses } from './exchanges.js';
import { resetOneClickProviders, SimulatedOneClick } from './oneclick/index.js';
import {
  draftReturn,
  heldAmount,
  netOfReturnFee,
  onRefundProposalCancelled,
  onRefundProposalExecuted,
  onRefundProposalFailed,
  queueHeldReturn,
  queueReturn,
  registerRefundHooks,
  returnRoute,
  setRefundDeps,
  sweepReturns,
} from './refunds.js';
import { onScreeningAllowed } from './screening.js';
import { resetTokenCache } from './tokens.js';
import { onReturnNeeded, pollDeposit, registerWatcherHooks, setWatcherDeps } from './watcher.js';
import { Prisma } from '@prisma/client';

const sim1click = isolatedSimStore();
// A real PoA bridge token (1Click mainnet id; $2500, 18 decimals, blockchain "eth" in the sim).
const ETH = 'nep141:eth.omft.near';
const USDC = 'nep141:usdc.test'; // blockchain "near", 6 decimals, $1 — the settlement asset
const WALLET = '0x1111111111111111111111111111111111111111';
const SANCTIONED = '0x000000000000000000000000000000000000dEaD';
const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60'; // in data/exchange-addresses.json
const ETH_FEE_WEI = 200_000_000_000_000n; // $0.50 return fee (evm) at $2500 / ETH

describe('route mirror (contract poa_target)', () => {
  const poa = (t: string) => ({ poa: { token_contract: t } });
  it('near: any nep141 asset to a NEAR account; other chains need a matching PoA token', () => {
    expect(poaRouteError('nep141:usdc.test', poa('usdc.test'), 'near', 'bob.near')).toBeNull();
    expect(poaRouteError('nep141:usdc.test', poa('usdc.test'), 'near', '0xAB')).toMatch(/NEAR/);
    expect(poaRouteError(ETH, poa('eth.omft.near'), 'eth', WALLET)).toBeNull();
    expect(
      poaRouteError('nep141:arb-0xabc.omft.near', poa('arb-0xabc.omft.near'), 'arbitrum', WALLET),
    ).toBeNull();
    expect(poaRouteError(ETH, poa('eth.omft.near'), 'base', WALLET)).toMatch(/does not serve/);
    expect(poaRouteError(ETH, poa('other.near'), 'eth', WALLET)).toMatch(/token contract/);
    expect(poaRouteError('nep141:usdc.test', poa('usdc.test'), 'sol', 'x')).toMatch(/not a PoA/);
    expect(
      poaRouteError('nep141:constructor.omft.near', poa('constructor.omft.near'), 'eth', WALLET),
    ).toMatch(/not a PoA/);
    expect(poaRouteError(ETH, { swap: { deposit_account: 'd.near' } }, 'sol', 'x')).toBeNull();
  });

  it('the exchange list matches EVM addresses case-insensitively on any EVM chain', () => {
    expect(isExchangeAddress('eth', BINANCE.toLowerCase())).toBe(true);
    expect(isExchangeAddress('base', BINANCE)).toBe(true);
    expect(isExchangeAddress('eth', WALLET)).toBe(false);
    expect(isExchangeAddress('tron', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi')).toBe(true);
    expect(isExchangeAddress('sol', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi')).toBe(false);
  });

  it('T8: bech32 (BTC) exchange addresses match case-insensitively; base58 stays exact', () => {
    const BECH32 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    setExchangeAddresses({ btc: [BECH32.toUpperCase(), '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo'] });
    try {
      expect(isExchangeAddress('btc', BECH32)).toBe(true);
      expect(isExchangeAddress('btc', BECH32.toUpperCase())).toBe(true);
      expect(isExchangeAddress('btc', '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo')).toBe(true);
      expect(isExchangeAddress('btc', '34XP4VROCGJYM3XR7YCVPFHOCNXV4TWSEO')).toBe(false);
    } finally {
      setExchangeAddresses(null);
    }
  });

  it('returnRoute: Poa through the asset contract, or null when a swap would be needed', () => {
    expect(returnRoute(ETH, 'eth', WALLET)).toEqual({ poa: { token_contract: 'eth.omft.near' } });
    expect(returnRoute(USDC, 'near', 'bob.near')).toEqual({ poa: { token_contract: 'usdc.test' } });
    expect(returnRoute(USDC, 'sol', 'So1ana')).toBeNull();
  });

  it('netOfReturnFee rounds the fee up and floors at zero', () => {
    const perUnit = new Prisma.Decimal('2500').div(new Prisma.Decimal(10).pow(18));
    const r = netOfReturnFee(1_000_000_000_000_000n, perUnit, new Prisma.Decimal('0.5'));
    expect(r.fee).toBe(ETH_FEE_WEI);
    expect(r.net).toBe(800_000_000_000_000n);
    expect(r.netUsd.toFixed(2)).toBe('2.00');
    expect(netOfReturnFee(1n, perUnit, new Prisma.Decimal('0.5')).net).toBe(0n);
  });
});

describe('return to sender', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let mailer: MemoryMailer;
  let fake: FakeNearClient;
  let accountNear: string;
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  let logSpy: ReturnType<typeof vi.spyOn>;
  const ctx = () => ({ merchantId: merchant.id, livemode: false });

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetNearClients();
    fake = fakeNearClient(false);
    offset = 0;
    sim = new SimulatedOneClick({ store: sim1click.store(), now: clock });
    resetOneClickProviders({ simulated: sim });
    setWatcherDeps({ now: clock });
    registerWatcherHooks();
    registerRefundHooks();
    mailer = new MemoryMailer();
    setMailer(mailer);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({
      name: 'Bean Shop',
      defaultFeePayer: 'merchant',
      defaultGasPayer: 'buyer',
    });
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

  async function newSession(amount = '25.00', extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${testKey}` },
      payload: {
        amount,
        amount_currency: 'USD',
        external_ref: `order-${Math.random().toString(36).slice(2)}`,
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
        ...extra,
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

  async function quote(secret: string, body: Record<string, unknown> = { origin_asset: ETH }) {
    const res = await call('POST', 'quote', secret, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; deposit_address: string; amount_in: string };
  }

  const poll = (addr: string) => pollDeposit(addr, { livemode: false });
  const paymentOf = (quoteId: string) => prisma.payment.findFirstOrThrow({ where: { quoteId } });
  const refundsOf = (paymentId: string) => prisma.refund.findMany({ where: { paymentId } });
  const eventsOf = (type: string) =>
    prisma.event.findMany({
      where: { merchantId: merchant.id, type },
      orderBy: { createdAt: 'asc' },
    });

  /** A manual send (no refund address) that overpays 10%: the excess lands in the account. */
  async function overpaid(opts: { sender?: string; amount?: string; email?: string } = {}) {
    const s = await newSession(
      opts.amount ?? '25.00',
      opts.email ? { customer_email: opts.email } : {},
    );
    const q = await quote(s.client_secret);
    await sim.simulate(
      q.deposit_address,
      'overpay',
      opts.sender ? { senderAddress: opts.sender } : {},
    );
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('SETTLED');
    return { s, q, p, excess: BigInt(q.amount_in) / 10n };
  }

  it('a normal manual-send overpay creates a refund draft with the right route and net amount', async () => {
    const { s, p, excess } = await overpaid();
    const [r] = await refundsOf(p.id);
    expect(r).toMatchObject({
      reason: 'overpaid',
      assetId: ETH,
      destination: p.senderAddress,
      destinationChain: 'eth',
      needsAddress: false,
      status: 'pending',
      reviewReason: null,
    });
    expect(r!.returnFee?.toFixed()).toBe(ETH_FEE_WEI.toString());
    expect(r!.amount.toFixed()).toBe((excess - ETH_FEE_WEI).toString());
    const prop = await prisma.accountProposal.findUniqueOrThrow({ where: { id: r!.proposalId! } });
    expect(prop).toMatchObject({
      kind: 'refund',
      status: 'draft',
      createdByUserId: null,
      refundId: r!.id,
    });
    expect(prop.action).toEqual({
      refund: {
        asset: ETH,
        amount: (excess - ETH_FEE_WEI).toString(),
        destination_chain: 'eth',
        destination: p.senderAddress,
        payment_id: p.id,
        route: { poa: { token_contract: 'eth.omft.near' } },
      },
    });
    const [ev] = await eventsOf('refund.pending');
    expect(ev!.payload).toMatchObject({
      refund_id: r!.id,
      payment_id: p.id,
      session_id: s.id,
      proposal_id: prop.id,
      reason: 'overpaid',
    });
    // Repeats (the hook again, the sweeper) are no-ops.
    await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: excess.toString() });
    await sweepReturns();
    expect(await refundsOf(p.id)).toHaveLength(1);
    expect(await prisma.accountProposal.count()).toBe(1);
    expect(await eventsOf('refund.pending')).toHaveLength(1);
  });

  it('a return worth < $1 after the return fee is kept (no draft)', async () => {
    // $12 session: the excess is ≈ $1.20 gross (the watcher queues it), $0.70 net of the $0.50
    // return fee → kept by the merchant.
    const { p } = await overpaid({ amount: '12.00' });
    // M-8: decided in settle(), net of the return fee, so the first payment.succeeded says so.
    const [succeeded] = await eventsOf('payment.succeeded');
    expect(succeeded!.payload).toMatchObject({ kept_small_overpayment: true });
    expect(await refundsOf(p.id)).toEqual([]);
    expect(await prisma.accountProposal.count()).toBe(0);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).keptSmallOverpayment,
    ).toBe(true);
    await sweepReturns();
    expect(await refundsOf(p.id)).toEqual([]);
  });

  it('an underpaid store-path refund under $1 is kept and the payment completes', async () => {
    const s = await newSession('1.00'); // half ≈ $0.50 refunded into the account
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay');
    await poll(q.deposit_address);
    offset = 13 * 60_000;
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.keptSmallOverpayment).toBe(true);
    expect(p.status).toBe('REFUNDED');
    expect(await refundsOf(p.id)).toEqual([]);
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  it('an exchange sender becomes needs_address, the email is queued, and the shopper address drafts', async () => {
    const { s, p } = await overpaid({ sender: BINANCE, email: 'ada@example.com' });
    const [r] = await refundsOf(p.id);
    expect(r).toMatchObject({ needsAddress: true, destination: null, proposalId: null });
    expect(await eventsOf('refund.needs_address')).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: 'ada@example.com',
      template: 'refund_needs_address',
      data: { merchant_name: 'Bean Shop', refund_id: r!.id },
    });
    expect(mailer.sent[0]!.data.refund_address_url).toMatch(
      new RegExp(`/pay/${s.id}/refund-address\\?t=${r!.id}\\.`),
    );
    let view = (await call('GET', 'session', s.client_secret)).json();
    expect(view.needs_email).toBe(false); // the store gave one
    expect(view.refunds).toEqual([
      expect.objectContaining({ id: r!.id, needs_address: true, chains: ['near', 'eth'] }),
    ]);

    // A chain the asset cannot reach directly is refused; a bad address too.
    let res = await call('POST', 'refund-address', s.client_secret, {
      address: 'So11111111111111111111111111111111111111112',
      chain: 'sol',
    });
    expect(res.statusCode, res.body).toBe(400);
    res = await call('POST', 'refund-address', s.client_secret, { address: '0x12', chain: 'eth' });
    expect(res.statusCode).toBe(400);

    res = await call('POST', 'refund-address', s.client_secret, { address: WALLET, chain: 'eth' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ refund_id: r!.id, status: 'pending_approval' });
    const done = await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } });
    expect(done).toMatchObject({
      needsAddress: false,
      destination: WALLET,
      destinationChain: 'eth',
    });
    expect(done.proposalId).not.toBeNull();
    expect(await eventsOf('refund.pending')).toHaveLength(1);
    view = (await call('GET', 'session', s.client_secret)).json();
    expect(view.refunds[0].needs_address).toBe(false);
    // Already given.
    res = await call('POST', 'refund-address', s.client_secret, { address: WALLET, chain: 'eth' });
    expect(res.statusCode).toBe(404);
  });

  it('an exchange sender without a store email: the checkout asks, then the email is sent', async () => {
    const { s, p } = await overpaid({ sender: BINANCE });
    expect(mailer.sent).toEqual([]);
    expect((await call('GET', 'session', s.client_secret)).json().needs_email).toBe(true);
    const res = await call('POST', 'email', s.client_secret, { email: 'ada@example.com' });
    expect(res.statusCode, res.body).toBe(200);
    expect(mailer.sent.map((m) => m.template)).toEqual(['refund_needs_address']);
    expect((await refundsOf(p.id))[0]!.needsAddress).toBe(true);
  });

  it('a sanctioned shopper-provided address is refused alone; the shopper can give another', async () => {
    const { s, p } = await overpaid({ sender: BINANCE });
    let res = await call('POST', 'refund-address', s.client_secret, {
      address: SANCTIONED,
      chain: 'eth',
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('WALLET_NOT_ALLOWED');
    const [r] = await refundsOf(p.id);
    expect(r).toMatchObject({ status: 'pending', needsAddress: true, reviewReason: null });
    expect(await prisma.accountProposal.count()).toBe(0);
    expect(await eventsOf('payment.held')).toEqual([]);
    expect((await call('GET', 'session', s.client_secret)).json().needs_email).toBe(true);
    res = await call('POST', 'refund-address', s.client_secret, { address: WALLET, chain: 'eth' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await refundsOf(p.id))[0]!.proposalId).not.toBeNull();
  });

  it('a sanctioned sender destination is never drafted (screened right before drafting)', async () => {
    setRefundDeps({ screen: async () => ({ decision: 'block' }) });
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    expect(r).toMatchObject({ status: 'failed', reviewReason: 'sanctions', proposalId: null });
    expect(await prisma.accountProposal.count()).toBe(0);
    const [held] = await eventsOf('payment.held');
    expect(held!.payload).toMatchObject({ payment_id: p.id, held_reason: 'sanctions' });
  });

  it('screening unavailable: no draft yet; the sweeper drafts once screening answers', async () => {
    setRefundDeps({ screen: async () => ({ decision: 'unavailable' }) });
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    expect(r).toMatchObject({ status: 'pending', proposalId: null, reviewReason: null });
    setRefundDeps(null);
    await sweepReturns();
    expect((await refundsOf(p.id))[0]!.proposalId).not.toBeNull();
  });

  it('a connected-wallet overpay creates no draft (1Click already refunded); it is recorded', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(q.deposit_address, 'overpay', { senderAddress: WALLET });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('SETTLED');
    await sweepReturns();
    const [r] = await refundsOf(p.id);
    expect(r).toMatchObject({
      reason: 'overpaid',
      status: 'confirmed',
      proposalId: null,
      destination: WALLET,
    });
    expect(r!.amount.toFixed()).toBe(p.refundedAmount!.toFixed());
    expect(await prisma.accountProposal.count()).toBe(0);
    expect(await eventsOf('refund.pending')).toEqual([]);
  });

  it('a manual send with a refund address creates no draft (1Click refunds directly)', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(q.deposit_address, 'underpay');
    await poll(q.deposit_address);
    offset = 13 * 60_000;
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('REFUNDED');
    // Even when the hook is called for it, a direct refund is only recorded.
    await queueReturn(ctx(), p, {
      reason: 'underpaid',
      assetId: ETH,
      amount: p.refundedAmount!.toFixed(),
    });
    await sweepReturns();
    const rows = await refundsOf(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'underpaid', status: 'confirmed', proposalId: null });
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  it('the sweeper queues a return the post-commit hook missed', async () => {
    onReturnNeeded(null); // as if the process died between the commit and the hook
    const { p } = await overpaid();
    expect(await refundsOf(p.id)).toEqual([]);
    expect(await sweepReturns()).toBeGreaterThan(0);
    const [r] = await refundsOf(p.id);
    expect(r!.proposalId).not.toBeNull();
    expect(await eventsOf('refund.pending')).toHaveLength(1);
  });

  it('an executed refund proposal marks the refund sent and completes the payment', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay');
    await poll(q.deposit_address);
    offset = 13 * 60_000;
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('REFUNDING');
    const [r] = await refundsOf(p.id);
    expect(r!.proposalId).not.toBeNull();
    const event = await prisma.event.create({
      data: {
        id: newId('evt'),
        merchantId: merchant.id,
        livemode: false,
        aggregateType: 'account_proposal',
        aggregateId: r!.proposalId!,
        type: 'account.proposal.executed',
        payload: { proposalId: r!.proposalId!, kind: 'refund', txHash: 'tx-refund-1' },
      },
    });
    await onRefundProposalExecuted(event);
    await onRefundProposalExecuted(event); // at least once: idempotent
    const done = await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } });
    expect(done).toMatchObject({ status: 'confirmed', refundTxHash: 'tx-refund-1' });
    expect((await paymentOf(q.id)).status).toBe('REFUNDED');
    const sent = await eventsOf('refund.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      refund_id: r!.id,
      payment_id: p.id,
      session_id: s.id,
      tx_hash: 'tx-refund-1',
    });
  });

  it('a swapped late deposit the asset cannot reach directly is marked for manual review', async () => {
    const s = await newSession();
    const q1 = await quote(s.client_secret, { origin_asset: ETH });
    const q2 = await quote(s.client_secret, { origin_asset: 'nep141:wrap.testnet' });
    await sim.simulate(q2.deposit_address, 'exact');
    await poll(q2.deposit_address);
    await sim.simulate(q1.deposit_address, 'exact'); // a second, late payment: swapped to USDC
    await poll(q1.deposit_address);
    const p = await paymentOf(q1.id);
    expect(p).toMatchObject({ status: 'REFUNDING', isLate: true });
    const [r] = await refundsOf(p.id);
    // USDC on NEAR cannot be ft_withdrawn to an Ethereum sender: a Swap route is needed.
    expect(r).toMatchObject({
      reason: 'late',
      assetId: USDC,
      destinationChain: 'eth',
      reviewReason: 'needs_swap_route',
      proposalId: null,
    });
    await sweepReturns();
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  /** A second, late, overpaying manual send into a settled session: swapped into the account. */
  async function lateOverpaid() {
    const s = await newSession();
    const q1 = await quote(s.client_secret, { origin_asset: ETH });
    const q2 = await quote(s.client_secret, { origin_asset: 'nep141:wrap.testnet' });
    await sim.simulate(q2.deposit_address, 'exact');
    await poll(q2.deposit_address);
    await sim.simulate(q1.deposit_address, 'overpay');
    await poll(q1.deposit_address);
    const p = await paymentOf(q1.id);
    expect(p).toMatchObject({ status: 'REFUNDING', isLate: true });
    const excess = BigInt((await sim.status(q1.deposit_address)).swapDetails.refundedAmount!);
    expect(excess).toBeGreaterThan(0n);
    return { p, excess };
  }

  it('M-2: a late overpaid deposit queues the late return and an overpaid return of the excess', async () => {
    const { p, excess } = await lateOverpaid();
    const refunds = await refundsOf(p.id);
    expect(refunds.map((r) => r.reason).sort()).toEqual(['late', 'overpaid']);
    const over = refunds.find((r) => r.reason === 'overpaid')!;
    expect(over).toMatchObject({ assetId: ETH, destination: p.senderAddress });
    expect(over.amount.toFixed()).toBe((excess - ETH_FEE_WEI).toString());
    // Screened and drafted like every return; repeats are no-ops.
    expect(over.proposalId).not.toBeNull();
    await sweepReturns();
    await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: excess.toString() });
    expect(await refundsOf(p.id)).toHaveLength(2);
  });

  it('M-2: the sweeper queues the late excess the post-commit hook missed', async () => {
    onReturnNeeded(null);
    const { p } = await lateOverpaid();
    expect(await refundsOf(p.id)).toEqual([]);
    await sweepReturns();
    expect((await refundsOf(p.id)).map((r) => r.reason).sort()).toEqual(['late', 'overpaid']);
  });

  /** `payment.status_changed` → REFUNDED events of a payment. */
  const refundedTransitions = async (paymentId: string) =>
    (
      await prisma.event.findMany({
        where: { aggregateId: paymentId, type: 'payment.status_changed' },
      })
    ).filter((e) => (e.payload as { to?: string }).to === 'REFUNDED');

  it('C40: a late return kept small never keeps a large excess (late first, then overpaid)', async () => {
    onReturnNeeded(null); // the hooks are driven by hand, in this order
    const { p, excess } = await lateOverpaid();
    // The late return nets under $1 (0.10 USDC): kept.
    expect(
      await queueReturn(ctx(), p, { reason: 'late', assetId: USDC, amount: '100000' }),
    ).toBeNull();
    let cur = await paymentOf(p.quoteId);
    expect(cur.keptSmallReasons).toEqual(['late']);
    // The excess is still open, so the payment waits.
    expect(cur.status).toBe('REFUNDING');
    // The ≈$2.50 excess is queued and drafted.
    const r = await queueReturn(ctx(), cur, {
      reason: 'overpaid',
      assetId: ETH,
      amount: excess.toString(),
    });
    expect(r).toMatchObject({ reason: 'overpaid', assetId: ETH });
    expect(r!.proposalId).not.toBeNull();
    cur = await paymentOf(p.quoteId);
    expect(cur.keptSmallReasons).toEqual(['late']);
  });

  it('C41: the shopper view says which reasons were kept and what each return is for (no addresses)', async () => {
    onReturnNeeded(null);
    const s = await newSession();
    const q1 = await quote(s.client_secret, { origin_asset: ETH });
    const q2 = await quote(s.client_secret, { origin_asset: 'nep141:wrap.testnet' });
    await sim.simulate(q2.deposit_address, 'exact');
    await poll(q2.deposit_address);
    await sim.simulate(q1.deposit_address, 'overpay');
    await poll(q1.deposit_address);
    const p = await paymentOf(q1.id);
    const excess = (await sim.status(q1.deposit_address)).swapDetails.refundedAmount!;
    await queueReturn(ctx(), p, { reason: 'late', assetId: USDC, amount: '100000' });
    await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: excess });
    const res = await call('GET', 'session', s.client_secret);
    expect(res.statusCode).toBe(200);
    const v = res.json();
    const pay = v.payments.find((x: { id: string }) => x.id === p.id);
    expect(pay.kept_small_reasons).toEqual(['late']);
    expect(v.refunds).toEqual([
      expect.objectContaining({ payment_id: p.id, reason: 'overpaid', state: 'processing' }),
    ]);
    expect(res.body).not.toContain(p.senderAddress!);
  });

  it('C40: the sweeper still queues the excess after the late return was kept small', async () => {
    onReturnNeeded(null);
    const { p } = await lateOverpaid();
    await queueReturn(ctx(), p, { reason: 'late', assetId: USDC, amount: '100000' });
    await sweepReturns();
    const [over] = await refundsOf(p.id);
    expect(over).toMatchObject({ reason: 'overpaid', assetId: ETH });
    expect(over!.proposalId).not.toBeNull();
  });

  it('C40: an excess kept small never keeps the late return (overpaid first, then late)', async () => {
    onReturnNeeded(null);
    const { p } = await lateOverpaid();
    expect(
      await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: '1000' }),
    ).toBeNull();
    let cur = await paymentOf(p.quoteId);
    expect(cur.keptSmallReasons).toEqual(['overpaid']);
    expect(cur.status).toBe('REFUNDING');
    const r = await queueReturn(ctx(), cur, {
      reason: 'late',
      assetId: USDC,
      amount: '25000000',
    });
    expect(r).toMatchObject({ reason: 'late', assetId: USDC });
    cur = await paymentOf(p.quoteId);
    expect(cur.status).toBe('REFUNDING');
  });

  it('C41: a blocked late return is still open: keeping the excess never completes the payment', async () => {
    onReturnNeeded(null);
    const { p } = await lateOverpaid();
    // The sender screens as sanctioned when the late return is drafted: failed, in review.
    setRefundDeps({ screen: async () => ({ decision: 'block' }) });
    const late = await queueReturn(ctx(), p, {
      reason: 'late',
      assetId: USDC,
      amount: '25000000',
    });
    expect(late).toMatchObject({ reason: 'late', status: 'failed', reviewReason: 'sanctions' });
    // The excess is small and kept, but the blocked late return is still open.
    await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: '1000' });
    const cur = await paymentOf(p.quoteId);
    expect(cur.keptSmallReasons).toEqual(['overpaid']);
    expect(cur.status).toBe('REFUNDING');
    expect(await refundedTransitions(p.id)).toEqual([]);
  });

  it('C40: both returns small → both kept, the payment REFUNDED once', async () => {
    onReturnNeeded(null);
    const { p } = await lateOverpaid();
    await queueReturn(ctx(), p, { reason: 'late', assetId: USDC, amount: '100000' });
    expect((await paymentOf(p.quoteId)).status).toBe('REFUNDING');
    await queueReturn(ctx(), p, { reason: 'overpaid', assetId: ETH, amount: '1000' });
    const cur = await paymentOf(p.quoteId);
    expect([...cur.keptSmallReasons].sort()).toEqual(['late', 'overpaid']);
    expect(cur.status).toBe('REFUNDED');
    await sweepReturns();
    expect(await refundsOf(p.id)).toEqual([]);
    expect(await refundedTransitions(p.id)).toHaveLength(1);
  });

  it('M-2: a held overpaid deposit also queues the excess, gated on the legal acknowledgement', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'overpay', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('HELD');
    const excess = BigInt((await sim.status(q.deposit_address)).swapDetails.refundedAmount!);
    await queueHeldReturn(ctx(), p.id);
    const refunds = await refundsOf(p.id);
    expect(refunds.map((r) => r.reason).sort()).toEqual(['overpaid', 'sanctions']);
    const over = refunds.find((r) => r.reason === 'overpaid')!;
    // In review from the start (C40): no destination, never drafted on its own.
    expect(over).toMatchObject({
      assetId: ETH,
      proposalId: null,
      destination: null,
      reviewReason: 'sanctions',
    });
    expect(over.amount.toFixed()).toBe((excess - ETH_FEE_WEI).toString());
    expect(await draftReturn(ctx(), over.id)).toMatchObject({ proposalId: null });
    await queueHeldReturn(ctx(), p.id);
    expect(await refundsOf(p.id)).toHaveLength(2);
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  /** The token from the latest `refund_needs_address` email. */
  const mailedToken = () =>
    decodeURIComponent(
      new URL(mailer.sent.at(-1)!.data.refund_address_url!).searchParams.get('t')!,
    );
  const byToken = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/checkout/refund-address', payload });

  it('the emailed link: a valid token works once; reused, expired or wrong-refund tokens are 401', async () => {
    const a = await overpaid({ sender: BINANCE, email: 'ada@example.com' });
    const tokenA = mailedToken();
    const b = await overpaid({ sender: BINANCE, email: 'bob@example.com' });
    const tokenB = mailedToken();
    const [ra] = await refundsOf(a.p.id);
    const [rb] = await refundsOf(b.p.id);
    expect(ra!.addressTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ra!.addressTokenHash).not.toContain(tokenA.split('.')[1]);

    // Wrong refund: B's secret under A's refund id.
    const forged = `${ra!.id}.${tokenB.split('.')[1]}`;
    let res = await byToken({ token: forged, address: WALLET, chain: 'eth' });
    expect(res.statusCode, res.body).toBe(401);
    res = await byToken({ token: 'garbage', address: WALLET, chain: 'eth' });
    expect(res.statusCode).toBe(401);

    // A sanctioned address is refused without consuming the token.
    res = await byToken({ token: tokenA, address: SANCTIONED, chain: 'eth' });
    expect(res.statusCode, res.body).toBe(403);

    res = await byToken({ token: tokenA, address: WALLET, chain: 'eth' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ refund_id: ra!.id, status: 'pending_approval' });
    const doneA = await prisma.refund.findUniqueOrThrow({ where: { id: ra!.id } });
    expect(doneA).toMatchObject({
      needsAddress: false,
      destination: WALLET,
      addressTokenHash: null,
    });
    expect(doneA.proposalId).not.toBeNull();
    // Reused.
    res = await byToken({ token: tokenA, address: WALLET, chain: 'eth' });
    expect(res.statusCode).toBe(401);

    // Expired.
    await prisma.refund.update({
      where: { id: rb!.id },
      data: { addressTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    res = await byToken({ token: tokenB, address: WALLET, chain: 'eth' });
    expect(res.statusCode).toBe(401);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: rb!.id } })).needsAddress).toBe(
      true,
    );
  });

  it('a draft cancelled in Postgres: the sweeper detaches it into review (refund.needs_review)', async () => {
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    await prisma.accountProposal.update({
      where: { id: r!.proposalId! },
      data: { status: 'cancelled' },
    });
    await sweepReturns();
    const after = await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } });
    expect(after).toMatchObject({
      proposalId: null,
      status: 'pending',
      reviewReason: 'proposal_cancelled',
    });
    const [ev] = await eventsOf('refund.needs_review');
    expect(ev!.payload).toMatchObject({
      refund_id: r!.id,
      proposal_id: r!.proposalId,
      review_reason: 'proposal_cancelled',
    });
    // Not re-drafted automatically; a second sweep changes nothing.
    await sweepReturns();
    expect(await eventsOf('refund.needs_review')).toHaveLength(1);
    expect(await prisma.accountProposal.count()).toBe(1);
  });

  async function proposalEvent(type: string, proposalId: string, payload: object = {}) {
    return prisma.event.create({
      data: {
        id: newId('evt'),
        merchantId: merchant.id,
        livemode: false,
        aggregateType: 'account_proposal',
        aggregateId: proposalId,
        type,
        payload: { proposalId, kind: 'refund', txHash: 'tx-1', ...payload },
      },
    });
  }

  it('an on-chain cancel or expiry sends the return to review', async () => {
    const one = await overpaid();
    const [r1] = await refundsOf(one.p.id);
    await onRefundProposalCancelled(
      await proposalEvent('account.proposal.cancelled', r1!.proposalId!),
    );
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r1!.id } })).toMatchObject({
      proposalId: null,
      reviewReason: 'proposal_cancelled',
    });

    const two = await overpaid();
    const [r2] = await refundsOf(two.p.id);
    await onRefundProposalFailed(
      await proposalEvent('account.proposal.failed', r2!.proposalId!, { reason: 'expired' }),
    );
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r2!.id } })).toMatchObject({
      proposalId: null,
      reviewReason: 'proposal_expired',
    });
    expect(await eventsOf('refund.needs_review')).toHaveLength(2);
  });

  it('a locally cancelled draft the chain executes anyway is still confirmed once', async () => {
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    const proposalId = r!.proposalId!;
    await prisma.accountProposal.update({
      where: { id: proposalId },
      data: { status: 'cancelled' },
    });
    await sweepReturns();
    await onRefundProposalExecuted(await proposalEvent('account.proposal.executed', proposalId));
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({
      status: 'confirmed',
      proposalId,
      reviewReason: null,
    });
    expect(await eventsOf('refund.sent')).toHaveLength(1);
  });

  const chainView = (status: string) => ({
    id: 'x',
    status,
    approvals: [],
    valid_approvals: 0,
    ready_at: null,
  });

  it('a Postgres-cancelled draft with a stale relay claim is not detached while live on chain', async () => {
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    const proposalId = r!.proposalId!;
    // Cancelled through a stale claim: the relay may have landed.
    await prisma.accountProposal.update({
      where: { id: proposalId },
      data: { status: 'cancelled', relayClaimedAt: new Date(Date.now() - 10 * 60_000) },
    });
    fake.scriptView(accountNear, 'get_proposal', () => chainView('pending'));
    await sweepReturns();
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({
      proposalId,
      reviewReason: null,
    });
    // The mirror follows the chain: the local-only cancel is revived.
    expect(
      (await prisma.accountProposal.findUniqueOrThrow({ where: { id: proposalId } })).status,
    ).toBe('pending');
    expect(await eventsOf('refund.needs_review')).toEqual([]);
  });

  it('a Postgres-cancelled draft with a relay claim is detached once the chain shows it absent', async () => {
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    await prisma.accountProposal.update({
      where: { id: r!.proposalId! },
      data: { status: 'cancelled', relayClaimedAt: new Date(Date.now() - 10 * 60_000) },
    });
    // The view cannot be read: nothing is detached.
    fake.scriptView(accountNear, 'get_proposal', () => {
      throw new Error('rpc down');
    });
    await sweepReturns();
    expect((await refundsOf(p.id))[0]!.proposalId).not.toBeNull();
    fake.scriptView(accountNear, 'get_proposal', () => null);
    await sweepReturns();
    expect((await refundsOf(p.id))[0]).toMatchObject({
      proposalId: null,
      reviewReason: 'proposal_cancelled',
    });
  });

  it('a detached refund is re-linked when its proposal comes back from a local-only cancel', async () => {
    const a = await overpaid();
    const [ra] = await refundsOf(a.p.id);
    const pa = ra!.proposalId!;
    await prisma.accountProposal.update({ where: { id: pa }, data: { status: 'cancelled' } });
    await sweepReturns();
    expect((await refundsOf(a.p.id))[0]!.proposalId).toBeNull();
    // A relay landed after all (markOnChain).
    await tenantTransaction(ctx(), (tx, c) => markOnChain(tx, c, pa));
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: ra!.id } })).toMatchObject({
      proposalId: pa,
      reviewReason: null,
    });

    const b = await overpaid();
    const [rb] = await refundsOf(b.p.id);
    const pb = rb!.proposalId!;
    await prisma.accountProposal.update({ where: { id: pb }, data: { status: 'cancelled' } });
    await sweepReturns();
    expect((await refundsOf(b.p.id))[0]!.proposalId).toBeNull();
    // The contract's view shows it timelocked (applyProposalView).
    await tenantTransaction(ctx(), (tx, c) =>
      applyProposalView(tx, c, pb, {
        ...chainView('pending'),
        ready_at: String(BigInt(Date.now() + 3_600_000) * 1_000_000n),
      } as never),
    );
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: rb!.id } })).toMatchObject({
      proposalId: pb,
      reviewReason: null,
    });
  });

  it('an executed refund proposal that matches no waiting refund confirms nothing and flags review', async () => {
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    const original = r!.proposalId!;
    // A second (stray) proposal for the same refund executes while the refund is on the first.
    const stray = await prisma.accountProposal.create({
      data: {
        id: newId('prop'),
        merchantId: merchant.id,
        livemode: false,
        accountId: (await prisma.accountProposal.findUniqueOrThrow({ where: { id: original } }))
          .accountId,
        onchainId: 'f'.repeat(64),
        kind: 'refund',
        action: {},
        salt: '',
        status: 'executed',
        refundId: r!.id,
      },
    });
    await onRefundProposalExecuted(await proposalEvent('account.proposal.executed', stray.id));
    await onRefundProposalExecuted(await proposalEvent('account.proposal.executed', stray.id));
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({
      status: 'pending',
      proposalId: original,
    });
    expect(await eventsOf('refund.sent')).toEqual([]);
    const flagged = await eventsOf('refund.needs_review');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.payload).toMatchObject({
      proposal_id: stray.id,
      refund_id: r!.id,
      review_reason: 'executed_unmatched',
    });
  });

  it('M-5: a human refund proposal (no linked refund) executing raises no alert and no review', async () => {
    const { p } = await overpaid();
    const [r] = await refundsOf(p.id);
    const accountId = (
      await prisma.accountProposal.findUniqueOrThrow({ where: { id: r!.proposalId! } })
    ).accountId;
    // Drafted by a person with money:request through project 2: not a system draft.
    const human = await prisma.accountProposal.create({
      data: {
        id: newId('prop'),
        merchantId: merchant.id,
        livemode: false,
        accountId,
        onchainId: 'e'.repeat(64),
        kind: 'refund',
        action: {},
        salt: '',
        status: 'executed',
        refundId: null,
      },
    });
    logSpy.mockClear();
    await onRefundProposalExecuted(await proposalEvent('account.proposal.executed', human.id));
    expect(await eventsOf('refund.needs_review')).toEqual([]);
    expect(await eventsOf('refund.sent')).toEqual([]);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/OPS ALERT/);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({
      status: 'pending',
    });
  });

  it('a held return whose delivered amount is unknown is refused for review', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('HELD');
    // Held before the swap's transfer was verified (no claim; M-3 claims one when it can).
    await prisma.settlementClaim.deleteMany({ where: { paymentId: p.id } });
    const real = await sim.status(q.deposit_address);
    vi.spyOn(sim, 'status').mockResolvedValue({
      ...real,
      swapDetails: { ...real.swapDetails, amountOut: undefined },
    });
    const r = (await queueHeldReturn(ctx(), p.id))!;
    expect(r).toMatchObject({ reviewReason: 'amount_unknown', proposalId: null });
    expect(r.amount.toFixed()).toBe('0');
    await prisma.refund.update({ where: { id: r.id }, data: { acknowledgedLegalAt: new Date() } });
    expect(await draftReturn(ctx(), r.id)).toMatchObject({ proposalId: null });
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  it('M-3: a held payment claims its verified transfer, and its return is sized from the claim', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('HELD');
    const claim = await prisma.settlementClaim.findFirstOrThrow({ where: { paymentId: p.id } });
    const real = await sim.status(q.deposit_address);
    expect(claim.amount.toFixed()).toBe(real.swapDetails.amountOut);
    // 1Click now reports more than was verifiably delivered: the claim wins.
    vi.spyOn(sim, 'status').mockResolvedValue({
      ...real,
      swapDetails: {
        ...real.swapDetails,
        amountOut: (BigInt(real.swapDetails.amountOut!) * 2n).toString(),
      },
    });
    const r = (await queueHeldReturn(ctx(), p.id))!;
    expect(r.amount.toFixed()).toBe((BigInt(claim.amount.toFixed()) - 500_000n).toString());
  });

  it('C40: a payment held while 1Click is still PROCESSING is watched until SUCCESS, then verified', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'overpay', { senderAddress: SANCTIONED });
    const real = await sim.status(q.deposit_address);
    // The first poll sees the deposit while the swap is still running: held at detection.
    const spy = vi.spyOn(sim, 'status').mockResolvedValue({
      status: 'PROCESSING',
      swapDetails: {
        ...real.swapDetails,
        destinationChainTxHashes: [],
        amountOut: '0',
        refundedAmount: '0',
      },
    });
    await poll(q.deposit_address);
    let p = await paymentOf(q.id);
    expect(p).toMatchObject({ status: 'HELD', oneclickStatus: 'PROCESSING' });
    expect(await prisma.settlementClaim.count({ where: { paymentId: p.id } })).toBe(0);
    // Still watched: the held payment's amounts are not known yet.
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).watchStoppedAt,
    ).toBeNull();

    spy.mockRestore();
    await poll(q.deposit_address);
    p = await paymentOf(q.id);
    // Still held (never settled, never un-held); now SUCCESS, claimed, and polling stops.
    expect(p).toMatchObject({ status: 'HELD', oneclickStatus: 'SUCCESS' });
    expect(await eventsOf('payment.succeeded')).toEqual([]);
    const claim = await prisma.settlementClaim.findFirstOrThrow({ where: { paymentId: p.id } });
    expect(claim.amount.toFixed()).toBe(real.swapDetails.amountOut);
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).watchStoppedAt,
    ).not.toBeNull();
    const qRow = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(await heldAmount(ctx(), p, qRow, USDC)).toEqual({
      assetId: USDC,
      amount: BigInt(real.swapDetails.amountOut!),
    });
    // The excess is queued (in review), and the sanctions return is sized, not amount_unknown.
    const over = await prisma.refund.findFirstOrThrow({
      where: { paymentId: p.id, reason: 'overpaid' },
    });
    expect(over).toMatchObject({ assetId: ETH, reviewReason: 'sanctions', proposalId: null });
    const r = (await queueHeldReturn(ctx(), p.id))!;
    expect(r.reviewReason).toBeNull();
    expect(r.amount.toFixed()).toBe((BigInt(claim.amount.toFixed()) - 500_000n).toString());
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  it('C40: the sweeper queues a held excess the hook missed — in review, never drafted', async () => {
    onReturnNeeded(null);
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'overpay', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('HELD');
    expect(await refundsOf(p.id)).toEqual([]);
    await sweepReturns();
    const [over] = await refundsOf(p.id);
    expect(over).toMatchObject({ reason: 'overpaid', reviewReason: 'sanctions', proposalId: null });
    expect(await prisma.accountProposal.count()).toBe(0);
  });

  it('setShopperEmail mails only when it set the email', async () => {
    const { s } = await overpaid({ sender: BINANCE });
    await prisma.session.update({ where: { id: s.id }, data: { customerEmail: 'x@example.com' } });
    const res = await call('POST', 'email', s.client_secret, { email: 'ada@example.com' });
    expect(res.statusCode).toBe(409); // the email is no longer needed
    expect(mailer.sent).toEqual([]);
  });

  it('a held payment draft without the legal acknowledgement is refused', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('HELD');
    const r = (await queueHeldReturn(ctx(), p.id))!;
    expect(r).toMatchObject({ reason: 'sanctions', assetId: USDC, proposalId: null });
    // Sized from 1Click's reported amountOut (not the quote estimate), less the $0.50 return fee.
    const delivered = BigInt((await sim.status(q.deposit_address)).swapDetails.amountOut!);
    expect(r.returnFee?.toFixed()).toBe('500000');
    expect(r.amount.toFixed()).toBe((delivered - 500_000n).toString());
    await expect(draftReturn(ctx(), r.id)).rejects.toMatchObject({ code: 'LEGAL_ACK_REQUIRED' });
    await sweepReturns();
    expect(await prisma.accountProposal.count()).toBe(0);
    expect((await call('GET', 'session', s.client_secret)).statusCode).toBe(200);

    // Acknowledged, the destination (the sanctioned sender) still screens: never drafted.
    await prisma.refund.update({ where: { id: r.id }, data: { acknowledgedLegalAt: new Date() } });
    const after = await draftReturn(ctx(), r.id);
    expect(after).toMatchObject({ status: 'failed', reviewReason: 'sanctions', proposalId: null });
    expect(await prisma.accountProposal.count()).toBe(0);
    expect(await eventsOf('payment.held')).toHaveLength(1); // not repeated
  });
});
