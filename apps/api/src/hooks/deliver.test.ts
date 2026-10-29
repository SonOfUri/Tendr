// Integrator hook delivery (project 5a, Task 11, spec §4.2–4.3): the retry schedule and window,
// the one-time failure alert, success events, Tendr's loss on gas above the estimate, and the
// live EVM / NEAR senders (faked: no RPC, no KMS).
import type { Merchant } from '@prisma/client';
import { Interface } from 'ethers';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryMailer, setMailer } from '../auth/mailer.js';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import { webhookData } from '../checkout/webhooks.js';
import { recordEvent } from '../events/record.js';
import { setFeeDeps } from '../gas/fees.js';
import { prisma } from '../lib/prisma.js';
import { EvmNotBroadcastError, EvmRpcError, type EvmSendInput } from '../relayer/evm/sender.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  EVM_ALREADY_NOTIFIED_SELECTOR,
  HOOK_GAS_CEILING,
  HOOK_RETRY_BASE_MS,
  setHookLeaseRenewMs,
  applyEvmHookOutcome,
  attemptHook,
  pollNearHooks,
  setHookDeliveryDeps,
  setHookTransport,
  sweepDueHooks,
  type HookTransport,
} from './deliver.js';
import { INTEGRATOR_HOOK_PURPOSE, ON_TENDR_DEPOSIT_ABI } from './guard.js';
import { createHookCallForPayment, onHookFailedNotice } from './hooks.js';

const CONTRACT = '0x00000000000000000000000000000000000c0de1';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const SETTLE_TX = `0x${'ab'.repeat(32)}`;
const DAY = 24 * 3600_000;
const TOKENS: TokenInfo[] = [
  {
    assetId: 'nep141:base.omft.near',
    symbol: 'ETH',
    blockchain: 'base',
    decimals: 18,
    priceUsd: '2500',
  },
  { assetId: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24, priceUsd: '3' },
];

describe('hook delivery', () => {
  let merchant: Merchant;
  let mailer: MemoryMailer;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mailer = new MemoryMailer();
    setMailer(mailer);
    setFeeDeps({ tokens: async () => new Map(TOKENS.map((t) => [t.assetId, t])) });
    merchant = await createMerchant({
      kind: 'integrator',
      name: 'Game Co',
      notificationEmail: 'ops@game.example',
    });
  });
  afterEach(() => {
    setHookTransport(null);
    setHookDeliveryDeps(null);
    setFeeDeps(null);
    setMailer(null);
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A HOOK session settled into the contract and its hook call (created, first attempt made). */
  async function settledHook(
    opts: {
      livemode?: boolean;
      chain?: string;
      contract?: string;
      asset?: string;
      settleTx?: string;
      at?: Date;
      session?: Record<string, unknown>;
      quote?: Record<string, unknown>;
    } = {},
  ) {
    const livemode = opts.livemode ?? false;
    const ctx = { merchantId: merchant.id, livemode };
    const session = await createRow('Session', merchant.id, livemode, {
      delivery: 'HOOK',
      hookData: { player: 'p-42' },
      destChain: opts.chain ?? 'base',
      destAsset: opts.asset ?? USDC_BASE,
      recipient: opts.contract ?? CONTRACT,
      recipientType: 'DESTINATION_CHAIN',
      externalRef: 'order-7',
      status: 'SETTLED',
      ...opts.session,
    });
    const quote = await createRow('Quote', merchant.id, livemode, {
      sessionId: session.id,
      hookFeeUsd: '0.048',
      ...opts.quote,
    });
    const payment = await createRow('Payment', merchant.id, livemode, {
      sessionId: session.id,
      quoteId: quote.id,
      status: 'SETTLED',
      settleTx: opts.settleTx ?? SETTLE_TX,
      amountOut: '24950000',
      settledAt: new Date(),
    });
    const eventId = await prisma.$transaction((tx) =>
      recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: payment.id as string,
        type: 'payment.succeeded',
        payload: { payment_id: payment.id, session_id: session.id },
      }),
    );
    await createHookCallForPayment(
      await prisma.event.findUniqueOrThrow({ where: { id: eventId } }),
      opts.at ?? new Date(),
    );
    const hook = await prisma.hookCall.findUniqueOrThrow({
      where: { paymentId: payment.id as string },
    });
    return { session, quote, payment, hook };
  }

  const reverting: HookTransport = async () => ({
    outcome: 'failed',
    txHash: null,
    costUsd: null,
    error: 'execution reverted: Paused()',
  });

  describe('test mode (simulated)', () => {
    it('a simulated call succeeds on the first attempt: confirmed + hook.succeeded', async () => {
      const { hook, payment, session } = await settledHook();
      expect(hook.status).toBe('confirmed');
      expect(hook.attempt).toBe(1);
      expect(hook.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(hook.succeededAt).not.toBeNull();
      expect(hook.chain).toBe('base');
      expect(hook.targetContract).toBe(CONTRACT);
      expect(hook.hookData).toEqual({ player: 'p-42' });
      const ev = await prisma.event.findFirstOrThrow({ where: { type: 'hook.succeeded' } });
      expect(ev.payload).toMatchObject({
        payment_id: payment.id,
        session_id: session.id,
        external_ref: 'order-7',
        hook_call_id: hook.id,
        chain: 'base',
        contract: CONTRACT,
        tx_hash: hook.txHash,
        attempts: 1,
      });
      // The webhook carries the hook fields.
      expect(webhookData(ev.payload, 'hook.succeeded')).toMatchObject({
        hook_call_id: hook.id,
        contract: CONTRACT,
        tx_hash: hook.txHash,
        attempts: 1,
      });
      // No loss: the simulated call costs nothing.
      expect(await prisma.gasSponsorship.count()).toBe(0);
    });

    it('one hook call per payment: a replayed payment.succeeded creates nothing new', async () => {
      const { payment } = await settledHook();
      const ev = await prisma.event.findFirstOrThrow({ where: { type: 'payment.succeeded' } });
      await createHookCallForPayment(ev);
      expect(await prisma.hookCall.count({ where: { paymentId: payment.id as string } })).toBe(1);
      expect(await prisma.event.count({ where: { type: 'hook.succeeded' } })).toBe(1);
    });
  });

  describe('retries', () => {
    it('a revert is retried with 60 s × 2^(n-1) backoff and its reason stored', async () => {
      setHookTransport(reverting);
      const t0 = new Date('2026-10-28T12:00:00Z');
      const { hook } = await settledHook({ at: t0 });
      expect(hook).toMatchObject({ status: 'pending', attempt: 1 });
      expect(hook.lastError).toBe('execution reverted: Paused()');
      expect(hook.nextRetryAt!.getTime()).toBe(t0.getTime() + HOOK_RETRY_BASE_MS);
      expect(hook.retryUntil.getTime()).toBe(t0.getTime() + 3 * DAY);
      expect(hook.leaseUntil).toBeNull();

      // Not due yet: nothing is sent.
      const send = vi.fn(reverting);
      setHookTransport(send);
      expect(await attemptHook(hook.id, { now: new Date(t0.getTime() + 30_000) })).toBeNull();
      expect(send).not.toHaveBeenCalled();

      const t1 = new Date(t0.getTime() + 60_000);
      await attemptHook(hook.id, { now: t1 });
      let row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row).toMatchObject({ status: 'pending', attempt: 2 });
      expect(row.nextRetryAt!.getTime()).toBe(t1.getTime() + 120_000);

      const t2 = new Date(t1.getTime() + 120_000);
      await attemptHook(hook.id, { now: t2 });
      row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row.nextRetryAt!.getTime()).toBe(t2.getTime() + 240_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await prisma.event.count({ where: { type: { startsWith: 'hook.' } } })).toBe(0);
    });

    it('one attempt in flight at a time: a held lease blocks a second attempt', async () => {
      setHookTransport(reverting);
      const t0 = new Date('2026-10-28T12:00:00Z');
      const { hook } = await settledHook({ at: t0 });
      const t1 = new Date(t0.getTime() + 60_000);
      await prisma.hookCall.update({
        where: { id: hook.id },
        data: { leaseUntil: new Date(t1.getTime() + 30_000) },
      });
      const send = vi.fn(reverting);
      setHookTransport(send);
      expect(await attemptHook(hook.id, { now: t1 })).toBeNull();
      expect(await sweepDueHooks(t1)).toBe(0);
      expect(send).not.toHaveBeenCalled();
      // A lapsed lease (a worker died mid-attempt) is picked up again.
      const t2 = new Date(t1.getTime() + 31_000);
      expect(await sweepDueHooks(t2)).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('after the 3-day window: failed, hook.failed once, ONE alert email; the payment stays SETTLED', async () => {
      setHookTransport(reverting);
      const t0 = new Date('2026-10-28T12:00:00Z');
      const { hook, payment } = await settledHook({ at: t0 });
      // Retries run until the window closes; the last scheduled one lands on the deadline.
      let now = t0;
      for (let i = 0; i < 40; i++) {
        const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
        if (row.status !== 'pending') break;
        expect(row.nextRetryAt!.getTime()).toBeLessThanOrEqual(t0.getTime() + 3 * DAY);
        now = row.nextRetryAt!;
        await attemptHook(hook.id, { now });
      }
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row.status).toBe('failed');
      expect(now.getTime()).toBe(t0.getTime() + 3 * DAY);
      expect(row.nextRetryAt).toBeNull();
      expect(row.alertedAt).not.toBeNull();
      expect(row.lastError).toBe('execution reverted: Paused()');

      const failed = await prisma.event.findMany({ where: { type: 'hook.failed' } });
      expect(failed).toHaveLength(1);
      expect(failed[0]!.payload).toMatchObject({
        payment_id: payment.id,
        hook_call_id: hook.id,
        error: 'execution reverted: Paused()',
        attempts: row.attempt,
      });
      expect(webhookData(failed[0]!.payload, 'hook.failed')).toMatchObject({
        error: 'execution reverted: Paused()',
      });
      const p = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id as string } });
      expect(p.status).toBe('SETTLED');

      // The alert: once, to the store's notification email, even if the handler runs twice.
      await onHookFailedNotice(failed[0]!);
      await onHookFailedNotice(failed[0]!);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]).toMatchObject({ to: 'ops@game.example', template: 'hook_failed' });
      expect(mailer.sent[0]!.subject).toContain('order-7');
      expect(mailer.sent[0]!.text).toContain('execution reverted: Paused()');

      // A manual resend that fails again is one-off: failed, no second event or email.
      await prisma.hookCall.update({
        where: { id: hook.id },
        data: { status: 'pending', nextRetryAt: now, retryUntil: now },
      });
      await attemptHook(hook.id, { now: new Date(now.getTime() + DAY) });
      expect((await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } })).status).toBe(
        'failed',
      );
      expect(await prisma.event.count({ where: { type: 'hook.failed' } })).toBe(1);
    });
  });

  describe('live EVM', () => {
    const iface = new Interface(ON_TENDR_DEPOSIT_ABI);

    it('sends onTendrDeposit to the session contract through relayer-evm; the receipt confirms it', async () => {
      const sent: EvmSendInput[] = [];
      setHookDeliveryDeps({
        evmSender: {
          send: async (input) => {
            sent.push(input);
            return { txId: 'rtx_1', txHash: `0x${'11'.repeat(32)}`, broadcast: 'submitted' };
          },
        },
      });
      const { hook, payment, session } = await settledHook({ livemode: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        chain: 'base',
        to: CONTRACT,
        purpose: INTEGRATOR_HOOK_PURPOSE,
        refId: hook.id,
        // Gas limit ≤ 300k, and its cost ≤ the 10 % hook budget: $49 order → $4.9 at
        // $2500/ETH = 0.00196 ETH.
        maxGasLimit: HOOK_GAS_CEILING,
        maxCostWei: 1_960_000_000_000_000n,
      });
      expect(HOOK_GAS_CEILING).toBe(300_000n);
      const args = iface.decodeFunctionData('onTendrDeposit', sent[0]!.data);
      expect(args.toArray().map(String)).toEqual([
        // bytes32 ids: the id's UTF-8 bytes, right-padded.
        `0x${Buffer.from(payment.id as string)
          .toString('hex')
          .padEnd(64, '0')}`,
        `0x${Buffer.from(session.id as string)
          .toString('hex')
          .padEnd(64, '0')}`,
        `0x${Buffer.from('{"player":"p-42"}').toString('hex')}`,
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        '24950000',
        SETTLE_TX,
      ]);
      expect(hook).toMatchObject({ status: 'submitted', txHash: `0x${'11'.repeat(32)}` });

      // In flight: no second attempt while the transaction is out.
      expect(await attemptHook(hook.id, { manual: true })).toBeNull();
      expect(sent).toHaveLength(1);

      // The receipt: 70k gas at 1 gwei = 0.00007 ETH × $2500 = $0.175, above the $0.048
      // estimate → Tendr absorbs $0.127 (never charged to the merchant).
      await applyEvmHookOutcome({
        txId: 'rtx_1',
        purpose: INTEGRATOR_HOOK_PURPOSE,
        refId: hook.id,
        chain: 'base',
        status: 'confirmed',
        txHash: `0x${'11'.repeat(32)}`,
        gasUsed: 70_000n,
        effectiveGasPrice: 1_000_000_000n,
        reason: null,
        logs: [],
      });
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row.status).toBe('confirmed');
      expect(row.costUsd!.toFixed()).toBe('0.175');
      const loss = await prisma.gasSponsorship.findFirstOrThrow({ where: { method: 'hook' } });
      expect(loss).toMatchObject({ sponsor: 'tendr', chain: 'base', provider: 'relayer-evm' });
      expect(loss.costUsd!.toFixed()).toBe('0.127');
      expect(loss.estimateUsd!.toFixed()).toBe('0.048');
      // The shortfall is keyed per payment on its own column; nothing was recovered from it.
      expect(loss.hookPaymentId).toBe(payment.id);
      expect(loss.recoveredFromPaymentId).toBeNull();
      const { gasSponsorshipView } = await import('../gas/sponsorships.js');
      expect(gasSponsorshipView(loss)).toMatchObject({
        recovered_from_payment_id: null,
        hook_payment_id: payment.id,
      });
      expect(loss.lossRecognizedAt).not.toBeNull();
      expect(loss.reservationState).toBeNull(); // never against the budget
      expect(await prisma.event.count({ where: { type: 'hook.succeeded' } })).toBe(1);
    });

    it('pollEvmRelays hands hook outcomes to the hook (and marks them handled)', async () => {
      const { pollEvmRelays } = await import('../relayer/index.js');
      setHookDeliveryDeps({
        evmSender: {
          send: async () => ({
            txId: 'rtx_9',
            txHash: `0x${'99'.repeat(32)}`,
            broadcast: 'submitted',
          }),
        },
      });
      const { hook } = await settledHook({ livemode: true });
      const handled: string[] = [];
      const fake = {
        tick: async () => [
          {
            txId: 'rtx_9',
            purpose: INTEGRATOR_HOOK_PURPOSE,
            refId: hook.id,
            chain: 'base',
            status: 'confirmed' as const,
            txHash: `0x${'99'.repeat(32)}`,
            gasUsed: 10_000n,
            effectiveGasPrice: 1_000_000_000n,
            reason: null,
            logs: [],
          },
        ],
        markHandled: async (id: string) => {
          handled.push(id);
        },
      };
      expect(await pollEvmRelays(fake as never)).toBe(1);
      expect(handled).toEqual(['rtx_9']);
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row.status).toBe('confirmed');
    });

    it('a dry-run revert (nothing broadcast) is a failed attempt with the reason; retried', async () => {
      setHookDeliveryDeps({
        evmSender: {
          send: async () => {
            throw new EvmNotBroadcastError(
              'dry run reverted: execution reverted: Paused()',
              'simulation_reverted',
            );
          },
        },
      });
      const { hook } = await settledHook({ livemode: true });
      expect(hook.status).toBe('pending');
      expect(hook.lastError).toBe('dry run reverted: execution reverted: Paused()');
      expect(hook.nextRetryAt).not.toBeNull();
    });

    it('a mined revert is terminal: failed at once, hook.failed and one email; cost counted', async () => {
      setHookDeliveryDeps({
        evmSender: {
          send: async () => ({
            txId: 'rtx_2',
            txHash: `0x${'22'.repeat(32)}`,
            broadcast: 'submitted',
          }),
        },
      });
      const { hook } = await settledHook({ livemode: true });
      await applyEvmHookOutcome({
        txId: 'rtx_2',
        purpose: INTEGRATOR_HOOK_PURPOSE,
        refId: hook.id,
        chain: 'base',
        status: 'failed',
        txHash: `0x${'22'.repeat(32)}`,
        gasUsed: 10_000n,
        effectiveGasPrice: 1_000_000_000n,
        reason: 'reverted on chain',
        logs: [],
      });
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row).toMatchObject({ status: 'failed', nextRetryAt: null });
      expect(row.lastError).toMatch(/reverted on chain/);
      expect(row.alertedAt).not.toBeNull();
      expect(row.costUsd!.toFixed()).toBe('0.025');
      // $0.025 is within the $0.048 estimate: no loss.
      expect(await prisma.gasSponsorship.count()).toBe(0);
      const failed = await prisma.event.findMany({ where: { type: 'hook.failed' } });
      expect(failed).toHaveLength(1);
      await onHookFailedNotice(failed[0]!);
      await onHookFailedNotice(failed[0]!);
      expect(mailer.sent).toHaveLength(1);
      // The merchant can still resend it (one-off).
      expect(await attemptHook(hook.id)).toBeNull(); // no automatic retry
    });

    it('a session priced in its settlement asset: the hook budget is 10 % of its USD value', async () => {
      const sent: EvmSendInput[] = [];
      setHookDeliveryDeps({
        evmSender: {
          send: async (input) => {
            sent.push(input);
            return { txId: 'rtx_1', txHash: `0x${'11'.repeat(32)}`, broadcast: 'submitted' };
          },
        },
      });
      // 50 USDC that settled $49: the budget is 10 % of $49 = $4.9 → 0.00196 ETH.
      await settledHook({
        livemode: true,
        session: { amount: '50', amountCurrency: USDC_BASE },
        quote: { amountOutUsd: '49' },
      });
      expect(sent[0]!.maxCostWei).toBe(1_960_000_000_000_000n);
    });

    it('a settlement-asset session without a settled USD value is valued at the token price', async () => {
      const sent: EvmSendInput[] = [];
      setHookDeliveryDeps({
        evmSender: {
          send: async (input) => {
            sent.push(input);
            return { txId: 'rtx_1', txHash: `0x${'11'.repeat(32)}`, broadcast: 'submitted' };
          },
        },
      });
      // 0.02 ETH at $2500 = $50 → $5 budget → 0.002 ETH (not 10 % of "0.02" dollars).
      await settledHook({
        livemode: true,
        asset: 'nep141:base.omft.near',
        session: { amount: '0.02', amountCurrency: 'nep141:base.omft.near' },
        quote: { amountOutUsd: null },
      });
      expect(sent[0]!.maxCostWei).toBe(2_000_000_000_000_000n);
    });

    it('a gas price spike above the 10 % hook budget is retried, not terminal', async () => {
      setHookDeliveryDeps({
        evmSender: {
          send: async () => {
            throw new EvmNotBroadcastError(
              'the call may cost 9 wei (100000 gas), above its 1 wei budget',
              'gas_budget',
            );
          },
        },
      });
      const { hook } = await settledHook({ livemode: true });
      expect(hook.status).toBe('pending');
      expect(hook.nextRetryAt).not.toBeNull();
      expect(hook.lastError).toMatch(/gas price is above the hook budget/);
      expect(hook.alertedAt).toBeNull();
      expect(await prisma.event.count({ where: { type: 'hook.failed' } })).toBe(0);
    });

    it('the gas ceiling refused the send (estimate over bounds): failed at once, alerted once', async () => {
      setHookDeliveryDeps({
        evmSender: {
          send: async () => {
            throw new EvmNotBroadcastError(
              'the call needs 450000 gas, above the 300000 gas ceiling',
              'gas_cap',
            );
          },
        },
      });
      const { hook } = await settledHook({ livemode: true });
      expect(hook).toMatchObject({ status: 'failed', nextRetryAt: null });
      expect(hook.lastError).toBe(
        'hook gas above its bound: the call needs 450000 gas, above the 300000 gas ceiling',
      );
      expect(hook.alertedAt).not.toBeNull();
      const failed = await prisma.event.findMany({ where: { type: 'hook.failed' } });
      expect(failed).toHaveLength(1);
      expect(failed[0]!.payload).toMatchObject({ error: hook.lastError });
      await onHookFailedNotice(failed[0]!);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.text).toContain('gas');
    });

    it('a transport/RPC failure (nothing sent) is retried', async () => {
      setHookDeliveryDeps({
        evmSender: {
          send: async () => {
            throw new EvmNotBroadcastError('the chain is unavailable', 'unavailable');
          },
        },
      });
      const { hook } = await settledHook({ livemode: true });
      expect(hook).toMatchObject({ status: 'pending', lastError: 'the chain is unavailable' });
      expect(hook.alertedAt).toBeNull();
    });

    it('an unpriced budget (token list down) is retried, nothing sent', async () => {
      setFeeDeps({ tokens: async () => new Map() });
      const send = vi.fn();
      setHookDeliveryDeps({ evmSender: { send } });
      const { hook } = await settledHook({ livemode: true });
      expect(send).not.toHaveBeenCalled();
      expect(hook.status).toBe('pending');
      expect(hook.lastError).toMatch(/budget/);
    });

    it('the OP-stack L1 data fee (receipt l1Fee) is part of the recorded cost', async () => {
      setHookDeliveryDeps({
        evmSender: {
          send: async () => ({
            txId: 'rtx_5',
            txHash: `0x${'55'.repeat(32)}`,
            broadcast: 'submitted',
          }),
        },
      });
      const { hook } = await settledHook({ livemode: true });
      // 10k gas at 1 gwei (1e13 wei) + an L1 fee of 1e13 wei = 2e13 wei × $2500 = $0.05.
      await applyEvmHookOutcome({
        txId: 'rtx_5',
        purpose: INTEGRATOR_HOOK_PURPOSE,
        refId: hook.id,
        chain: 'base',
        status: 'confirmed',
        txHash: `0x${'55'.repeat(32)}`,
        gasUsed: 10_000n,
        effectiveGasPrice: 1_000_000_000n,
        l1Fee: 10_000_000_000_000n,
        reason: null,
        logs: [],
      });
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row.costUsd!.toFixed()).toBe('0.05');
    });

    it('the lease is renewed while a slow send runs', async () => {
      setHookLeaseRenewMs(20);
      let leaseMidSend: Date | null = null;
      let initial: Date | null = null;
      setHookDeliveryDeps({
        evmSender: {
          send: async (input) => {
            initial = (await prisma.hookCall.findUniqueOrThrow({ where: { id: input.refId } }))
              .leaseUntil;
            await new Promise((r) => setTimeout(r, 120));
            leaseMidSend = (await prisma.hookCall.findUniqueOrThrow({ where: { id: input.refId } }))
              .leaseUntil;
            return { txId: 'rtx_6', txHash: `0x${'66'.repeat(32)}`, broadcast: 'submitted' };
          },
        },
      });
      try {
        await settledHook({ livemode: true });
      } finally {
        setHookLeaseRenewMs(null);
      }
      expect(initial).not.toBeNull();
      expect(leaseMidSend!.getTime()).toBeGreaterThan(initial!.getTime());
    });

    describe('a duplicate refusal on a retry or resend counts as delivered', () => {
      const dup = () =>
        new EvmNotBroadcastError(
          'dry run reverted: eth_estimateGas: execution reverted',
          'simulation_reverted',
          new EvmRpcError(
            'eth_estimateGas',
            3,
            'execution reverted',
            `${EVM_ALREADY_NOTIFIED_SELECTOR}${'ab'.repeat(32)}`,
          ),
        );

      it('EVM: AlreadyNotified(txHash) on attempt 2 → succeeded; on attempt 1 → retried', async () => {
        setHookDeliveryDeps({
          evmSender: {
            send: async () => {
              throw dup();
            },
          },
        });
        const { hook } = await settledHook({ livemode: true });
        expect(hook.status).toBe('pending'); // first attempt: not trusted as delivered
        expect(hook.lastError).toContain(EVM_ALREADY_NOTIFIED_SELECTOR);
        await attemptHook(hook.id, { now: hook.nextRetryAt! });
        const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
        expect(row).toMatchObject({ status: 'confirmed', attempt: 2, lastError: null });
        expect(await prisma.event.count({ where: { type: 'hook.succeeded' } })).toBe(1);
      });

      it('EVM: any other revert data is not a duplicate', async () => {
        setHookDeliveryDeps({
          evmSender: {
            send: async () => {
              throw new EvmNotBroadcastError(
                'dry run reverted: eth_estimateGas: execution reverted',
                'simulation_reverted',
                new EvmRpcError('eth_estimateGas', 3, 'execution reverted', '0xdeadbeef'),
              );
            },
          },
        });
        const { hook } = await settledHook({ livemode: true });
        await attemptHook(hook.id, { now: hook.nextRetryAt! });
        const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
        expect(row.status).toBe('pending');
      });
    });

    it('a relayer transaction already out for the call is never doubled (crash after send)', async () => {
      const send = vi.fn(async () => ({
        txId: 'rtx_3',
        txHash: `0x${'33'.repeat(32)}`,
        broadcast: 'submitted' as const,
      }));
      setHookDeliveryDeps({ evmSender: { send } });
      const { hook } = await settledHook({ livemode: true });
      // Simulate the crash: the row went back to pending before `submitted` was written.
      await prisma.relayerTransaction.create({
        data: {
          id: 'rtx_3',
          chain: 'base',
          chainId: 8453,
          fromAddress: '0x0000000000000000000000000000000000000abc',
          nonce: 1n,
          toAddress: CONTRACT,
          data: '0x',
          gasLimit: '100000',
          maxFeePerGas: '1',
          maxPriorityFeePerGas: '1',
          rawTx: '0x',
          txHash: `0x${'33'.repeat(32)}`,
          txHashes: [`0x${'33'.repeat(32)}`],
          status: 'submitted',
          purpose: INTEGRATOR_HOOK_PURPOSE,
          refId: hook.id,
          giveUpAt: new Date(Date.now() + 600_000),
          attempts: 1,
        },
      });
      await prisma.hookCall.update({
        where: { id: hook.id },
        data: { status: 'pending', txHash: null, nextRetryAt: new Date(0), leaseUntil: null },
      });
      await attemptHook(hook.id);
      expect(send).toHaveBeenCalledTimes(1); // the first attempt only
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row).toMatchObject({ status: 'submitted', txHash: `0x${'33'.repeat(32)}` });
    });
  });

  describe('live NEAR', () => {
    const NEAR_TX = 'FdJ1r1WDZRRDVwF1TQUgVzKkfSXx8JzTPEhpX1zZQ6Wj';

    function fakeNear(
      result: () => Promise<unknown>,
      txStatus: () => Promise<unknown> = async () => null,
    ) {
      const signed: { receiverId: string; args: object }[] = [];
      setHookDeliveryDeps({
        nearSender: () => ({
          accountId: async () => 'relayer.near',
          signHook: async (_id: string, receiverId: string, args: object) => {
            signed.push({ receiverId, args });
            return { hash: NEAR_TX } as never;
          },
          send: result as never,
          rpc: { txStatus: txStatus as never },
        }),
      });
      return signed;
    }

    it('calls on_tendr_deposit on the session contract through relayer-near', async () => {
      const signed = fakeNear(async () => ({
        txHash: NEAR_TX,
        logs: [],
        successLogs: [],
        status: 'success',
        topLevelStatus: 'success',
        tokensBurnt: 2_000_000_000_000_000_000_000n, // 0.002 NEAR × $3 = $0.006
      }));
      const { hook, payment, session } = await settledHook({
        livemode: true,
        chain: 'near',
        contract: 'game.near',
        asset: 'nep141:usdt.tether-token.near',
        settleTx: '8tAHnxWBmrhXbLWrfjfSVBvvSDwPxXKbH5ZM4JNKTvBA',
      });
      expect(signed).toEqual([
        {
          receiverId: 'game.near',
          args: {
            payment_id: payment.id,
            session_id: session.id,
            hook_data: '{"player":"p-42"}',
            token: 'usdt.tether-token.near',
            amount: '24950000',
            tx_hash: '8tAHnxWBmrhXbLWrfjfSVBvvSDwPxXKbH5ZM4JNKTvBA',
          },
        },
      ]);
      expect(hook).toMatchObject({ status: 'confirmed', txHash: NEAR_TX });
      expect(hook.costUsd!.toFixed()).toBe('0.006');
      expect(await prisma.gasSponsorship.count()).toBe(0); // within the estimate
    });

    it('a panic in the contract is an on-chain revert: failed at once with the reason', async () => {
      fakeNear(async () => ({
        txHash: NEAR_TX,
        logs: [],
        successLogs: [],
        status: 'failure',
        topLevelStatus: 'failure',
        failure: '{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"paused"}}}}',
      }));
      const { hook } = await settledHook({
        livemode: true,
        chain: 'near',
        contract: 'game.near',
        asset: 'nep141:usdt.tether-token.near',
        settleTx: '8tAHnxWBmrhXbLWrfjfSVBvvSDwPxXKbH5ZM4JNKTvBA',
      });
      expect(hook).toMatchObject({ status: 'failed', nextRetryAt: null });
      expect(hook.lastError).toContain('paused');
      expect(await prisma.event.count({ where: { type: 'hook.failed' } })).toBe(1);
    });

    it('NEAR: the reference duplicate refusal on a retry counts as delivered', async () => {
      const dupFailure = {
        txHash: NEAR_TX,
        logs: [],
        successLogs: [],
        status: 'failure',
        topLevelStatus: 'failure',
        failure:
          '{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: already notified"}}}}',
      };
      const { OutcomeUnknownError } = await import('../near/rpc.js');
      let first = true;
      fakeNear(async () => {
        if (first) {
          first = false;
          throw new OutcomeUnknownError(new Error('timeout'), new Error('timeout'));
        }
        return dupFailure;
      });
      const t0 = new Date();
      const { hook } = await settledHook({
        livemode: true,
        chain: 'near',
        contract: 'game.near',
        asset: 'nep141:usdt.tether-token.near',
        settleTx: '8tAHnxWBmrhXbLWrfjfSVBvvSDwPxXKbH5ZM4JNKTvBA',
        at: t0,
      });
      // The first attempt's outcome is never seen: retried.
      await pollNearHooks({ now: () => new Date(t0.getTime() + 11 * 60_000) });
      const retrying = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(retrying.status).toBe('pending');
      // The retry is refused as a duplicate: the first one landed after all.
      await attemptHook(hook.id, { now: retrying.nextRetryAt! });
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row).toMatchObject({ status: 'confirmed', attempt: 2, lastError: null });
    });

    it('an unknown outcome stays submitted; the poller applies the final status', async () => {
      const { OutcomeUnknownError } = await import('../near/rpc.js');
      let status: unknown = null;
      fakeNear(
        async () => {
          throw new OutcomeUnknownError(new Error('timeout'), new Error('timeout'));
        },
        async () => status,
      );
      const t0 = new Date();
      const { hook } = await settledHook({
        livemode: true,
        chain: 'near',
        contract: 'game.near',
        asset: 'nep141:usdt.tether-token.near',
        settleTx: '8tAHnxWBmrhXbLWrfjfSVBvvSDwPxXKbH5ZM4JNKTvBA',
        at: t0,
      });
      expect(hook).toMatchObject({ status: 'submitted', txHash: NEAR_TX });
      // Not known yet, still young: left alone.
      await pollNearHooks({ now: () => new Date(t0.getTime() + 60_000) });
      expect((await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } })).status).toBe(
        'submitted',
      );
      status = {
        hash: NEAR_TX,
        signerId: 'relayer.near',
        receiverId: 'game.near',
        receipts: [{ receiptId: 'r', executorId: 'game.near', logs: [], ok: true }],
        topLevelOk: true,
        tokensBurnt: 1_000_000_000_000_000_000_000n,
      };
      await pollNearHooks({ now: () => new Date(t0.getTime() + 120_000) });
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row.status).toBe('confirmed');
      expect(row.costUsd!.toFixed()).toBe('0.003');
    });

    it('a transaction never seen within 10 minutes is a failed attempt (retried)', async () => {
      const { OutcomeUnknownError } = await import('../near/rpc.js');
      fakeNear(async () => {
        throw new OutcomeUnknownError(new Error('timeout'), new Error('timeout'));
      });
      const t0 = new Date();
      const { hook } = await settledHook({
        livemode: true,
        chain: 'near',
        contract: 'game.near',
        asset: 'nep141:usdt.tether-token.near',
        settleTx: '8tAHnxWBmrhXbLWrfjfSVBvvSDwPxXKbH5ZM4JNKTvBA',
        at: t0,
      });
      await pollNearHooks({ now: () => new Date(t0.getTime() + 11 * 60_000) });
      const row = await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } });
      expect(row.status).toBe('pending');
      expect(row.lastError).toMatch(/outcome unknown/);
    });
  });
});
