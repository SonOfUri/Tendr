// The EVM transaction sender (project 5a, spec §3.1–3.2): builds, KMS-signs (`relayer-evm`) and
// broadcasts EIP-1559 transactions, and sees each one through to a final outcome. Live mode only.
//
// Guarantees, mirroring the NEAR sender (near/client.ts `signAndSend`):
//   - Nonces: one sender per (chain, address) at a time, under a Redis lock. The next nonce is
//     max(the node's pending count, the highest nonce still in flight in `relayer_transactions`
//     + 1), so a lagging node never makes two transactions share a nonce.
//   - Dry run first: `eth_estimateGas` refuses a call that would revert (a bad signature, a used
//     authorization, an empty balance) before any gas is spent.
//   - Recorded before sent: the row (nonce, raw transaction, hash) is written before the
//     broadcast, so a crash or timeout leaves a record to reconcile.
//   - Unknown outcome: a broadcast that gets no answer is checked by hash and, when the node does
//     not know it, re-sent as the identical signed bytes (same hash: it can execute at most
//     once). It is never re-signed under another nonce. The poller (`tick`) keeps reconciling:
//     a receipt, the account nonce, then the hash.
//   - Stuck: unmined after REPLACE_AFTER_MS, the same nonce is re-signed with fees raised by
//     REPLACEMENT_BUMP_PCT (within EVM_MAX_FEE_GWEI_<CHAIN>).
//   - Give up: past `giveUpAt` (the quote deadline: the signed payload can only revert by then)
//     a 0-value self-transfer at the same nonce frees it, and the transaction ends `failed`.
//
// The sender is generic (gasless payments and integrator hooks): each row names its `purpose` and
// `refId`, and `tick` returns final outcomes for the caller to apply. A hook call (`purpose`
// integrator_hook) is signed only after the records check (hooks/guard.ts).
import type { Prisma } from '@prisma/client';
import { Signature, Transaction, getBytes, hexlify, parseUnits } from 'ethers';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { env } from '../../env.js';
import { evmAddress } from '../../keyvault/secp256k1.js';
import type { KeyVault } from '../../keyvault/types.js';
import { newId } from '../../lib/ids.js';
import { log } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  INTEGRATOR_HOOK_PURPOSE,
  assertHookTransaction,
  isOnTendrDepositCall,
} from '../../hooks/guard.js';
import { EvmRpc, EvmRpcError, EvmTransportError } from './rpc.js';
import { EVM_CHAIN_IDS } from './tokens.js';

/** Unmined this long after its last broadcast → replaced with higher fees, same nonce. */
export const REPLACE_AFTER_MS = 60_000;
/** Fee increase per replacement, percent (nodes require ≥ 10 %). */
export const REPLACEMENT_BUMP_PCT = 15n;
/** Gas limit = the estimate × this / 100. */
export const GAS_LIMIT_BUFFER_PCT = 120n;
/**
 * How long the per-chain nonce lock is held at most (above the worst-case send: four 10 s RPC
 * calls, KMS and the insert; it is renewed, token-checked, right before the row is written), and
 * how long a sender waits for it.
 */
export const NONCE_LOCK_TTL_MS = 120_000;
export const NONCE_LOCK_WAIT_MS = 15_000;
/** A row the poller is working on is leased for this long. */
export const POLL_LEASE_MS = 30_000;
/** A nonce used by a transaction we hold no receipt for: failed once this long past give-up. */
export const UNKNOWN_NONCE_GRACE_MS = 10 * 60_000;
const CANCEL_GAS = 21_000n;
/** `last_error` of a transaction mined with receipt status 0. */
export const EVM_REVERTED_ON_CHAIN = 'reverted on chain';

/** Nothing reached the chain: the dry run reverted, the node refused, or a step before failed. */
export class EvmNotBroadcastError extends Error {
  constructor(
    message: string,
    readonly reason:
      'simulation_reverted' | 'fee_cap' | 'gas_cap' | 'gas_budget' | 'rejected' | 'unavailable',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EvmNotBroadcastError';
  }
}

export interface EvmSendInput {
  /** 1Click EVM chain id (`base`, `arb`, …). */
  chain: string;
  to: string;
  data: string;
  /** After this, the transaction is not worth mining: its nonce is freed. */
  giveUpAt: Date;
  purpose: string;
  refId: string;
  /**
   * Gas limit ceiling: the limit is min(estimate × GAS_LIMIT_BUFFER_PCT, this); an estimate above
   * it is refused (`gas_cap`), nothing sent. Integrator hooks set it (the contract is not ours).
   */
  maxGasLimit?: bigint;
  /**
   * Refused (`gas_budget`) when gas limit × the current gas price (base fee + tip) is above this:
   * a price spike, worth retrying (unlike `gas_cap`, an estimate above the ceiling).
   */
  maxCostWei?: bigint;
}

export interface EvmSendResult {
  /** `relayer_transactions.id`. */
  txId: string;
  txHash: string;
  /** `submitted`: the node accepted it; `unknown`: no answer (the poller reconciles). */
  broadcast: 'submitted' | 'unknown';
}

export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

export interface EvmOutcome {
  txId: string;
  purpose: string;
  refId: string;
  chain: string;
  status: 'confirmed' | 'failed';
  /** The mined hash (null when the nonce went to a transaction we hold no receipt for). */
  txHash: string | null;
  gasUsed: bigint | null;
  effectiveGasPrice: bigint | null;
  /** OP-stack chains: the receipt's L1 data fee (wei), charged on top of gas; else null. */
  l1Fee?: bigint | null;
  reason: string | null;
  /** The mined receipt's logs (lower-case emitter address); [] when none. */
  logs: ReceiptLog[];
}

export interface EvmSenderDeps {
  kv: KeyVault;
  redis: Redis;
  rpc?: (chain: string) => EvmRpc;
  now?: () => Date;
  /** `EVM_MAX_FEE_GWEI_<CHAIN>` (gwei decimal) or undefined. */
  maxFeeGwei?: (chain: string) => string | undefined;
  /** Nonce lock TTL (tests); NONCE_LOCK_TTL_MS by default. */
  nonceLockTtlMs?: number;
}

type Row = Prisma.RelayerTransactionGetPayload<object>;

const bump = (x: bigint) => (x * (100n + REPLACEMENT_BUMP_PCT) + 99n) / 100n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** The configured `EVM_MAX_FEE_GWEI_<CHAIN>`. */
export function envMaxFeeGwei(chain: string): string | undefined {
  const key = `EVM_MAX_FEE_GWEI_${chain.toUpperCase()}`;
  return (env() as unknown as Record<string, string | undefined>)[key];
}

/** Errors that mean the node already has this exact transaction. */
const ALREADY_KNOWN = /already known|known transaction|already imported|alreadyknown/i;

export class EvmSender {
  private readonly rpcFor: (chain: string) => EvmRpc;
  private readonly now: () => Date;
  private readonly maxFeeGwei: (chain: string) => string | undefined;
  private from: string | null = null;

  constructor(private readonly deps: EvmSenderDeps) {
    this.rpcFor = deps.rpc ?? ((chain) => EvmRpc.forChain(chain));
    this.now = deps.now ?? (() => new Date());
    this.maxFeeGwei = deps.maxFeeGwei ?? envMaxFeeGwei;
  }

  /** The JSON-RPC client the sender uses for `chain` (read-only checks before a relay). */
  rpc(chain: string): EvmRpc {
    return this.rpcFor(chain);
  }

  /** The `relayer-evm` address (lower-case), from the KMS public key. */
  async address(): Promise<string> {
    if (this.from) return this.from;
    const { curve, raw } = await this.deps.kv.publicKey('relayer-evm');
    if (curve !== 'secp256k1') throw new Error('relayer-evm is not a secp256k1 key');
    this.from = evmAddress(raw);
    return this.from;
  }

  /**
   * Signs and broadcasts one transaction. Throws EvmNotBroadcastError when nothing reached the
   * chain (the caller may release what it reserved). Any other result has a recorded row the
   * poller sees through to an outcome.
   */
  async send(input: EvmSendInput): Promise<EvmSendResult> {
    const chainId = EVM_CHAIN_IDS[input.chain];
    if (!chainId) throw new EvmNotBroadcastError(`not an EVM chain: ${input.chain}`, 'rejected');
    // Integrator hooks (ruling T11-b): `onTendrDeposit` only as a hook, and a hook only exactly as
    // Tendr's records give it (the session's settlement contract, the payment's own arguments).
    if (input.purpose === INTEGRATOR_HOOK_PURPOSE) {
      try {
        await assertHookTransaction({
          hookCallId: input.refId,
          chain: input.chain,
          to: input.to,
          data: input.data,
        });
      } catch (err) {
        throw new EvmNotBroadcastError(
          err instanceof Error ? err.message : 'hook call refused',
          'rejected',
          err,
        );
      }
    } else if (isOnTendrDepositCall(input.data)) {
      throw new EvmNotBroadcastError(
        'onTendrDeposit is sent only as an integrator hook',
        'rejected',
      );
    }
    let from: string;
    let rpc: EvmRpc;
    try {
      from = await this.address();
      rpc = this.rpcFor(input.chain);
    } catch (err) {
      throw new EvmNotBroadcastError('the relayer is unavailable', 'unavailable', err);
    }
    const lock = await this.lockNonce(input.chain, from);
    try {
      const prepared = await this.prepare(rpc, input, from);
      // Everything up to the first broadcast: nothing has reached the chain, so any failure (KMS,
      // the database, a lost nonce lock) is EvmNotBroadcastError and the caller may retry.
      let row: Row;
      try {
        const signed = await this.sign({
          chainId,
          nonce: prepared.nonce,
          to: input.to,
          data: input.data,
          gasLimit: prepared.gasLimit,
          maxFeePerGas: prepared.maxFee,
          maxPriorityFeePerGas: prepared.tip,
        });
        // The nonce becomes visible to other senders with this row: the lock must still be ours.
        if (!(await lock.renew()))
          throw new Error('the nonce lock expired before the row was written');
        row = await prisma.relayerTransaction.create({
          data: {
            id: newId('rtx'),
            chain: input.chain,
            chainId,
            fromAddress: from,
            nonce: prepared.nonce,
            toAddress: input.to.toLowerCase(),
            data: input.data,
            gasLimit: prepared.gasLimit.toString(),
            maxFeePerGas: prepared.maxFee.toString(),
            maxPriorityFeePerGas: prepared.tip.toString(),
            rawTx: signed.raw,
            txHash: signed.hash,
            txHashes: [signed.hash],
            status: 'pending',
            purpose: input.purpose,
            refId: input.refId,
            giveUpAt: input.giveUpAt,
            attempts: 1,
          },
        });
      } catch (err) {
        // Includes the in-flight nonce unique index (a sender that lost the lock).
        throw new EvmNotBroadcastError('the relayer is unavailable', 'unavailable', err);
      }
      const broadcast = await this.broadcastNew(rpc, row);
      return { txId: row.id, txHash: row.txHash, broadcast };
    } finally {
      await lock.release();
    }
  }

  /** Gas, fees and nonce for a new transaction (under the nonce lock). */
  private async prepare(rpc: EvmRpc, input: EvmSendInput, from: string) {
    let gas: bigint;
    try {
      gas = await rpc.estimateGas({ from, to: input.to, data: input.data });
    } catch (err) {
      if (err instanceof EvmRpcError) {
        throw new EvmNotBroadcastError(
          `dry run reverted: ${err.message}`,
          'simulation_reverted',
          err,
        );
      }
      throw new EvmNotBroadcastError('the chain is unavailable', 'unavailable', err);
    }
    try {
      const [base, tipAsked, pending, inFlight] = await Promise.all([
        rpc.baseFeePerGas(),
        rpc.maxPriorityFeePerGas(),
        rpc.transactionCount(from, 'pending'),
        prisma.relayerTransaction.aggregate({
          where: {
            chain: input.chain,
            fromAddress: from,
            status: { in: ['pending', 'submitted'] },
          },
          _max: { nonce: true },
        }),
      ]);
      const cap = this.capWei(input.chain);
      let tip = tipAsked;
      let maxFee = base * 2n + tip;
      if (cap !== null && maxFee > cap) {
        if (cap <= base) {
          throw new EvmNotBroadcastError(
            `the network fee is above EVM_MAX_FEE_GWEI_${input.chain.toUpperCase()}`,
            'fee_cap',
          );
        }
        maxFee = cap;
        tip = min(tip, cap - base);
      }
      const dbNext = inFlight._max.nonce === null ? 0n : inFlight._max.nonce + 1n;
      let gasLimit = (gas * GAS_LIMIT_BUFFER_PCT + 99n) / 100n;
      if (input.maxGasLimit !== undefined) {
        if (gas > input.maxGasLimit) {
          throw new EvmNotBroadcastError(
            `the call needs ${gas} gas, above the ${input.maxGasLimit} gas ceiling`,
            'gas_cap',
          );
        }
        gasLimit = min(gasLimit, input.maxGasLimit);
      }
      if (input.maxCostWei !== undefined && gasLimit * (base + tip) > input.maxCostWei) {
        throw new EvmNotBroadcastError(
          `the call may cost ${gasLimit * (base + tip)} wei (${gasLimit} gas), above its ${input.maxCostWei} wei budget`,
          'gas_budget',
        );
      }
      return { gasLimit, maxFee, tip, nonce: max(pending, dbNext) };
    } catch (err) {
      if (err instanceof EvmNotBroadcastError) throw err;
      throw new EvmNotBroadcastError('the chain is unavailable', 'unavailable', err);
    }
  }

  private capWei(chain: string): bigint | null {
    const gwei = this.maxFeeGwei(chain);
    return gwei === undefined ? null : parseUnits(gwei, 'gwei');
  }

  /** Builds the EIP-1559 transaction and signs its hash with `relayer-evm` in the key vault. */
  async sign(tx: {
    chainId: number;
    nonce: bigint;
    to: string;
    data: string;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): Promise<{ raw: string; hash: string }> {
    const t = Transaction.from({
      type: 2,
      chainId: BigInt(tx.chainId),
      nonce: Number(tx.nonce),
      to: tx.to,
      data: tx.data,
      value: 0n,
      gasLimit: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    });
    const sig = await this.deps.kv.sign('relayer-evm', getBytes(t.unsignedHash));
    if (sig.curve !== 'secp256k1') throw new Error('relayer-evm signature is not secp256k1');
    t.signature = Signature.from({ r: hexlify(sig.r), s: hexlify(sig.s), v: 27 + sig.v });
    // Never broadcast a transaction that does not come from the relayer's own address.
    if (t.from?.toLowerCase() !== (await this.address())) {
      throw new Error('relayer-evm signature does not recover to the relayer address');
    }
    return { raw: t.serialized, hash: t.hash! };
  }

  /** First broadcast of a freshly recorded row. */
  private async broadcastNew(rpc: EvmRpc, row: Row): Promise<'submitted' | 'unknown'> {
    const submitted = async () => {
      await prisma.relayerTransaction.update({
        where: { id: row.id },
        data: { status: 'submitted', broadcastAt: this.now() },
      });
      return 'submitted' as const;
    };
    try {
      await rpc.sendRawTransaction(row.rawTx);
      return await submitted();
    } catch (err) {
      if (err instanceof EvmRpcError) {
        if (ALREADY_KNOWN.test(err.message)) return submitted();
        // The node refused the transaction itself: nothing is in flight at this nonce.
        await prisma.relayerTransaction.update({
          where: { id: row.id },
          // Never broadcast: nothing for the poller to report (the caller already knows), so the
          // row is handed over at once and cannot touch a later retry.
          data: {
            status: 'failed',
            lastError: err.message.slice(0, 500),
            outcomeHandledAt: this.now(),
          },
        });
        throw new EvmNotBroadcastError(
          `the node refused the transaction: ${err.message}`,
          'rejected',
          err,
        );
      }
      // No answer: the outcome is unknown. Check by hash, then re-send the identical bytes once.
      log('warn', 'evm relayer: broadcast outcome unknown', { txId: row.id, err: String(err) });
      try {
        if (await rpc.hasTransaction(row.txHash)) return await submitted();
        await rpc.sendRawTransaction(row.rawTx);
        return await submitted();
      } catch (again) {
        if (again instanceof EvmRpcError && ALREADY_KNOWN.test(again.message)) return submitted();
        await prisma.relayerTransaction.update({
          where: { id: row.id },
          data: {
            status: 'submitted',
            broadcastAt: this.now(),
            lastError: `outcome unknown: ${String(again)}`.slice(0, 500),
          },
        });
        return 'unknown';
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------------------------

  /**
   * One pass over the transactions in flight: receipts, replacements, give-ups and rebroadcasts
   * of unknown outcomes. Returns every final outcome not yet handed over (`markHandled`).
   */
  async tick(limit = 50): Promise<EvmOutcome[]> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + POLL_LEASE_MS);
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE relayer_transactions SET lease_until = ${leaseUntil}
      WHERE id IN (
        SELECT id FROM relayer_transactions
        WHERE status IN ('pending', 'submitted') AND (lease_until IS NULL OR lease_until < ${now})
        ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    for (const { id } of claimed) {
      try {
        await this.advance(id);
      } catch (err) {
        log('warn', 'evm relayer: poll failed', { txId: id, err: String(err) });
      } finally {
        await prisma.relayerTransaction.update({ where: { id }, data: { leaseUntil: null } });
      }
    }
    const done = await prisma.relayerTransaction.findMany({
      where: { status: { in: ['confirmed', 'failed'] }, outcomeHandledAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return done.map(outcomeOf);
  }

  /** Marks a final outcome as applied by its owner. */
  async markHandled(txId: string): Promise<void> {
    await prisma.relayerTransaction.update({
      where: { id: txId },
      data: { outcomeHandledAt: this.now() },
    });
  }

  private async advance(id: string): Promise<void> {
    const row = await prisma.relayerTransaction.findUniqueOrThrow({ where: { id } });
    const rpc = this.rpcFor(row.chain);
    const now = this.now();
    // 1. A receipt for any hash we broadcast at this nonce (newest first).
    for (const hash of [...row.txHashes].reverse()) {
      const r = await rpc.receipt(hash);
      if (!r) continue;
      const cancelled = row.cancelTxHash !== null && hash === row.cancelTxHash;
      await prisma.relayerTransaction.update({
        where: { id },
        data: {
          status: r.status === 1 && !cancelled ? 'confirmed' : 'failed',
          minedHash: hash,
          txHash: hash,
          gasUsed: r.gasUsed.toString(),
          effectiveGasPrice: r.effectiveGasPrice.toString(),
          l1Fee: r.l1Fee === null ? null : r.l1Fee.toString(),
          // Every log of the receipt (the forwarder's events and the token transfers it caused).
          receiptLogs: r.logs.map((l) => ({
            address: l.address.toLowerCase(),
            topics: l.topics,
            data: l.data,
          })),
          lastError: cancelled
            ? 'gave up after the deadline (nonce freed)'
            : r.status === 1
              ? null
              : EVM_REVERTED_ON_CHAIN,
        },
      });
      return;
    }
    // 2. The nonce was used, but by no hash we know a receipt for (yet).
    const mined = await rpc.transactionCount(row.fromAddress, 'latest');
    if (mined > row.nonce) {
      if (now.getTime() > row.giveUpAt.getTime() + UNKNOWN_NONCE_GRACE_MS) {
        await prisma.relayerTransaction.update({
          where: { id },
          data: { status: 'failed', lastError: 'nonce used by a transaction with no receipt' },
        });
      }
      return;
    }
    // 3. Past the deadline: free the nonce with a 0-value self-transfer (once).
    if (now.getTime() > row.giveUpAt.getTime() && row.cancelTxHash === null) {
      await this.cancel(rpc, row);
      return;
    }
    // 4. Unknown outcome or dropped: the node does not know the latest hash → re-send the same bytes.
    const known = await rpc.hasTransaction(row.txHash);
    if (!known) {
      await this.rebroadcast(rpc, row);
      return;
    }
    // 5. Stuck: replace with higher fees at the same nonce (the payment, never a cancel).
    const since = row.broadcastAt?.getTime() ?? row.createdAt.getTime();
    if (row.cancelTxHash === null && now.getTime() - since >= REPLACE_AFTER_MS) {
      await this.replace(rpc, row);
    }
  }

  private async rebroadcast(rpc: EvmRpc, row: Row): Promise<void> {
    try {
      await rpc.sendRawTransaction(row.rawTx);
    } catch (err) {
      if (!(err instanceof EvmRpcError && ALREADY_KNOWN.test(err.message))) {
        log('warn', 'evm relayer: rebroadcast failed', { txId: row.id, err: String(err) });
        return;
      }
    }
    await prisma.relayerTransaction.update({
      where: { id: row.id },
      data: { status: 'submitted', broadcastAt: row.broadcastAt ?? this.now() },
    });
  }

  /** Fees raised by REPLACEMENT_BUMP_PCT, within the cap; null when the cap allows no raise. */
  private bumped(row: Row): { maxFee: bigint; tip: bigint } | null {
    const oldMax = BigInt(row.maxFeePerGas.toFixed(0));
    const oldTip = BigInt(row.maxPriorityFeePerGas.toFixed(0));
    let maxFee = bump(oldMax);
    let tip = bump(oldTip);
    const cap = this.capWei(row.chain);
    if (cap !== null) {
      maxFee = min(maxFee, cap);
      tip = min(tip, maxFee);
    }
    // Nodes refuse a replacement that does not raise both by ≥ 10 %.
    if (maxFee * 100n < oldMax * 110n || tip * 100n < oldTip * 110n) return null;
    return { maxFee, tip };
  }

  private async replace(rpc: EvmRpc, row: Row): Promise<void> {
    const fees = this.bumped(row);
    if (!fees) {
      // Capped: keep the transaction in the mempool as it is.
      await this.rebroadcast(rpc, row);
      return;
    }
    const signed = await this.sign({
      chainId: row.chainId,
      nonce: row.nonce,
      to: row.toAddress,
      data: row.data,
      gasLimit: BigInt(row.gasLimit.toFixed(0)),
      maxFeePerGas: fees.maxFee,
      maxPriorityFeePerGas: fees.tip,
    });
    await this.recordBroadcast(rpc, row, signed, fees, false);
  }

  private async cancel(rpc: EvmRpc, row: Row): Promise<void> {
    const oldMax = BigInt(row.maxFeePerGas.toFixed(0));
    const oldTip = BigInt(row.maxPriorityFeePerGas.toFixed(0));
    // A cancel must outbid the transaction it replaces; it is cheap (21 000 gas), so no cap.
    const fees = { maxFee: bump(oldMax), tip: bump(oldTip) };
    const signed = await this.sign({
      chainId: row.chainId,
      nonce: row.nonce,
      to: row.fromAddress,
      data: '0x',
      gasLimit: CANCEL_GAS,
      maxFeePerGas: fees.maxFee,
      maxPriorityFeePerGas: fees.tip,
    });
    await this.recordBroadcast(rpc, row, signed, fees, true);
  }

  /** Records a replacement (or the cancel) before broadcasting it. */
  private async recordBroadcast(
    rpc: EvmRpc,
    row: Row,
    signed: { raw: string; hash: string },
    fees: { maxFee: bigint; tip: bigint },
    cancel: boolean,
  ): Promise<void> {
    await prisma.relayerTransaction.update({
      where: { id: row.id },
      data: {
        rawTx: signed.raw,
        txHash: signed.hash,
        txHashes: { push: signed.hash },
        maxFeePerGas: fees.maxFee.toString(),
        maxPriorityFeePerGas: fees.tip.toString(),
        attempts: { increment: 1 },
        broadcastAt: this.now(),
        status: 'submitted',
        ...(cancel ? { cancelTxHash: signed.hash } : {}),
      },
    });
    try {
      await rpc.sendRawTransaction(signed.raw);
    } catch (err) {
      // Recorded either way: the next tick checks receipts for every hash and re-sends this one.
      log('warn', 'evm relayer: replacement broadcast failed', {
        txId: row.id,
        cancel,
        err: String(err),
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Nonce lock
  // -------------------------------------------------------------------------------------------

  /**
   * Takes the (chain, address) nonce lock. `renew()` extends it only while this sender still
   * holds it (token-checked) and returns false once it was lost; `release()` frees it if still
   * ours. Fails closed.
   */
  private async lockNonce(
    chain: string,
    from: string,
  ): Promise<{ renew: () => Promise<boolean>; release: () => Promise<void> }> {
    const key = `tendr:evm-nonce:${chain}:${from}`;
    const token = randomUUID();
    const ttl = this.deps.nonceLockTtlMs ?? NONCE_LOCK_TTL_MS;
    const deadline = Date.now() + NONCE_LOCK_WAIT_MS;
    for (;;) {
      let ok: string | null;
      try {
        ok = await this.deps.redis.set(key, token, 'PX', ttl, 'NX');
      } catch (err) {
        throw new EvmNotBroadcastError('the relayer is unavailable', 'unavailable', err);
      }
      if (ok === 'OK') break;
      if (Date.now() > deadline) {
        throw new EvmNotBroadcastError('the relayer is busy; try again', 'unavailable');
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return {
      renew: async () =>
        Number(
          await this.deps.redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
            1,
            key,
            token,
            String(ttl),
          ),
        ) === 1,
      release: async () => {
        try {
          await this.deps.redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            key,
            token,
          );
        } catch (err) {
          log('warn', 'evm relayer: nonce lock release failed', { key, err: String(err) });
        }
      },
    };
  }
}

function outcomeOf(r: Row): EvmOutcome {
  return {
    txId: r.id,
    purpose: r.purpose,
    refId: r.refId,
    chain: r.chain,
    status: r.status === 'confirmed' ? 'confirmed' : 'failed',
    txHash: r.minedHash,
    gasUsed: r.gasUsed ? BigInt(r.gasUsed.toFixed(0)) : null,
    effectiveGasPrice: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice.toFixed(0)) : null,
    l1Fee: r.l1Fee ? BigInt(r.l1Fee.toFixed(0)) : null,
    reason: r.lastError,
    logs: Array.isArray(r.receiptLogs) ? (r.receiptLogs as unknown as ReceiptLog[]) : [],
  };
}

export { EvmRpcError, EvmTransportError };
