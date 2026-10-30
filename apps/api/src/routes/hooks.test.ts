// Integrator hooks over the API (project 5a, Task 11): `hook_data` on session create, the hook
// call list and the resend. Delivery itself is simulated in test mode (no RPC).
import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { recordEvent } from '../events/record.js';
import { setHookTransport, type HookTransport } from '../hooks/deliver.js';
import { createHookCallForPayment } from '../hooks/hooks.js';
import { prisma } from '../lib/prisma.js';
import { CONNECTION_KEY_SCOPES, type MerchantUserRole } from '@tendr/contracts';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { pollDeposit } from '../checkout/watcher.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { dashHeaders, loginAs } from '../test/dashboard.js';
import { isolatedSimStore } from '../test/sim-1click.js';
import { createApiKey, createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

const CONTRACT = '0x00000000000000000000000000000000000c0de1';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const SETTLE_TX = `0x${'ab'.repeat(32)}`;

describe('integrator hook routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let key: string;
  let readOnlyKey: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  async function integrator(
    over: { kind?: 'merchant' | 'integrator'; settlement?: Record<string, unknown> } = {},
  ) {
    merchant = await createMerchant({ kind: over.kind ?? 'integrator' });
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC_BASE,
      destChain: 'base',
      payoutMode: 'wallet',
      payoutAddress: CONTRACT,
      isDefault: true,
      ...over.settlement,
    });
    key = (await createApiKey(merchant.id, { livemode: false })).raw;
    readOnlyKey = (
      await createApiKey(merchant.id, {
        livemode: false,
        scopes: ['sessions:read', 'payments:read'],
      })
    ).raw;
  }

  beforeEach(async () => {
    await resetDb();
    resetTokenCache();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => {
    setHookTransport(null);
    await app.close();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const body = (over: Record<string, unknown> = {}) => ({
    amount: '25.00',
    amount_currency: 'USD',
    external_ref: `order-${Math.random().toString(36).slice(2)}`,
    success_url: 'https://game.example/thanks',
    cancel_url: 'https://game.example/cart',
    ...over,
  });

  const create = (payload: unknown, k = key) =>
    app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${k}` },
      payload: payload as Record<string, unknown>,
    });

  /** A SETTLED payment of the session, and its `payment.succeeded` handled (the hook trigger). */
  async function settle(sessionId: string) {
    const quote = await createRow('Quote', merchant.id, false, {
      sessionId,
      amountOut: '24950000',
      hookFeeUsd: '0.048',
    });
    const payment = await createRow('Payment', merchant.id, false, {
      sessionId,
      quoteId: quote.id,
      status: 'SETTLED',
      settleTx: SETTLE_TX,
      amountOut: '24950000',
      settledAt: new Date(),
    });
    const ctx = { merchantId: merchant.id, livemode: false };
    const eventId = await prisma.$transaction((tx) =>
      recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: payment.id as string,
        type: 'payment.succeeded',
        payload: { payment_id: payment.id, session_id: sessionId },
      }),
    );
    await createHookCallForPayment(
      await prisma.event.findUniqueOrThrow({ where: { id: eventId } }),
    );
    return payment.id as string;
  }

  describe('session create: hook_data', () => {
    it('an integrator settling into a contract gets delivery HOOK with its hook_data', async () => {
      await integrator();
      const res = await create(body({ hook_data: { player: 'p-42', order: 7 } }));
      expect(res.statusCode, res.body).toBe(201);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row.delivery).toBe('HOOK');
      expect(row.hookData).toEqual({ player: 'p-42', order: 7 });
      expect(row.recipient).toBe(CONTRACT);

      const view = await app.inject({
        method: 'GET',
        url: `/v1/checkout/sessions/${row.id}`,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(view.json()).toMatchObject({
        delivery: 'hook',
        hook_data: { player: 'p-42', order: 7 },
      });
    });

    it('without hook_data an integrator session keeps webhook delivery', async () => {
      await integrator();
      const res = await create(body());
      expect(res.statusCode, res.body).toBe(201);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row.delivery).toBe('WEBHOOK');
      expect(row.hookData).toBeNull();
    });

    it('NEAR contract destinations are hook destinations too', async () => {
      await integrator({
        settlement: {
          destAssetId: 'nep141:usdt.tether-token.near',
          destChain: 'near',
          payoutAddress: 'game.near',
        },
      });
      const res = await create(body({ hook_data: 'player-9' }));
      expect(res.statusCode, res.body).toBe(201);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row.delivery).toBe('HOOK');
      expect(row.hookData).toBe('player-9');
    });

    it('hook_data is refused for a store that is not an integrator', async () => {
      await integrator({ kind: 'merchant' });
      const res = await create(body({ hook_data: { player: 'p-1' } }));
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { field: 'hook_data' },
      });
      expect(await prisma.session.count()).toBe(0);
    });

    it('hook_data is refused when the payout is the merchant account (intents)', async () => {
      await integrator({ settlement: { payoutMode: 'intents', payoutAddress: null } });
      const res = await create(body({ hook_data: { player: 'p-1' } }));
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.details).toMatchObject({ field: 'hook_data' });
    });

    it('hook_data is refused on a settlement chain without hooks (Solana, Tron)', async () => {
      for (const [chain, addr] of [
        ['sol', 'So11111111111111111111111111111111111111112'],
        ['tron', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'],
      ] as const) {
        await resetDb();
        await integrator({ settlement: { destChain: chain, payoutAddress: addr } });
        const res = await create(body({ hook_data: { player: 'p-1' } }));
        expect(res.statusCode, `${chain}: ${res.body}`).toBe(400);
        expect(res.json().error.details).toMatchObject({ field: 'hook_data' });
      }
    });

    it('hook_data over 1 KB serialized is a 400', async () => {
      await integrator();
      const res = await create(body({ hook_data: { blob: 'x'.repeat(1020) } }));
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.session.count()).toBe(0);

      const exact = await create(body({ hook_data: 'x'.repeat(1022) }));
      expect(exact.statusCode, exact.body).toBe(201);
    });

    it('hook_data: null is refused (omit the field instead)', async () => {
      await integrator();
      const res = await create(body({ hook_data: null }));
      expect(res.statusCode, res.body).toBe(400);
    });
  });

  describe('GET /v1/hook-calls', () => {
    it('lists the mode calls with filters and cursor paging; succeeded in test mode', async () => {
      await integrator();
      const ids: string[] = [];
      const payments: string[] = [];
      for (let i = 0; i < 3; i++) {
        const s = await create(body({ hook_data: { player: `p-${i}` } }));
        ids.push(s.json().id);
        payments.push(await settle(s.json().id));
      }
      const list = await app.inject({
        method: 'GET',
        url: '/v1/hook-calls?limit=2',
        headers: { authorization: `Bearer ${readOnlyKey}` },
      });
      expect(list.statusCode, list.body).toBe(200);
      const page = list.json();
      expect(page.hook_calls).toHaveLength(2);
      expect(page.has_more).toBe(true);
      const call = page.hook_calls[0];
      expect(Object.keys(call).sort()).toEqual(
        [
          'id',
          'livemode',
          'payment_id',
          'session_id',
          'chain',
          'contract',
          'hook_data',
          'status',
          'attempts',
          'tx_hash',
          'last_error',
          'next_retry_at',
          'retry_until',
          'succeeded_at',
          'created_at',
          'updated_at',
        ].sort(),
      );
      expect(call).toMatchObject({
        livemode: false,
        chain: 'base',
        contract: CONTRACT,
        session_id: ids[2],
        payment_id: payments[2],
        hook_data: { player: 'p-2' },
        status: 'succeeded',
        attempts: 1,
      });
      expect(call.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

      const next = await app.inject({
        method: 'GET',
        url: `/v1/hook-calls?limit=2&starting_after=${page.next_cursor}`,
        headers: { authorization: `Bearer ${readOnlyKey}` },
      });
      expect(next.json().hook_calls.map((c: { session_id: string }) => c.session_id)).toEqual([
        ids[0],
      ]);

      const byPayment = await app.inject({
        method: 'GET',
        url: `/v1/hook-calls?payment=${payments[1]}`,
        headers: { authorization: `Bearer ${readOnlyKey}` },
      });
      expect(byPayment.json().hook_calls.map((c: { payment_id: string }) => c.payment_id)).toEqual([
        payments[1],
      ]);
      const bySession = await app.inject({
        method: 'GET',
        url: `/v1/hook-calls?session=${ids[0]}`,
        headers: { authorization: `Bearer ${readOnlyKey}` },
      });
      expect(bySession.json().hook_calls).toHaveLength(1);
      const failed = await app.inject({
        method: 'GET',
        url: '/v1/hook-calls?status=failed',
        headers: { authorization: `Bearer ${readOnlyKey}` },
      });
      expect(failed.json().hook_calls).toEqual([]);
      const bad = await app.inject({
        method: 'GET',
        url: '/v1/hook-calls?status=exploded',
        headers: { authorization: `Bearer ${readOnlyKey}` },
      });
      expect(bad.statusCode).toBe(400);

      // Live keys never see test-mode calls.
      const live = (await createApiKey(merchant.id, { livemode: true })).raw;
      const other = await app.inject({
        method: 'GET',
        url: '/v1/hook-calls',
        headers: { authorization: `Bearer ${live}` },
      });
      expect(other.json().hook_calls).toEqual([]);
    });

    it('a payment that is not SETTLED has no hook call (delivery after SETTLED only)', async () => {
      await integrator();
      const s = await create(body({ hook_data: { player: 'p-1' } }));
      const quote = await createRow('Quote', merchant.id, false, { sessionId: s.json().id });
      const payment = await createRow('Payment', merchant.id, false, {
        sessionId: s.json().id,
        quoteId: quote.id,
        status: 'PROCESSING',
      });
      const ctx = { merchantId: merchant.id, livemode: false };
      const eventId = await prisma.$transaction((tx) =>
        recordEvent(tx, ctx, {
          aggregateType: 'payment',
          aggregateId: payment.id as string,
          type: 'payment.succeeded',
          payload: { payment_id: payment.id, session_id: s.json().id },
        }),
      );
      await createHookCallForPayment(
        await prisma.event.findUniqueOrThrow({ where: { id: eventId } }),
      );
      expect(await prisma.hookCall.count()).toBe(0);
    });

    it('a webhook-delivery session never gets a hook call', async () => {
      await integrator();
      const s = await create(body());
      await settle(s.json().id);
      expect(await prisma.hookCall.count()).toBe(0);
    });
  });

  describe('POST /v1/payments/:id/hook/resend', () => {
    const resend = (paymentId: string, k = key) =>
      app.inject({
        method: 'POST',
        url: `/v1/payments/${paymentId}/hook/resend`,
        headers: { authorization: `Bearer ${k}` },
      });

    it('works after the call failed; refused while one is in flight, retrying or succeeded', async () => {
      await integrator();
      let outcome: Awaited<ReturnType<HookTransport>> = {
        outcome: 'failed',
        txHash: null,
        costUsd: null,
        error: 'execution reverted: Paused()',
      };
      setHookTransport(async () => outcome);
      const s = await create(body({ hook_data: { player: 'p-1' } }));
      const paymentId = await settle(s.json().id);
      let row = await prisma.hookCall.findUniqueOrThrow({ where: { paymentId } });
      expect(row.status).toBe('pending'); // retrying automatically
      expect(row.lastError).toBe('execution reverted: Paused()');

      const retrying = await resend(paymentId);
      expect(retrying.statusCode, retrying.body).toBe(409);
      expect(retrying.json().error.message).toMatch(/retried automatically/);

      // In flight: an attempt holds the lease.
      await prisma.hookCall.update({
        where: { id: row.id },
        data: { status: 'failed', leaseUntil: new Date(Date.now() + 60_000) },
      });
      const inFlight = await resend(paymentId);
      expect(inFlight.statusCode, inFlight.body).toBe(409);
      expect(inFlight.json().error.code).toBe('CONFLICT');

      // In flight: a transaction is submitted, its outcome pending.
      await prisma.hookCall.update({
        where: { id: row.id },
        data: { status: 'submitted', leaseUntil: null },
      });
      const submitted = await resend(paymentId);
      expect(submitted.statusCode).toBe(409);
      expect(submitted.json().error.message).toMatch(/in flight/);

      // Failed (window over): the resend sends now.
      await prisma.hookCall.update({ where: { id: row.id }, data: { status: 'failed' } });
      outcome = { outcome: 'succeeded', txHash: `0x${'cd'.repeat(32)}`, costUsd: null };
      const ok = await resend(paymentId);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ status: 'succeeded', tx_hash: `0x${'cd'.repeat(32)}` });
      row = await prisma.hookCall.findUniqueOrThrow({ where: { paymentId } });
      expect(row.status).toBe('confirmed');
      expect(row.attempt).toBe(2);

      const again = await resend(paymentId);
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json().error.message).toMatch(/already succeeded/);
    });

    it('at most 3 manual resends per hook call; the 4th is refused with a clear error', async () => {
      await integrator();
      const sent: string[] = [];
      setHookTransport(async (call) => {
        sent.push(call.hookCallId);
        return {
          outcome: 'failed',
          txHash: null,
          costUsd: null,
          error: 'reverted',
          terminal: true,
        };
      });
      const s = await create(body({ hook_data: { player: 'p-1' } }));
      const paymentId = await settle(s.json().id);
      let row = await prisma.hookCall.findUniqueOrThrow({ where: { paymentId } });
      expect(row.status).toBe('failed');
      for (let i = 1; i <= 3; i++) {
        const r = await resend(paymentId);
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().status).toBe('failed');
      }
      const refused = await resend(paymentId);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.message).toMatch(/already resent 3 times/);
      expect(refused.json().error.details).toMatchObject({ max_resends: 3, resends: 3 });
      expect(sent).toHaveLength(4); // the first attempt + 3 resends, nothing more
      row = await prisma.hookCall.findUniqueOrThrow({ where: { paymentId } });
      expect(row.manualResends).toBe(3);
    });

    it('needs a full secret key (sessions:write); unknown payments are 404', async () => {
      await integrator();
      const denied = await resend('pay_01J0000000000000000000000Z', readOnlyKey);
      expect(denied.statusCode).toBe(403);
      const missing = await resend('pay_01J0000000000000000000000Z');
      expect(missing.statusCode).toBe(404);
      // A webhook-delivery payment has no hook call to resend.
      const s = await create(body());
      const paymentId = await settle(s.json().id);
      const none = await resend(paymentId);
      expect(none.statusCode, none.body).toBe(409);
    });
  });

  describe('auth', () => {
    async function connectionKey() {
      const conn = await createRow('Connection', merchant.id, false, {});
      const { raw, record } = await createApiKey(merchant.id, {
        livemode: false,
        scopes: [...CONNECTION_KEY_SCOPES],
      });
      await prisma.apiKey.update({ where: { id: record.id }, data: { connectionId: conn.id } });
      return raw;
    }
    async function member(role: MerchantUserRole) {
      const user = await createUser({ emailVerifiedAt: new Date() });
      await createRow('MerchantUser', merchant.id, false, { userId: user.id, role });
      return dashHeaders(await loginAs(user.id), { merchantId: merchant.id, livemode: false });
    }
    async function failedPayment() {
      setHookTransport(async () => ({
        outcome: 'failed',
        txHash: null,
        costUsd: null,
        error: 'execution reverted: Paused()',
        terminal: true,
      }));
      const s = await create(body({ hook_data: { player: 'p-1' } }));
      const paymentId = await settle(s.json().id);
      setHookTransport(null);
      return paymentId;
    }

    it('a connected site key is refused on both routes (403)', async () => {
      await integrator();
      const paymentId = await failedPayment();
      const raw = await connectionKey();
      const list = await app.inject({
        method: 'GET',
        url: '/v1/hook-calls',
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(list.statusCode, list.body).toBe(403);
      const resend = await app.inject({
        method: 'POST',
        url: `/v1/payments/${paymentId}/hook/resend`,
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(resend.statusCode, resend.body).toBe(403);
      expect((await prisma.hookCall.findUniqueOrThrow({ where: { paymentId } })).status).toBe(
        'failed',
      );
    });

    it('dashboard: any member lists; only webhooks:resend may resend', async () => {
      await integrator();
      const paymentId = await failedPayment();
      for (const role of ['viewer', 'finance'] as const) {
        const headers = await member(role);
        const list = await app.inject({ method: 'GET', url: '/v1/hook-calls', headers });
        expect(list.statusCode, `${role}: ${list.body}`).toBe(200);
        expect(list.json().hook_calls).toHaveLength(1);
        const denied = await app.inject({
          method: 'POST',
          url: `/v1/payments/${paymentId}/hook/resend`,
          headers,
        });
        expect(denied.statusCode, `${role}: ${denied.body}`).toBe(403);
      }
      const admin = await member('admin');
      const ok = await app.inject({
        method: 'POST',
        url: `/v1/payments/${paymentId}/hook/resend`,
        headers: admin,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().status).toBe('succeeded');
    });
  });

  describe('test mode end to end (watcher → SETTLED → hook)', () => {
    const sim1click = isolatedSimStore();
    let sim: SimulatedOneClick;

    beforeEach(async () => {
      await sim1click.clear();
      resetNearClients();
      fakeNearClient(false);
      sim = new SimulatedOneClick({ store: sim1click.store() });
      resetOneClickProviders({ simulated: sim });
    });
    afterEach(() => {
      resetOneClickProviders();
      resetNearClients();
    });
    afterAll(async () => {
      await sim1click.clear();
    });

    it('an EVM-settled HOOK session is notified once the simulated settlement lands', async () => {
      await integrator();
      const s = await create(body({ hook_data: { player: 'p-7' } }));
      expect(s.statusCode, s.body).toBe(201);
      const q = await app.inject({
        method: 'POST',
        url: '/v1/checkout/client/quote',
        headers: { authorization: `Bearer ${s.json().client_secret}` },
        payload: { origin_asset: 'nep141:eth.test' },
      });
      expect(q.statusCode, q.body).toBe(201);
      const depositAddress = q.json().deposit_address as string;
      await sim.simulate(depositAddress, 'exact');
      await pollDeposit(depositAddress, { livemode: false });

      const payment = await prisma.payment.findFirstOrThrow({ where: { sessionId: s.json().id } });
      expect(payment.status).toBe('SETTLED');
      // A wallet payout on an EVM chain settles with an EVM-shaped transaction hash.
      expect(payment.settleTx).toMatch(/^0x[0-9a-f]{64}$/);
      const event = await prisma.event.findFirstOrThrow({
        where: { type: 'payment.succeeded', aggregateId: payment.id },
      });
      // The outbox handler (registered for payment.succeeded) creates and delivers the hook.
      await createHookCallForPayment(event);
      const hook = await prisma.hookCall.findUniqueOrThrow({ where: { paymentId: payment.id } });
      expect(hook).toMatchObject({ status: 'confirmed', attempt: 1, lastError: null });
      expect(await prisma.event.count({ where: { type: 'hook.succeeded' } })).toBe(1);
      expect(await prisma.event.count({ where: { type: 'hook.failed' } })).toBe(0);
    });
  });
});
