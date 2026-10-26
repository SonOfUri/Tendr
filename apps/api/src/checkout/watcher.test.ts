import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients, type NearClient } from '../near/client.js';
import { eventLog } from '../near/events.js';
import type { FakeNearClient } from '../near/fake.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';
import { HOLD_NOTICE } from './hold.js';
import {
  resetOneClickProviders,
  SimulatedOneClick,
  simulatedDestinationTxHash,
  type StatusResponse,
} from './oneclick/index.js';
import { onScreeningAllowed, retryPendingScreenings } from './screening.js';
import { resetTokenCache } from './tokens.js';
import {
  classify,
  expireSessions,
  onReturnNeeded,
  pollDeposit,
  registerWatcherHooks,
  scanDueDeposits,
  setWatcherDeps,
  SLOW_POLL_MS,
  verify,
  FAST_POLL_MS,
  WATCH_MAX_MS,
} from './watcher.js';

const sim1click = isolatedSimStore();
const ETH = 'nep141:eth.test'; // blockchain "eth", 18 decimals, $2500 in the simulation
const USDC = 'nep141:usdc.test'; // blockchain "near", 6 decimals, $1 — the settlement asset
const INTENTS = 'intents-mock.tendr.testnet';
const WALLET = '0x1111111111111111111111111111111111111111';
const SANCTIONED = '0x000000000000000000000000000000000000dEaD';

describe('classify', () => {
  const quote = { amountIn: 1000n, deadline: new Date('2026-01-01T00:12:00Z') };
  const st = (
    status: StatusResponse['status'],
    d: Partial<StatusResponse['swapDetails']> = {},
  ): StatusResponse => ({
    status,
    swapDetails: { originChainTxHashes: [{ hash: '0xa' }], destinationChainTxHashes: [], ...d },
  });
  const open = { status: 'PROCESSING' };
  const before = new Date('2026-01-01T00:05:00Z');
  const after = new Date('2026-01-01T00:20:00Z');

  it('maps 1Click statuses to outcomes', () => {
    expect(
      classify(quote, open, {
        status: 'PENDING_DEPOSIT',
        swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [] },
      }),
    ).toBe('pending');
    expect(classify(quote, open, st('KNOWN_DEPOSIT_TX'), before)).toBe('pending');
    expect(classify(quote, open, st('PROCESSING'), before)).toBe('pending');
    expect(classify(quote, open, st('SUCCESS', { refundedAmount: '0' }), before)).toBe('settled');
    expect(classify(quote, open, st('SUCCESS', { refundedAmount: '5' }), before)).toBe('overpaid');
    expect(classify(quote, open, st('INCOMPLETE_DEPOSIT'), before)).toBe('underpaid');
    expect(classify(quote, open, st('REFUNDED', { depositedAmount: '500' }), before)).toBe(
      'underpaid',
    );
    expect(classify(quote, open, st('FAILED'), before)).toBe('failed');
  });

  it('is late after the deadline or with the session closed', () => {
    expect(classify(quote, open, st('INCOMPLETE_DEPOSIT'), after)).toBe('late');
    expect(classify(quote, open, st('REFUNDED', { depositedAmount: '500' }), after)).toBe('late');
    // M-1: a full deposit refunded before the deadline is a failed swap (e.g. slippage), not late.
    expect(classify(quote, open, st('REFUNDED', { depositedAmount: '1000' }), before)).toBe(
      'failed',
    );
    expect(classify(quote, open, st('REFUNDED', { depositedAmount: '1000' }), after)).toBe('late');
    for (const status of ['SETTLED', 'EXPIRED', 'LATE_DEPOSIT', 'HELD', 'REFUNDED']) {
      expect(classify(quote, { status }, st('SUCCESS'), before)).toBe('late');
    }
    // A SUCCESS observed after the deadline was still accepted by 1Click in time.
    expect(classify(quote, open, st('SUCCESS'), after)).toBe('settled');
  });
});

describe('payment watcher', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let accountId: string;
  let sim: SimulatedOneClick;
  let fake: FakeNearClient;
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const returns = vi.fn(async () => {});
  let logSpy: ReturnType<typeof vi.spyOn>;

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
    returns.mockClear();
    onReturnNeeded(returns);
    registerWatcherHooks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({
      name: 'Bean Shop',
      defaultFeePayer: 'merchant',
      defaultGasPayer: 'buyer',
    });
    const account = await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    accountId = account.nearAccountId as string;
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
    onReturnNeeded(null);
    onScreeningAllowed(null);
    resetTokenCache();
    resetOneClickProviders();
    resetNearClients();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  async function newSession(amount = '25.00') {
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
  const sessionOf = (id: string) => prisma.session.findUniqueOrThrow({ where: { id } });
  const eventTypes = async () =>
    (
      await prisma.event.findMany({
        where: {
          merchantId: merchant.id,
          type: { startsWith: 'payment.' },
          NOT: { type: 'payment.status_changed' },
        },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.type);
  const eventsOf = (type: string) =>
    prisma.event.findMany({
      where: { merchantId: merchant.id, type },
      orderBy: { createdAt: 'asc' },
    });

  it('exact: verified settlement → SETTLED, payment.succeeded, revenue rows', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    const [r] = await poll(q.deposit_address);
    expect(r).toMatchObject({ outcome: 'settled', stopped: true });

    const p = await paymentOf(q.id);
    expect(p.status).toBe('SETTLED');
    expect(p.verifiedBy).toBe('receipt');
    expect(p.settleTx).toBe(simulatedDestinationTxHash(q.deposit_address));
    expect(p.keptSmallOverpayment).toBe(false);
    expect(p.overpaidAmount).toBeNull();
    expect(p.senderAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(p.senderChain).toBe('eth');
    expect((await sessionOf(s.id)).status).toBe('SETTLED');
    expect(await eventTypes()).toEqual([
      'payment.detected',
      'payment.processing',
      'payment.succeeded',
    ]);
    const [succeeded] = await eventsOf('payment.succeeded');
    expect(succeeded!.payload).toMatchObject({
      payment_id: p.id,
      session_id: s.id,
      overpaid_amount: null,
      kept_small_overpayment: false,
      verified_by: 'receipt',
    });

    // Revenue: Tendr's fee (50 bps × amountIn), 1Click's fee + spread, the network fee.
    const rev = await prisma.revenueEntry.findMany({ where: { paymentId: p.id } });
    const bySource = Object.fromEntries(rev.map((e) => [e.source, e]));
    expect(Object.keys(bySource).sort()).toEqual(['app_fee', 'network_fee', 'oneclick_fee']);
    expect(bySource.app_fee!.assetId).toBe(ETH);
    expect(bySource.app_fee!.amount.toFixed()).toBe(
      ((BigInt(q.amount_in) * 50n) / 10_000n).toString(),
    );
    expect(bySource.network_fee!.amountUsd?.toFixed()).toBe('0.5');
    expect(bySource.app_fee!.txHash).toBe(p.settleTx);

    // Polling stopped; another poll changes nothing.
    const quoteRow = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(quoteRow.watchStoppedAt).not.toBeNull();
    await poll(q.deposit_address);
    expect((await eventsOf('payment.succeeded')).length).toBe(1);
  });

  describe('I-2: test mode settles with the rpc driver (NODE_ENV=production)', () => {
    /** The deployed driver: testnet answers UNKNOWN_TRANSACTION (null) for a simulator hash. */
    function rpcLike(livemode: boolean): NearClient {
      const real = fakeNearClient(livemode);
      const c = Object.create(real) as FakeNearClient;
      c.txStatus = async () => null;
      return c;
    }

    it('a simulated settlement is verified through the simulator, not testnet', async () => {
      setWatcherDeps({ now: clock, near: rpcLike });
      const s = await newSession();
      const q = await quote(s.client_secret);
      await sim.simulate(q.deposit_address, 'exact');
      const [r] = await poll(q.deposit_address);
      expect(r).toMatchObject({ outcome: 'settled', stopped: true });
      const p = await paymentOf(q.id);
      expect(p.status).toBe('SETTLED');
      expect(p.verifiedBy).toBe('receipt');
      expect(p.settleTx).toBe(simulatedDestinationTxHash(q.deposit_address));
      expect(await eventTypes()).toContain('payment.succeeded');
    });

    it('the simulator never verifies a LIVE payment', async () => {
      setWatcherDeps({ now: clock, near: rpcLike });
      const s = await newSession();
      const q = await quote(s.client_secret);
      await sim.simulate(q.deposit_address, 'exact');
      const status = await sim.status(q.deposit_address);
      const quoteRow = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      const session = await sessionOf(s.id);
      const created = await createRow('Payment', merchant.id, false, {
        sessionId: s.id,
        quoteId: q.id,
        status: 'PROCESSING',
      });
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: created.id as string },
      });
      const test = { merchantId: merchant.id, livemode: false };
      const live = { merchantId: merchant.id, livemode: true };
      // The same SUCCESS, the same simulator hash: test mode verifies, live mode does not.
      expect(await verify({ quote: quoteRow, session, ctx: test }, payment, status)).toMatchObject({
        ok: { verifiedBy: 'receipt' },
      });
      expect(
        await verify(
          { quote: quoteRow, session: { ...session, livemode: true }, ctx: live },
          payment,
          status,
        ),
      ).toBeNull();
    });
  });

  it('SUCCESS without a matching transfer event stays PROCESSING', async () => {
    // The chain's answer alone decides here: no simulator fallback (I-2) for an unknown hash.
    setWatcherDeps({ now: clock, simulatedTx: async () => null });
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    const hash = simulatedDestinationTxHash(q.deposit_address);
    const amount = (await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).amountOut;
    const mint = (owner: string, token = USDC) =>
      eventLog('nep245', '1.0.0', 'mt_mint', [
        { owner_id: owner, token_ids: [token], amounts: [amount.toFixed()] },
      ]);
    for (const receipts of [
      // Transfer to someone else.
      [{ receiptId: 'r', executorId: INTENTS, ok: true, logs: [mint('someone.testnet')] }],
      // The right transfer, but logged by a contract that is not the intents contract.
      [{ receiptId: 'r', executorId: 'evil.testnet', ok: true, logs: [mint(accountId)] }],
      // The right transfer in a failed receipt.
      [{ receiptId: 'r', executorId: INTENTS, ok: false, logs: [mint(accountId)] }],
      // Another asset.
      [{ receiptId: 'r', executorId: INTENTS, ok: true, logs: [mint(accountId, ETH)] }],
    ]) {
      fake.scriptTxStatus(hash, { hash, signerId: 'x', receiverId: INTENTS, receipts });
      await poll(q.deposit_address);
      expect((await paymentOf(q.id)).status).toBe('PROCESSING');
    }
    fake.scriptTxStatus(hash, null); // unknown to the node yet
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('PROCESSING');
    expect((await sessionOf(s.id)).status).toBe('PROCESSING');
    expect(await eventTypes()).not.toContain('payment.succeeded');
  });

  it("another payment's transfer to the same account does not settle this payment", async () => {
    const a = await newSession();
    const qa = await quote(a.client_secret);
    const b = await newSession();
    const qb = await quote(b.client_secret);
    await sim.simulate(qa.deposit_address, 'exact');
    await poll(qa.deposit_address);
    expect((await paymentOf(qa.id)).status).toBe('SETTLED');

    // B's deposit: 1Click reports SUCCESS but names A's settlement transaction.
    await sim.simulate(qb.deposit_address, 'exact');
    const aHash = simulatedDestinationTxHash(qa.deposit_address);
    setWatcherDeps({
      now: clock,
      provider: () =>
        ({
          status: async (addr: string) => {
            const st = await sim.status(addr);
            return addr === qb.deposit_address
              ? {
                  ...st,
                  swapDetails: { ...st.swapDetails, destinationChainTxHashes: [{ hash: aHash }] },
                }
              : st;
          },
        }) as unknown as SimulatedOneClick,
    });
    await poll(qb.deposit_address);
    await poll(qb.deposit_address);
    expect((await paymentOf(qb.id)).status).toBe('PROCESSING');
    expect((await sessionOf(b.id)).status).toBe('PROCESSING');
    // Ops are told once that the only matching event is already claimed.
    const blocked = await eventsOf('payment.verification_blocked');
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.aggregateId).toBe((await paymentOf(qb.id)).id);

    // Its own transfer settles it.
    setWatcherDeps({ now: clock });
    await poll(qb.deposit_address);
    expect((await paymentOf(qb.id)).status).toBe('SETTLED');
  });

  it('a merchant withdrawal between quote and settlement does not block settlement', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    // The account balance reads zero (withdrawn); settlement never looks at balances.
    fake.scriptView(INTENTS, 'mt_batch_balance_of', (args) =>
      (args as { token_ids: string[] }).token_ids.map(() => '0'),
    );
    await sim.simulate(q.deposit_address, 'exact');
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('SETTLED');
    expect(fake.calls.filter((c) => c.kind === 'view')).toEqual([]);
  });

  it('underpay with a live quote offers a top-up; the completed top-up settles', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay');
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('PROCESSING');
    expect(p.oneclickStatus).toBe('INCOMPLETE_DEPOSIT');
    expect((await sessionOf(s.id)).status).toBe('PROCESSING');

    const view = (await call('GET', 'session', s.client_secret)).json();
    const remaining = BigInt(q.amount_in) - BigInt(q.amount_in) / 2n;
    expect(view.payments[0].state).toBe('underpaid');
    expect(view.topup).toMatchObject({
      deposit_address: q.deposit_address,
      remaining_amount: remaining.toString(),
    });
    expect(view.topup.message).toMatch(/^Send the remaining [\d.]+ ETH to the same address$/);

    await sim.simulate(q.deposit_address, 'topup');
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('SETTLED');
    expect((await sessionOf(s.id)).status).toBe('SETTLED');
    expect((await call('GET', 'session', s.client_secret)).json().topup).toBeNull();
  });

  it('underpay: the deadline passes → refunded (underpaid) and the session reopens', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay');
    await poll(q.deposit_address);
    offset = 13 * 60_000; // past the 12 min quote deadline, inside the 30 min session
    expect((await call('GET', 'session', s.client_secret)).json().topup).toBeNull();
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    // No refund address: 1Click refunded into the merchant account; the return is Task 8's.
    expect(p.status).toBe('REFUNDING');
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    const [refunded] = await eventsOf('payment.refunded');
    expect(refunded!.payload).toMatchObject({ reason: 'underpaid', refund_via: 'store' });
    expect(returns).toHaveBeenCalledWith(
      expect.objectContaining({ id: p.id }),
      expect.objectContaining({ reason: 'underpaid', assetId: ETH }),
    );
    expect(await eventTypes()).not.toContain('payment.succeeded');
  });

  it('underpay with top-ups off: no offer, the session reopens; a direct refund completes', async () => {
    setWatcherDeps({ now: clock, topupEnabled: () => false });
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(q.deposit_address, 'underpay');
    await poll(q.deposit_address);
    expect((await call('GET', 'session', s.client_secret)).json().topup).toBeNull();
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    offset = 13 * 60_000;
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('REFUNDED');
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    const [refunded] = await eventsOf('payment.refunded');
    expect(refunded!.payload).toMatchObject({ reason: 'underpaid', refund_via: 'origin_chain' });
    expect(returns).not.toHaveBeenCalled();
  });

  it('a reopen supersedes the quote: a retry needs a fresh address, the old one is refused (C34)', async () => {
    setWatcherDeps({ now: clock, topupEnabled: () => false });
    const s = await newSession();
    const a = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(a.deposit_address, 'underpay');
    await poll(a.deposit_address);
    // Reopened before A's deadline (top-ups off): A is superseded in the same transaction.
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    const rowA = await prisma.quote.findUniqueOrThrow({ where: { id: a.id } });
    expect(rowA.supersededAt).not.toBeNull();
    const view = (await call('GET', 'session', s.client_secret)).json();
    expect(view.quote).toBeNull();
    // A wallet deposit report against old A is refused (no current quote: CONFLICT).
    const stale = await call('POST', 'deposit', s.client_secret, {
      tx_hash: '0xagain',
      quote_id: a.id,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    // A new quote is allowed at once, with a fresh deposit address.
    const b = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    expect(b.deposit_address).not.toBe(a.deposit_address);
    const staleAgain = await call('POST', 'deposit', s.client_secret, {
      tx_hash: '0xagain',
      quote_id: a.id,
    });
    expect(staleAgain.json().error.code).toBe('QUOTE_MISMATCH');
    // The watcher keeps polling superseded A through its grace period.
    expect(rowA.watchStoppedAt).toBeNull();
  });

  it('a failed swap reopens with the quote superseded too (C34)', async () => {
    const s = await newSession();
    const a = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(a.deposit_address, 'failed');
    await poll(a.deposit_address);
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: a.id } })).supersededAt,
    ).not.toBeNull();
    const b = await call('POST', 'quote', s.client_secret, { origin_asset: ETH });
    expect(b.statusCode, b.body).toBe(201);
  });

  it('connected wallet whose actual sender differs and is sanctioned → HELD', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(q.deposit_address, 'exact', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('HELD');
    expect(p.heldReason).toBe('sanctions');
    expect(p.senderAddress).toBe(SANCTIONED);
    expect((await sessionOf(s.id)).status).toBe('HELD');
    const [held] = await eventsOf('payment.held');
    expect(held!.payload).toMatchObject({ notice: HOLD_NOTICE, notify: 'all_signers' });
    expect(HOLD_NOTICE).toBe(
      'These funds came from a sanctioned address. Tendr cannot freeze them; you are responsible for not using them; get legal advice.',
    );
    expect(await eventTypes()).not.toContain('payment.succeeded');
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('HELD');
  });

  it('sanctioned manual sender → HELD, never settled or refunded', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('HELD');
    expect((await sessionOf(s.id)).status).toBe('HELD');
    expect(await eventTypes()).toEqual(['payment.detected', 'payment.processing', 'payment.held']);
    expect(returns).not.toHaveBeenCalled();
  });

  it('screening unavailable → SCREENING_PENDING (not HELD); an allow retry settles', async () => {
    setWatcherDeps({ now: clock, screen: async () => ({ decision: 'unavailable' }) });
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('SCREENING_PENDING');
    expect((await sessionOf(s.id)).status).toBe('SCREENING_PENDING');
    // Still pending on the next poll (the retry job owns re-screening).
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('SCREENING_PENDING');

    // Screening comes back (test-mode fixture list: allow) → the hook settles it.
    setWatcherDeps({ now: clock });
    await retryPendingScreenings(new Date(Date.now() + 2 * 60_000));
    expect((await paymentOf(q.id)).status).toBe('SETTLED');
    expect((await sessionOf(s.id)).status).toBe('SETTLED');
    // The hook is idempotent on a settled payment.
    const p = await paymentOf(q.id);
    const { settleAfterScreening } = await import('./watcher.js');
    await settleAfterScreening(p.id, { merchantId: merchant.id, livemode: false });
    expect((await eventsOf('payment.succeeded')).length).toBe(1);
  });

  it('overpay ≥ $1 → settled, overpaid_amount, return to sender queued', async () => {
    const s = await newSession('25.00');
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'overpay');
    const [r] = await poll(q.deposit_address);
    expect(r!.outcome).toBe('overpaid');
    const p = await paymentOf(q.id);
    const excess = (BigInt(q.amount_in) / 10n).toString();
    expect(p.status).toBe('SETTLED');
    expect(p.overpaidAmount?.toFixed()).toBe(excess);
    expect(p.keptSmallOverpayment).toBe(false);
    const [ev] = await eventsOf('payment.succeeded');
    expect(ev!.payload).toMatchObject({ overpaid_amount: excess, kept_small_overpayment: false });
    expect(returns).toHaveBeenCalledWith(expect.objectContaining({ id: p.id }), {
      reason: 'overpaid',
      assetId: ETH,
      amount: excess,
    });
  });

  it('overpay < $1 → settled, kept_small_overpayment, nothing returned', async () => {
    const s = await newSession('5.00'); // 10% excess ≈ $0.50
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'overpay');
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('SETTLED');
    expect(p.keptSmallOverpayment).toBe(true);
    const [ev] = await eventsOf('payment.succeeded');
    expect(ev!.payload).toMatchObject({ kept_small_overpayment: true });
    expect(returns).not.toHaveBeenCalled();
  });

  it('late deposit → payment.late, refunded, never succeeded', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    offset = 13 * 60_000; // after the quote deadline
    await sim.simulate(q.deposit_address, 'exact'); // 1Click refunds it
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.isLate).toBe(true);
    expect(p.status).toBe('REFUNDED');
    const types = await eventTypes();
    expect(types).toContain('payment.late');
    expect(types).not.toContain('payment.succeeded');
    expect((await eventsOf('payment.late')).length).toBe(1);
    const [refunded] = await eventsOf('payment.refunded');
    expect(refunded!.payload).toMatchObject({ reason: 'late' });
    // A late refund never reopens the session (only underpay retries and failed swaps do).
    expect((await sessionOf(s.id)).status).toBe('REFUNDED');
  });

  it('M-1: a full deposit refunded before the deadline is a failed swap: reopened, not late', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    // 1Click refunds the whole deposit while the quote is live (it could not swap it).
    await sim.simulate(q.deposit_address, 'late');
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.isLate).toBe(false);
    expect(p.status).toBe('REFUNDED');
    const types = await eventTypes();
    expect(types).not.toContain('payment.late');
    expect(types).not.toContain('payment.succeeded');
    const [refunded] = await eventsOf('payment.refunded');
    expect(refunded!.payload).toMatchObject({ reason: 'failed' });
    // Reopened while unexpired, as for a failed swap; the old quote is superseded (C34).
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    const row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.supersededAt).not.toBeNull();
  });

  it('a deposit after the session expired → LATE_DEPOSIT → REFUNDED', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    offset = 31 * 60_000;
    expect(await expireSessions(clock())).toBe(1);
    expect((await sessionOf(s.id)).status).toBe('EXPIRED');
    expect((await eventsOf('checkout.session.expired'))[0]!.payload).toMatchObject({
      reason: 'timeout',
    });
    await sim.simulate(q.deposit_address, 'late');
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).isLate).toBe(true);
    expect((await sessionOf(s.id)).status).toBe('REFUNDED');
    expect(await eventTypes()).not.toContain('payment.succeeded');
  });

  it('a deposit to a superseded quote is attributed to it (Review Focus 1)', async () => {
    const s = await newSession();
    const q1 = await quote(s.client_secret, { origin_asset: ETH });
    const q2 = await quote(s.client_secret, { origin_asset: 'nep141:wrap.testnet' });
    expect(q2.deposit_address).not.toBe(q1.deposit_address);
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: q1.id } })).supersededAt,
    ).not.toBeNull();

    // The shopper sends to the old address anyway; the scan still picks it up.
    await sim.simulate(q1.deposit_address, 'exact');
    const enqueued: string[] = [];
    await scanDueDeposits(async (j) => void enqueued.push(j.depositAddress), clock());
    expect(enqueued).toContain(q1.deposit_address);
    await poll(q1.deposit_address);
    expect((await paymentOf(q1.id)).status).toBe('SETTLED');
    expect((await sessionOf(s.id)).status).toBe('SETTLED');
  });

  it('a superseded quote with no deposit stops polling 30 min after its deadline', async () => {
    const s = await newSession();
    const q1 = await quote(s.client_secret, { origin_asset: ETH });
    await quote(s.client_secret, { origin_asset: 'nep141:wrap.testnet' });
    offset = 13 * 60_000;
    await poll(q1.deposit_address);
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: q1.id } })).watchStoppedAt,
    ).toBeNull();
    offset = 43 * 60_000;
    const [r] = await poll(q1.deposit_address);
    expect(r!.stopped).toBe(true);
  });

  it('a second payment into a settled session is late and returned; paid once (Review Focus 2)', async () => {
    const s = await newSession();
    const q1 = await quote(s.client_secret, { origin_asset: ETH });
    const q2 = await quote(s.client_secret, { origin_asset: 'nep141:wrap.testnet' });
    await sim.simulate(q2.deposit_address, 'exact');
    await poll(q2.deposit_address);
    expect((await sessionOf(s.id)).status).toBe('SETTLED');

    await sim.simulate(q1.deposit_address, 'exact');
    await poll(q1.deposit_address);
    const second = await paymentOf(q1.id);
    expect(second.isLate).toBe(true);
    expect(second.status).toBe('REFUNDING');
    expect(returns).toHaveBeenCalledWith(
      expect.objectContaining({ id: second.id }),
      expect.objectContaining({ reason: 'late', assetId: USDC }),
    );
    expect((await sessionOf(s.id)).status).toBe('SETTLED');
    expect((await eventsOf('payment.succeeded')).length).toBe(1);
    expect((await eventsOf('payment.late')).length).toBe(1);
    expect(await prisma.payment.count({ where: { sessionId: s.id, status: 'SETTLED' } })).toBe(1);
  });

  it('M-2: a late overpaid deposit swapped into the store also returns the excess (origin asset)', async () => {
    const s = await newSession();
    const q1 = await quote(s.client_secret, { origin_asset: ETH }); // no refund address: INTENTS
    const q2 = await quote(s.client_secret, { origin_asset: 'nep141:wrap.testnet' });
    await sim.simulate(q2.deposit_address, 'exact');
    await poll(q2.deposit_address);
    expect((await sessionOf(s.id)).status).toBe('SETTLED');

    await sim.simulate(q1.deposit_address, 'overpay');
    await poll(q1.deposit_address);
    const late = await paymentOf(q1.id);
    expect(late.isLate).toBe(true);
    expect(late.status).toBe('REFUNDING');
    const excess = (await sim.status(q1.deposit_address)).swapDetails.refundedAmount!;
    expect(BigInt(excess)).toBeGreaterThan(0n);
    expect(returns).toHaveBeenCalledWith(
      expect.objectContaining({ id: late.id }),
      expect.objectContaining({ reason: 'late', assetId: USDC }),
    );
    expect(returns).toHaveBeenCalledWith(expect.objectContaining({ id: late.id }), {
      reason: 'overpaid',
      assetId: ETH,
      amount: excess,
    });
    // Once: another poll queues nothing more.
    const n = returns.mock.calls.length;
    await poll(q1.deposit_address);
    expect(returns.mock.calls.length).toBe(n);
  });

  it('two concurrent polls of one address create one payment and settle once', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    await Promise.allSettled([poll(q.deposit_address), poll(q.deposit_address)]);
    await poll(q.deposit_address);
    expect(await prisma.payment.count({ where: { quoteId: q.id } })).toBe(1);
    expect((await paymentOf(q.id)).status).toBe('SETTLED');
    expect((await eventsOf('payment.succeeded')).length).toBe(1);
    expect((await eventsOf('payment.detected')).length).toBe(1);
  });

  it('scans: claims with a lease, 5 s while viewed, 30 s otherwise, stops after 24 h', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    const jobs: string[] = [];
    const enqueue = async (j: { depositAddress: string }) => void jobs.push(j.depositAddress);
    const t0 = clock();
    expect(await scanDueDeposits(enqueue, t0)).toBe(1);
    // Claimed: a second scan does not enqueue it again.
    expect(await scanDueDeposits(enqueue, t0)).toBe(0);

    await poll(q.deposit_address); // no page read → slow interval
    let row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.watchNextAt!.getTime() - Date.now()).toBeGreaterThan(SLOW_POLL_MS - 2_000);

    await call('GET', 'session', s.client_secret); // the page reads the session
    await poll(q.deposit_address);
    row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.watchNextAt!.getTime() - Date.now()).toBeLessThanOrEqual(FAST_POLL_MS + 500);

    // 24 h after the quote: never polled again.
    const later = new Date(row.createdAt.getTime() + WATCH_MAX_MS + 1);
    jobs.length = 0;
    expect(await scanDueDeposits(enqueue, later)).toBe(0);
    expect(jobs).toEqual([]);
    row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.watchStoppedAt).not.toBeNull();
    // A deposit after that is no longer picked up.
    await sim.simulate(q.deposit_address, 'exact');
    offset = WATCH_MAX_MS + 60_000;
    await poll(q.deposit_address);
    expect(await prisma.payment.count({ where: { quoteId: q.id } })).toBe(0);
  });

  /** A provider over the simulator that reports `hash` as every address's destination tx. */
  function batchProvider(hash: string) {
    return () =>
      ({
        status: async (addr: string) => {
          const st = await sim.status(addr);
          return st.status === 'SUCCESS'
            ? { ...st, swapDetails: { ...st.swapDetails, destinationChainTxHashes: [{ hash }] } }
            : st;
        },
      }) as unknown as SimulatedOneClick;
  }

  /** A provider over the simulator that hides its sender (like live 1Click) and can override. */
  function liveLikeProvider(override?: (st: StatusResponse) => StatusResponse) {
    return () =>
      ({
        status: async (addr: string) => {
          const st = await sim.status(addr);
          const { senderAddress: _hidden, ...swapDetails } = st.swapDetails;
          const out = { ...st, swapDetails };
          return override ? override(out) : out;
        },
      }) as unknown as SimulatedOneClick;
  }

  it('test mode never calls the sender resolvers (the simulated sender is used)', async () => {
    const resolveSenders = vi.fn(async () => ['0xshouldnotbeused']);
    setWatcherDeps({ now: clock, resolveSenders });
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    await poll(q.deposit_address);
    expect(resolveSenders).not.toHaveBeenCalled();
    expect((await paymentOf(q.id)).status).toBe('SETTLED');
  });

  it('resolved senders: every one is screened and any block holds (multi-input deposit)', async () => {
    const resolveSenders = vi.fn(async () => [WALLET, SANCTIONED]);
    setWatcherDeps({ now: clock, provider: liveLikeProvider(), resolveSenders });
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    await poll(q.deposit_address);
    expect(resolveSenders).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'eth', originAsset: ETH }),
    );
    const p = await paymentOf(q.id);
    expect(p.senderAddress).toBe(WALLET);
    expect(p.senderAddresses).toEqual([WALLET, SANCTIONED]);
    expect(p.status).toBe('HELD');
    const rows = await prisma.screeningResult.findMany({ where: { sessionId: s.id } });
    expect(rows.map((r) => [r.address, r.decision]).sort()).toEqual([
      [SANCTIONED, 'block'],
      [WALLET, 'allow'],
    ]);
  });

  it('resolved senders all allowed → settles; no sender found → SCREENING_PENDING', async () => {
    setWatcherDeps({
      now: clock,
      provider: liveLikeProvider(),
      resolveSenders: async () => [WALLET, '0x2222222222222222222222222222222222222222'],
    });
    const a = await newSession();
    const qa = await quote(a.client_secret);
    await sim.simulate(qa.deposit_address, 'exact');
    await poll(qa.deposit_address);
    expect((await paymentOf(qa.id)).status).toBe('SETTLED');

    setWatcherDeps({ now: clock, provider: liveLikeProvider(), resolveSenders: async () => [] });
    const b = await newSession();
    const qb = await quote(b.client_secret);
    await sim.simulate(qb.deposit_address, 'exact');
    await poll(qb.deposit_address);
    expect((await paymentOf(qb.id)).status).toBe('SCREENING_PENDING');
    expect((await paymentOf(qb.id)).senderAddresses).toEqual([]);
  });

  it('HELD, then 1Click refunds straight to the shopper → REFUNDING → REFUNDED, session REFUNDED', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(q.deposit_address, 'underpay', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('HELD');
    expect((await sessionOf(s.id)).status).toBe('HELD');
    // Still watched: 1Click refunds the short deposit at the deadline.
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).watchStoppedAt,
    ).toBeNull();
    offset = 13 * 60_000;
    const [r] = await poll(q.deposit_address);
    expect(r!.stopped).toBe(true);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('REFUNDED');
    expect(p.heldReason).toBe('sanctions');
    expect((await sessionOf(s.id)).status).toBe('REFUNDED');
    const [refunded] = await eventsOf('payment.refunded');
    expect(refunded!.payload).toMatchObject({ reason: 'sanctions', refund_via: 'origin_chain' });
    const moves = (await eventsOf('payment.status_changed')).map(
      (e) => `${(e.payload as { from: string }).from}>${(e.payload as { to: string }).to}`,
    );
    expect(moves.slice(-2)).toEqual(['HELD>REFUNDING', 'REFUNDING>REFUNDED']);
    expect(returns).not.toHaveBeenCalled();
  });

  it('HELD with a store-path refund stays HELD (signers decide) and polling stops', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay', { senderAddress: SANCTIONED });
    const [r] = await poll(q.deposit_address);
    expect(r!.stopped).toBe(true);
    offset = 13 * 60_000;
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('HELD');
    expect((await sessionOf(s.id)).status).toBe('HELD');
    expect(await eventsOf('payment.refunded')).toEqual([]);
    expect(returns).not.toHaveBeenCalled();
  });

  it('SCREENING_PENDING, then 1Click refunds straight to the shopper → REFUNDED, session REFUNDED', async () => {
    setWatcherDeps({ now: clock, screen: async () => ({ decision: 'unavailable' }) });
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(q.deposit_address, 'exact');
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('SCREENING_PENDING');
    expect((await sessionOf(s.id)).status).toBe('SCREENING_PENDING');
    setWatcherDeps({
      now: clock,
      screen: async () => ({ decision: 'unavailable' }),
      provider: liveLikeProvider((st) => ({
        status: 'REFUNDED',
        swapDetails: {
          ...st.swapDetails,
          destinationChainTxHashes: [],
          refundedAmount: st.swapDetails.depositedAmount!,
        },
      })),
    });
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('REFUNDED');
    expect((await sessionOf(s.id)).status).toBe('REFUNDED');
    expect((await eventsOf('payment.refunded')).length).toBe(1);
    expect(await eventsOf('payment.succeeded')).toEqual([]);
  });

  it('one destination tx with two transfer events settles two payments (batched)', async () => {
    const a = await newSession();
    const qa = await quote(a.client_secret);
    const b = await newSession();
    const qb = await quote(b.client_secret);
    await sim.simulate(qa.deposit_address, 'exact');
    await sim.simulate(qb.deposit_address, 'exact');
    const amount = (await prisma.quote.findUniqueOrThrow({ where: { id: qa.id } })).amountOut;
    const mint = eventLog('nep245', '1.0.0', 'mt_mint', [
      { owner_id: accountId, token_ids: [USDC], amounts: [amount.toFixed()] },
    ]);
    const BATCH = 'batch-tx-hash';
    fake.scriptTxStatus(BATCH, {
      hash: BATCH,
      signerId: 'solver.testnet',
      receiverId: INTENTS,
      receipts: [{ receiptId: 'r1', executorId: INTENTS, ok: true, logs: [mint, mint] }],
    });
    setWatcherDeps({ now: clock, provider: batchProvider(BATCH) });
    await poll(qa.deposit_address);
    await poll(qb.deposit_address);
    expect((await paymentOf(qa.id)).status).toBe('SETTLED');
    expect((await paymentOf(qb.id)).status).toBe('SETTLED');
    const claims = await prisma.settlementClaim.findMany({ orderBy: { eventKey: 'asc' } });
    expect(claims.map((c) => [c.txHash, c.receiptId, c.eventKey])).toEqual([
      [BATCH, 'r1', '0.0.0'],
      [BATCH, 'r1', '1.0.0'],
    ]);
  });

  it('one transfer event never settles two payments; the second raises an ops event', async () => {
    const a = await newSession();
    const qa = await quote(a.client_secret);
    const b = await newSession();
    const qb = await quote(b.client_secret);
    await sim.simulate(qa.deposit_address, 'exact');
    await sim.simulate(qb.deposit_address, 'exact');
    const amount = (await prisma.quote.findUniqueOrThrow({ where: { id: qa.id } })).amountOut;
    const ONE = 'single-event-tx';
    fake.scriptTxStatus(ONE, {
      hash: ONE,
      signerId: 'solver.testnet',
      receiverId: INTENTS,
      receipts: [
        {
          receiptId: 'r1',
          executorId: INTENTS,
          ok: true,
          logs: [
            eventLog('nep245', '1.0.0', 'mt_mint', [
              { owner_id: accountId, token_ids: [USDC], amounts: [amount.toFixed()] },
            ]),
          ],
        },
      ],
    });
    setWatcherDeps({ now: clock, provider: batchProvider(ONE) });
    await Promise.allSettled([poll(qa.deposit_address), poll(qb.deposit_address)]);
    await poll(qa.deposit_address);
    await poll(qb.deposit_address);
    const statuses = [(await paymentOf(qa.id)).status, (await paymentOf(qb.id)).status].sort();
    expect(statuses).toEqual(['PROCESSING', 'SETTLED']);
    expect(await prisma.settlementClaim.count()).toBe(1);
    expect((await eventsOf('payment.verification_blocked')).length).toBe(1);
  });

  it('a top-up from a different, sanctioned sender holds the payment', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay', { senderAddress: WALLET });
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('PROCESSING');
    await sim.simulate(q.deposit_address, 'topup', { senderAddress: SANCTIONED });
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('HELD');
    expect(p.senderAddresses).toEqual([WALLET, SANCTIONED]);
    expect(p.senderOriginHashes.length).toBe(2);
    expect(await eventsOf('payment.succeeded')).toEqual([]);
  });

  it('a top-up whose sender cannot be read keeps the payment from settling', async () => {
    const resolveSenders = vi.fn(async (i: { originTxHashes: string[] }) =>
      i.originTxHashes.length === 1 && resolvable.has(i.originTxHashes[0]!) ? [WALLET] : [],
    );
    const resolvable = new Set<string>();
    setWatcherDeps({ now: clock, provider: liveLikeProvider(), resolveSenders });
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay');
    resolvable.add((await sim.status(q.deposit_address)).swapDetails.originChainTxHashes[0]!.hash);
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).senderAddresses).toEqual([WALLET]);
    await sim.simulate(q.deposit_address, 'topup'); // its sender lookup fails
    await poll(q.deposit_address);
    const p = await paymentOf(q.id);
    expect(p.status).toBe('SCREENING_PENDING');
    expect(p.senderOriginHashes.length).toBe(1);
    expect(await eventsOf('payment.succeeded')).toEqual([]);
  });

  it('a store-path refund is recorded once (payment.refunded + return) across repeated polls', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'underpay');
    await poll(q.deposit_address);
    offset = 13 * 60_000;
    await Promise.allSettled([poll(q.deposit_address), poll(q.deposit_address)]);
    // Force more polls of a stopped address (as a racing sweep or hook would).
    await prisma.quote.update({ where: { id: q.id }, data: { watchStoppedAt: null } });
    await poll(q.deposit_address);
    await prisma.quote.update({ where: { id: q.id }, data: { watchStoppedAt: null } });
    await poll(q.deposit_address);
    expect((await eventsOf('payment.refunded')).length).toBe(1);
    expect(returns).toHaveBeenCalledTimes(1);
    expect((await paymentOf(q.id)).refundsRecorded).toEqual(['underpaid']);
  });

  it('expiry waits for a reported deposit until its quote deadline plus the grace', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    // Reported by the shopper, not yet seen by 1Click.
    await prisma.quote.update({
      where: { id: q.id },
      data: { depositTxHash: '0xreported', depositTxSubmittedAt: clock() },
    });
    offset = 31 * 60_000; // session expired; quote deadline (12 min) + 30 min grace not passed
    expect(await expireSessions(clock())).toBe(0);
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    offset = 43 * 60_000;
    await prisma.quote.update({ where: { id: q.id }, data: { watchNextAt: null } });
    expect(await expireSessions(clock())).toBe(1);
    expect((await sessionOf(s.id)).status).toBe('EXPIRED');
  });

  it('expiry never polls under a running poll lease; it waits for a poll after expiry', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    offset = 31 * 60_000;
    const statusSpy = vi.spyOn(sim, 'status');
    // A poll job holds the lease (claimed, not finished).
    await prisma.quote.update({
      where: { id: q.id },
      data: { watchNextAt: new Date(clock().getTime() + 60_000), watchPolledAt: null },
    });
    expect(await expireSessions(clock())).toBe(0);
    expect(statusSpy).not.toHaveBeenCalled();
    // That poll completes after the expiry: the sweep can expire without polling.
    await prisma.quote.update({ where: { id: q.id }, data: { watchPolledAt: clock() } });
    expect(await expireSessions(clock())).toBe(1);
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('the 24 h stop raises payment.verification_timeout for an unverified SUCCESS', async () => {
    setWatcherDeps({ now: clock, simulatedTx: async () => null });
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    fake.scriptTxStatus(simulatedDestinationTxHash(q.deposit_address), null);
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('PROCESSING');
    offset = WATCH_MAX_MS + 60_000;
    const [r] = await poll(q.deposit_address);
    expect(r!.stopped).toBe(true);
    const [ev] = await eventsOf('payment.verification_timeout');
    expect(ev!.aggregateId).toBe((await paymentOf(q.id)).id);
  });

  it('worker jobs: the scan fans out one poll job per address; the poll job settles', async () => {
    const { processCheckoutJob, POLL_DEPOSIT_JOB, SCAN_DEPOSITS_JOB } =
      await import('../worker.js');
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    const add = vi.fn(async () => ({}));
    await processCheckoutJob({ name: SCAN_DEPOSITS_JOB, data: {} }, { add } as never);
    const data = { depositAddress: q.deposit_address, livemode: false };
    expect(add).toHaveBeenCalledWith(POLL_DEPOSIT_JOB, data, {
      jobId: `poll__test__${q.deposit_address}`,
      removeOnComplete: true,
      removeOnFail: true,
    });
    await processCheckoutJob({ name: POLL_DEPOSIT_JOB, data }, { add } as never);
    expect((await paymentOf(q.id)).status).toBe('SETTLED');
  });

  it('expiry polls first: a deposit made before expiry settles instead of expiring', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret);
    await sim.simulate(q.deposit_address, 'exact');
    offset = 31 * 60_000;
    expect(await expireSessions(clock())).toBe(0);
    expect((await sessionOf(s.id)).status).toBe('SETTLED');
  });

  it('FAILED → REFUNDING with the session reopened, REFUNDED once 1Click refunds', async () => {
    const s = await newSession();
    const q = await quote(s.client_secret, { origin_asset: ETH, refund_address: WALLET });
    await sim.simulate(q.deposit_address, 'failed');
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('REFUNDING');
    expect((await sessionOf(s.id)).status).toBe('PENDING_DEPOSIT');
    const status: StatusResponse = {
      ...(await sim.status(q.deposit_address)),
      status: 'REFUNDED',
    };
    setWatcherDeps({
      now: clock,
      provider: () => ({ status: async () => status }) as unknown as SimulatedOneClick,
    });
    await poll(q.deposit_address);
    expect((await paymentOf(q.id)).status).toBe('REFUNDED');
  });
});
