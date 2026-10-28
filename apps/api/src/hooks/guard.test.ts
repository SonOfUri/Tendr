// Ruling T11-b: relayer-evm and relayer-near sign a hook call only to the integrator's settlement
// contract of that session, only the hook method, with exactly the arguments Tendr's records give.
import type { Merchant } from '@prisma/client';
import type { Redis } from 'ioredis';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import { LocalKeyVault } from '../keyvault/local.js';
import { prisma } from '../lib/prisma.js';
import { closeClient, createRedis } from '../lib/redis.js';
import { RelayerNearSender } from '../near/client.js';
import { NearRpc } from '../near/rpc.js';
import {
  TGAS,
  buildTransaction,
  functionCallAction,
  implicitAccountId,
  signTransaction,
} from '../near/tx.js';
import { EvmRpc } from '../relayer/evm/rpc.js';
import { EvmNotBroadcastError, EvmSender } from '../relayer/evm/sender.js';
import { FakeEvmNode } from '../test/fake-evm-node.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  INTEGRATOR_HOOK_PURPOSE,
  NEAR_HOOK_ATTACHED_GAS,
  assertHookTransaction,
  encodeOnTendrDeposit,
  expectedHookCall,
} from './guard.js';

const CONTRACT = '0x00000000000000000000000000000000000c0de1';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';

describe('hook signing guards', () => {
  let merchant: Merchant;
  const kv = new LocalKeyVault(join(mkdtempSync(join(tmpdir(), 'tendr-kv-')), 'keys.json'));

  beforeEach(async () => {
    await resetDb();
    merchant = await createMerchant({ kind: 'integrator' });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function hookCall(
    over: {
      session?: Record<string, unknown>;
      hook?: Record<string, unknown>;
      near?: boolean;
    } = {},
  ) {
    const near = over.near ?? false;
    const session = await createRow('Session', merchant.id, true, {
      delivery: 'HOOK',
      hookData: { player: 'p-1' },
      destChain: near ? 'near' : 'base',
      destAsset: near ? 'nep141:usdt.tether-token.near' : USDC_BASE,
      recipient: near ? 'game.near' : CONTRACT,
      recipientType: 'DESTINATION_CHAIN',
      ...over.session,
    });
    const quote = await createRow('Quote', merchant.id, true, { sessionId: session.id });
    const payment = await createRow('Payment', merchant.id, true, {
      sessionId: session.id,
      quoteId: quote.id,
      status: 'SETTLED',
      settleTx: near ? '8tAHnxWBmrhXbLWrfjfSVBvvSDwPxXKbH5ZM4JNKTvBA' : `0x${'ab'.repeat(32)}`,
      amountOut: '1000000',
      settledAt: new Date(),
    });
    return createRow('HookCall', merchant.id, true, {
      sessionId: session.id,
      paymentId: payment.id,
      chain: near ? 'near' : 'base',
      targetContract: near ? 'game.near' : CONTRACT,
      hookData: { player: 'p-1' },
      ...over.hook,
    });
  }

  describe('assertHookTransaction (the records check)', () => {
    it('accepts exactly the call the records give', async () => {
      const h = await hookCall();
      const call = await expectedHookCall(h.id as string);
      expect(call.family).toBe('evm');
      await expect(
        assertHookTransaction({
          hookCallId: h.id as string,
          chain: 'base',
          to: CONTRACT,
          data: call.data!,
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses another target, another method, other arguments or a non-hook session', async () => {
      const h = await hookCall();
      const call = await expectedHookCall(h.id as string);
      const id = h.id as string;
      const other = encodeOnTendrDeposit({ ...call.args, amount: '999999999' });
      for (const p of [
        {
          hookCallId: id,
          chain: 'base',
          to: '0x000000000000000000000000000000000000dEaD',
          data: call.data!,
        },
        { hookCallId: id, chain: 'arb', to: CONTRACT, data: call.data! },
        { hookCallId: id, chain: 'base', to: CONTRACT, data: other },
        { hookCallId: id, chain: 'base', to: CONTRACT, data: '0xa9059cbb' },
        {
          hookCallId: 'hook_01J00000000000000000000000',
          chain: 'base',
          to: CONTRACT,
          data: call.data!,
        },
      ]) {
        await expect(assertHookTransaction(p)).rejects.toThrow(/hook/i);
      }
      // A hook row pointing somewhere other than where the session settled.
      const moved = await hookCall({
        hook: { targetContract: '0x000000000000000000000000000000000000dEaD' },
      });
      await expect(expectedHookCall(moved.id as string)).rejects.toThrow(/settlement contract/);
      // A session without hook delivery.
      const plain = await hookCall({ session: { delivery: 'WEBHOOK' } });
      await expect(expectedHookCall(plain.id as string)).rejects.toThrow(/hook/);
      // A store that is no longer an integrator.
      const h2 = await hookCall();
      await prisma.merchant.update({ where: { id: merchant.id }, data: { kind: 'merchant' } });
      await expect(expectedHookCall(h2.id as string)).rejects.toThrow(/integrator/);
    });
  });

  describe('relayer-evm (EvmSender)', () => {
    let redis: Redis;
    beforeAll(() => {
      redis = createRedis(env().REDIS_URL);
    });
    afterAll(async () => {
      await closeClient(redis);
    });

    function sender(node: FakeEvmNode) {
      return new EvmSender({
        kv,
        redis,
        rpc: (chain) => new EvmRpc(chain, 'http://rpc.test', node.fetch),
      });
    }

    it('signs the exact hook call to the session contract', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const node = new FakeEvmNode();
      const s = sender(node);
      await redis.del(`tendr:evm-nonce:base:${await s.address()}`);
      const h = await hookCall();
      const call = await expectedHookCall(h.id as string);
      const res = await s.send({
        chain: 'base',
        to: CONTRACT,
        data: call.data!,
        giveUpAt: new Date(Date.now() + 600_000),
        purpose: INTEGRATOR_HOOK_PURPOSE,
        refId: h.id as string,
      });
      expect(res.broadcast).toBe('submitted');
      expect(node.sent).toHaveLength(1);
    });

    it('refuses a hook call to anywhere else before any RPC call or signature', async () => {
      const node = new FakeEvmNode();
      const s = sender(node);
      const h = await hookCall();
      const call = await expectedHookCall(h.id as string);
      const sign = vi.spyOn(kv, 'sign');
      const err = await s
        .send({
          chain: 'base',
          to: '0x000000000000000000000000000000000000dEaD',
          data: call.data!,
          giveUpAt: new Date(Date.now() + 600_000),
          purpose: INTEGRATOR_HOOK_PURPOSE,
          refId: h.id as string,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EvmNotBroadcastError);
      expect((err as EvmNotBroadcastError).reason).toBe('rejected');
      expect(node.count('eth_estimateGas')).toBe(0);
      expect(sign).not.toHaveBeenCalled();
      expect(await prisma.relayerTransaction.count()).toBe(0);
      sign.mockRestore();
    });

    it('refuses onTendrDeposit under any other purpose', async () => {
      const node = new FakeEvmNode();
      const h = await hookCall();
      const call = await expectedHookCall(h.id as string);
      const err = await sender(node)
        .send({
          chain: 'base',
          to: CONTRACT,
          data: call.data!,
          giveUpAt: new Date(Date.now() + 600_000),
          purpose: 'gasless_payment',
          refId: 'gas_x',
        })
        .catch((e: unknown) => e);
      expect((err as EvmNotBroadcastError).reason).toBe('rejected');
      expect(node.count('eth_estimateGas')).toBe(0);
    });
  });

  describe('relayer-near', () => {
    const build = async (receiverId: string, actions: ReturnType<typeof functionCallAction>[]) => {
      const { raw } = await kv.publicKey('relayer-near');
      return buildTransaction({
        signerId: implicitAccountId(raw),
        publicKey: raw,
        nonce: 1n,
        receiverId,
        blockHash: new Uint8Array(32).fill(1),
        actions,
      });
    };
    const args = {
      payment_id: 'pay_1',
      session_id: 'ses_1',
      hook_data: '{}',
      token: 'usdt.tether-token.near',
      amount: '1',
      tx_hash: 'x',
    };
    const hook = (a: object = args, gas = NEAR_HOOK_ATTACHED_GAS, deposit = 0n) =>
      functionCallAction('on_tendr_deposit', a, gas, deposit);

    it('signs on_tendr_deposit only with the hook allowance for that receiver', async () => {
      const tx = await build('game.near', [hook()]);
      await expect(signTransaction(kv, 'relayer-near', tx)).rejects.toThrow(/relayer-near/);
      await expect(
        signTransaction(kv, 'relayer-near', tx, { hookReceiver: 'other.near' }),
      ).rejects.toThrow(/relayer-near/);
      await expect(
        signTransaction(kv, 'relayer-near', tx, { hookReceiver: 'game.near' }),
      ).resolves.toBeTruthy();
    });

    it('refuses deposits, extra gas, other args, other methods and batches even when allowed', async () => {
      const allow = { hookReceiver: 'game.near' };
      const bad = [
        await build('game.near', [hook(args, NEAR_HOOK_ATTACHED_GAS, 1n)]),
        await build('game.near', [hook(args, 301n * TGAS)]),
        await build('game.near', [hook({ ...args, extra: 1 })]),
        await build('game.near', [
          functionCallAction('ft_transfer', { receiver_id: 'x', amount: '1' }, TGAS, 1n),
        ]),
        await build('game.near', [hook(), hook()]),
      ];
      for (const tx of bad) {
        await expect(signTransaction(kv, 'relayer-near', tx, allow)).rejects.toThrow(
          /relayer-near/,
        );
      }
    });

    it('RelayerNearSender.signHook checks the records before the vault signs', async () => {
      const h = await hookCall({ near: true });
      const call = await expectedHookCall(h.id as string);
      const rpc = new NearRpc({
        request: async <T>(method: string): Promise<T> => {
          if (method === 'query') return { nonce: 5 } as T;
          if (method === 'block') {
            return { header: { hash: '11111111111111111111111111111111', height: 1 } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      });
      const s = new RelayerNearSender(rpc, kv);
      const sign = vi.spyOn(kv, 'sign');
      await expect(s.signHook(h.id as string, 'evil.near', call.args)).rejects.toThrow();
      await expect(
        s.signHook(h.id as string, 'game.near', { ...call.args, amount: '5' }),
      ).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
      const signed = await s.signHook(h.id as string, 'game.near', call.args);
      expect(signed.hash).toBeTruthy();
      expect(sign).toHaveBeenCalledTimes(1);
      sign.mockRestore();
    });
  });
});
