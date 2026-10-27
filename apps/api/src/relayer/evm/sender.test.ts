import { Transaction } from 'ethers';
import type { Redis } from 'ioredis';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../env.js';
import { evmAddress } from '../../keyvault/secp256k1.js';
import { LocalKeyVault } from '../../keyvault/local.js';
import { prisma } from '../../lib/prisma.js';
import { closeClient, createRedis } from '../../lib/redis.js';
import { FakeEvmNode, RpcRefusal } from '../../test/fake-evm-node.js';
import { resetDb } from '../../test/helpers.js';
import { EvmRpc } from './rpc.js';
import { EvmNotBroadcastError, EvmSender, REPLACE_AFTER_MS } from './sender.js';

const FORWARDER = '0x19bebc71495490a99ca6f50f107076967380cf09';
const DATA = '0xdeadbeef';

describe('EvmSender', () => {
  let redis: Redis;
  let kv: LocalKeyVault;
  let node: FakeEvmNode;
  let now: Date;
  let sender: EvmSender;
  let caps: Record<string, string | undefined>;

  beforeAll(() => {
    redis = createRedis(env().REDIS_URL);
  });
  afterAll(async () => {
    await closeClient(redis);
    await prisma.$disconnect();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    kv = new LocalKeyVault(join(mkdtempSync(join(tmpdir(), 'tendr-kv-')), 'keys.json'));
    node = new FakeEvmNode();
    now = new Date('2026-10-27T12:00:00Z');
    caps = {};
    sender = new EvmSender({
      kv,
      redis,
      rpc: (chain) => new EvmRpc(chain, 'http://rpc.test', node.fetch),
      now: () => now,
      maxFeeGwei: (chain) => caps[chain],
    });
    // An aborted earlier run must not leave the nonce lock held.
    await redis.del(`tendr:evm-nonce:base:${await sender.address()}`);
  });

  const input = (over: Partial<Parameters<EvmSender['send']>[0]> = {}) => ({
    chain: 'base',
    to: FORWARDER,
    data: DATA,
    giveUpAt: new Date(now.getTime() + 10 * 60_000),
    purpose: 'gasless_payment',
    refId: 'gas_test',
    ...over,
  });

  it('dry-runs, signs with relayer-evm (recovers to its address) and broadcasts once', async () => {
    node.pendingCount = 7n;
    const res = await sender.send(input());
    expect(res.broadcast).toBe('submitted');
    expect(node.count('eth_estimateGas')).toBe(1);
    expect(node.sent).toHaveLength(1);

    const tx = Transaction.from(node.sent[0]!);
    const { raw } = await kv.publicKey('relayer-evm');
    expect(tx.from!.toLowerCase()).toBe(evmAddress(raw));
    expect(tx.hash).toBe(res.txHash);
    expect(tx.chainId).toBe(8453n);
    expect(tx.nonce).toBe(7);
    expect(tx.to!.toLowerCase()).toBe(FORWARDER);
    expect(tx.data).toBe(DATA);
    expect(tx.type).toBe(2);
    // Gas limit: the estimate + 20 %; fees: 2 × base + tip.
    expect(tx.gasLimit).toBe(120_000n);
    expect(tx.maxPriorityFeePerGas).toBe(node.tip);
    expect(tx.maxFeePerGas).toBe(node.baseFee * 2n + node.tip);

    const row = await prisma.relayerTransaction.findUniqueOrThrow({ where: { id: res.txId } });
    expect(row.status).toBe('submitted');
    expect(row.nonce).toBe(7n);
    expect(row.txHashes).toEqual([res.txHash]);
    expect(row.fromAddress).toBe(evmAddress(raw));
    expect(row.broadcastAt).toEqual(now);
  });

  it('a dry run that reverts spends nothing and records nothing', async () => {
    node.once('eth_estimateGas', () => {
      throw new RpcRefusal(3, 'execution reverted: InvalidSignature()');
    });
    await expect(sender.send(input())).rejects.toMatchObject({
      name: 'EvmNotBroadcastError',
      reason: 'simulation_reverted',
    });
    expect(node.count('eth_sendRawTransaction')).toBe(0);
    expect(await prisma.relayerTransaction.count()).toBe(0);
  });

  it('never reuses a nonce while the node lags behind its own mempool', async () => {
    node.pendingCount = 3n;
    const a = await sender.send(input());
    // The node forgets the mempool (a lagging replica): pending count stays at 3.
    node.pendingCount = 3n;
    const b = await sender.send(input({ refId: 'gas_b' }));
    const rows = await prisma.relayerTransaction.findMany({ orderBy: { nonce: 'asc' } });
    expect(rows.map((r) => r.nonce)).toEqual([3n, 4n]);
    expect(rows.map((r) => r.id)).toEqual([a.txId, b.txId]);
  });

  it('concurrent sends on one chain get distinct nonces (Redis nonce lock)', async () => {
    const results = await Promise.all(
      [1, 2, 3].map((i) => sender.send(input({ refId: `gas_${i}` }))),
    );
    const rows = await prisma.relayerTransaction.findMany();
    expect(new Set(rows.map((r) => r.nonce)).size).toBe(3);
    expect(new Set(results.map((r) => r.txHash)).size).toBe(3);
  });

  it('a sender whose nonce lock lapsed on a slow RPC never shares a nonce with another', async () => {
    const slow = new EvmSender({
      kv,
      redis,
      rpc: (chain) => new EvmRpc(chain, 'http://rpc.test', node.fetch),
      now: () => now,
      maxFeeGwei: () => undefined,
      nonceLockTtlMs: 300,
    });
    // A reads the nonce (0) at once but gets the answer after its 300 ms lock lapsed.
    node.delays.set('eth_getTransactionCount', [600]);
    const a = slow.send(input({ refId: 'gas_a' })).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 350));
    // B takes the lapsed lock and sends nonce 0 while A is still waiting.
    const b = await slow.send(input({ refId: 'gas_b' }));
    const errA = await a;
    expect(errA).toBeInstanceOf(EvmNotBroadcastError);
    expect((errA as EvmNotBroadcastError).reason).toBe('unavailable');
    const rows = await prisma.relayerTransaction.findMany();
    expect(rows.map((r) => [r.refId, r.nonce])).toEqual([['gas_b', 0n]]);
    expect(node.sent).toHaveLength(1);
    expect(Transaction.from(node.sent[0]!).hash).toBe(b.txHash);
  });

  it('the database refuses a second in-flight transaction at the same nonce', async () => {
    await sender.send(input());
    const row = await prisma.relayerTransaction.findFirstOrThrow();
    const { id: _id, createdAt: _c, updatedAt: _u, receiptLogs: _l, ...rest } = row;
    await expect(
      prisma.relayerTransaction.create({ data: { ...rest, id: 'rtx_dup', txHash: '0xdup' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // A failed row frees the nonce.
    await prisma.relayerTransaction.update({ where: { id: row.id }, data: { status: 'failed' } });
    await prisma.relayerTransaction.create({ data: { ...rest, id: 'rtx_dup', txHash: '0xdup' } });
  });

  it('a KMS or database failure before the broadcast is not broadcast (retryable), and records nothing', async () => {
    vi.spyOn(kv, 'sign').mockRejectedValueOnce(new Error('KMS unavailable'));
    await expect(sender.send(input())).rejects.toMatchObject({
      name: 'EvmNotBroadcastError',
      reason: 'unavailable',
    });
    expect(await prisma.relayerTransaction.count()).toBe(0);

    // The row insert fails (an invalid value the database refuses).
    await expect(sender.send(input({ giveUpAt: new Date(Number.NaN) }))).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(await prisma.relayerTransaction.count()).toBe(0);
    expect(node.sent).toHaveLength(0);

    // Nothing is stuck: the next send goes through.
    expect((await sender.send(input())).broadcast).toBe('submitted');
  });

  it('refuses a fee above EVM_MAX_FEE_GWEI_<CHAIN> and caps fees below it', async () => {
    caps.base = '0.5'; // base fee is 1 gwei: above the cap
    await expect(sender.send(input())).rejects.toMatchObject({ reason: 'fee_cap' });
    expect(node.sent).toHaveLength(0);

    caps.base = '1.5'; // 2 × 1 + 0.1 = 2.1 gwei asked → capped at 1.5, tip ≤ 0.5
    await sender.send(input());
    const tx = Transaction.from(node.sent[0]!);
    expect(tx.maxFeePerGas).toBe(1_500_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(100_000_000n);
  });

  it('a node refusal (e.g. no gas money) marks the row failed and reports not broadcast', async () => {
    node.once('eth_sendRawTransaction', () => {
      throw new RpcRefusal(-32000, 'insufficient funds for gas * price + value');
    });
    const err = await sender.send(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvmNotBroadcastError);
    expect((err as EvmNotBroadcastError).reason).toBe('rejected');
    const row = await prisma.relayerTransaction.findFirstOrThrow();
    expect(row.status).toBe('failed');
  });

  it('unknown outcome: checks the hash, then re-sends the identical bytes (never a new nonce)', async () => {
    node.once('eth_sendRawTransaction', () => {
      throw new Error('socket hang up');
    });
    const res = await sender.send(input());
    expect(res.broadcast).toBe('submitted');
    expect(node.count('eth_getTransactionByHash')).toBe(1);
    const sends = node.calls.filter((c) => c.method === 'eth_sendRawTransaction');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.params[0]).toBe(sends[1]!.params[0]);
    expect(await prisma.relayerTransaction.count()).toBe(1);
  });

  it('a timeout the node did process is not re-sent', async () => {
    node.once('eth_sendRawTransaction', (params) => {
      // The node accepted it, but the answer never arrived.
      const tx = Transaction.from(String(params[0]));
      node.known.add(tx.hash!);
      node.sent.push(String(params[0]));
      throw new Error('timeout');
    });
    const res = await sender.send(input());
    expect(res.broadcast).toBe('submitted');
    expect(node.count('eth_sendRawTransaction')).toBe(1);
  });

  it('no answer twice: recorded as in flight, and the poller re-sends the same bytes', async () => {
    node.once('eth_sendRawTransaction', () => {
      throw new Error('ECONNRESET');
    });
    node.once('eth_getTransactionByHash', () => {
      throw new Error('ECONNRESET');
    });
    const res = await sender.send(input());
    expect(res.broadcast).toBe('unknown');
    let row = await prisma.relayerTransaction.findFirstOrThrow();
    expect(row.status).toBe('submitted');
    expect(node.sent).toHaveLength(0);

    await sender.tick();
    expect(node.sent).toHaveLength(1);
    expect(Transaction.from(node.sent[0]!).hash).toBe(res.txHash);
    row = await prisma.relayerTransaction.findFirstOrThrow();
    expect(row.txHashes).toEqual([res.txHash]);
  });

  it('a stuck transaction is replaced after 60 s: same nonce, fees +15 %', async () => {
    node.pendingCount = 9n;
    const res = await sender.send(input());
    now = new Date(now.getTime() + REPLACE_AFTER_MS - 1000);
    await sender.tick();
    expect(node.sent).toHaveLength(1); // not yet

    now = new Date(now.getTime() + 2000);
    await sender.tick();
    expect(node.sent).toHaveLength(2);
    const first = Transaction.from(node.sent[0]!);
    const second = Transaction.from(node.sent[1]!);
    expect(second.nonce).toBe(9);
    expect(second.nonce).toBe(first.nonce);
    expect(second.data).toBe(first.data);
    expect(second.to).toBe(first.to);
    expect(second.maxPriorityFeePerGas).toBe((first.maxPriorityFeePerGas! * 115n + 99n) / 100n);
    expect(second.maxFeePerGas).toBe((first.maxFeePerGas! * 115n + 99n) / 100n);
    const row = await prisma.relayerTransaction.findUniqueOrThrow({ where: { id: res.txId } });
    expect(row.txHashes).toEqual([res.txHash, second.hash]);
    expect(row.attempts).toBe(2);
  });

  it('confirms when any broadcast hash is mined, and hands the outcome over once', async () => {
    const res = await sender.send(input());
    now = new Date(now.getTime() + REPLACE_AFTER_MS + 1000);
    await sender.tick(); // replaced
    node.mine(res.txHash); // …but the original was mined
    const outcomes = await sender.tick();
    expect(outcomes).toEqual([
      expect.objectContaining({
        txId: res.txId,
        status: 'confirmed',
        txHash: res.txHash,
        gasUsed: 80_000n,
        purpose: 'gasless_payment',
        refId: 'gas_test',
      }),
    ]);
    await sender.markHandled(res.txId);
    expect(await sender.tick()).toEqual([]);
  });

  it('a reverted transaction is failed', async () => {
    const res = await sender.send(input());
    node.mine(res.txHash, 0);
    const [o] = await sender.tick();
    expect(o).toMatchObject({ status: 'failed', reason: 'reverted on chain' });
  });

  it('past the deadline the nonce is freed with a 0-value self-transfer, then failed', async () => {
    const res = await sender.send(input({ giveUpAt: new Date(now.getTime() + 30_000) }));
    now = new Date(now.getTime() + 31_000);
    await sender.tick();
    expect(node.sent).toHaveLength(2);
    const cancel = Transaction.from(node.sent[1]!);
    const from = await sender.address();
    expect(cancel.to!.toLowerCase()).toBe(from);
    expect(cancel.value).toBe(0n);
    expect(cancel.data).toBe('0x');
    expect(cancel.nonce).toBe(Transaction.from(node.sent[0]!).nonce);
    node.mine(cancel.hash!);
    const [o] = await sender.tick();
    expect(o).toMatchObject({ txId: res.txId, status: 'failed', txHash: cancel.hash });
  });
});
