// Test double: an EVM JSON-RPC node behind a `fetch`, answering from scripted state with the
// responses a real node returns (recorded shapes: hex quantities, null for unknown hashes,
// `{ error: { code, message } }` for refusals). Used by the sender and relayer tests (ruling P2: no
// Docker in the default suite).
import { Transaction } from 'ethers';
import type { FetchLike } from '../checkout/senders/index.js';

export interface FakeReceipt {
  status: 0 | 1;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: { address: string; topics: string[]; data: string }[];
  /** OP-stack L1 data fee (wei), reported as `l1Fee` when set. */
  l1Fee?: bigint;
}

type Handler = (params: unknown[]) => unknown;

export class FakeEvmNode {
  /** Account nonces: mined (`latest`) and including the mempool (`pending`). */
  latestCount = 0n;
  pendingCount = 0n;
  baseFee = 1_000_000_000n; // 1 gwei
  tip = 100_000_000n; // 0.1 gwei
  gasEstimate = 100_000n;
  /** Raw transactions the node accepted, in order. */
  readonly sent: string[] = [];
  /** Hashes in the mempool or mined. */
  readonly known = new Set<string>();
  readonly receipts = new Map<string, FakeReceipt>();
  /** Every JSON-RPC call, in order. */
  readonly calls: { method: string; params: unknown[] }[] = [];
  /** Per-method overrides; a handler that throws makes the HTTP request fail (transport). */
  readonly overrides = new Map<string, Handler[]>();
  /** Answers `eth_call` (`to`, `data`) → hex. */
  ethCall: (to: string, data: string) => string = () => '0x' + '0'.repeat(64);

  /** Per-method delays (ms) for the next calls: the answer is computed, then held back. */
  readonly delays = new Map<string, number[]>();

  /** Queues one override for the next call of `method`. */
  once(method: string, handler: Handler): void {
    const list = this.overrides.get(method) ?? [];
    list.push(handler);
    this.overrides.set(method, list);
  }

  /** Mines a broadcast transaction (by hash) with `status`. */
  mine(hash: string, status: 0 | 1 = 1, gasUsed = 80_000n, logs: FakeReceipt['logs'] = []): void {
    this.receipts.set(hash, { status, gasUsed, effectiveGasPrice: this.baseFee + this.tip, logs });
    this.latestCount += 1n;
    if (this.pendingCount < this.latestCount) this.pendingCount = this.latestCount;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  readonly fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    this.calls.push({ method: body.method, params: body.params });
    const override = this.overrides.get(body.method)?.shift();
    let result: unknown;
    try {
      result = override ? override(body.params) : this.answer(body.method, body.params);
    } catch (err) {
      if (err instanceof RpcRefusal) {
        return json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: err.code, message: err.message },
        });
      }
      throw err; // transport failure
    }
    // A slow node: the answer is computed now but arrives later.
    const delay = this.delays.get(body.method)?.shift();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return json({ jsonrpc: '2.0', id: body.id, result });
  };

  private answer(method: string, params: unknown[]): unknown {
    const hex = (n: bigint) => `0x${n.toString(16)}`;
    switch (method) {
      case 'eth_estimateGas':
        return hex(this.gasEstimate);
      case 'eth_getBlockByNumber':
        return { number: '0x10', baseFeePerGas: hex(this.baseFee) };
      case 'eth_maxPriorityFeePerGas':
        return hex(this.tip);
      case 'eth_getTransactionCount':
        return hex(params[1] === 'latest' ? this.latestCount : this.pendingCount);
      case 'eth_sendRawTransaction': {
        const raw = String(params[0]);
        const tx = Transaction.from(raw);
        if (this.known.has(tx.hash!)) throw new RpcRefusal(-32000, 'already known');
        this.sent.push(raw);
        this.known.add(tx.hash!);
        if (BigInt(tx.nonce) >= this.pendingCount) this.pendingCount = BigInt(tx.nonce) + 1n;
        return tx.hash;
      }
      case 'eth_getTransactionByHash':
        return this.known.has(String(params[0])) ? { hash: params[0] } : null;
      case 'eth_getTransactionReceipt': {
        const r = this.receipts.get(String(params[0]));
        if (!r) return null;
        return {
          transactionHash: params[0],
          status: hex(BigInt(r.status)),
          gasUsed: hex(r.gasUsed),
          effectiveGasPrice: hex(r.effectiveGasPrice),
          ...(r.l1Fee !== undefined ? { l1Fee: hex(r.l1Fee) } : {}),
          blockNumber: '0x11',
          logs: r.logs,
        };
      }
      case 'eth_call': {
        const call = params[0] as { to: string; data: string };
        return this.ethCall(call.to, call.data);
      }
      case 'eth_chainId':
        return '0x2105';
      default:
        throw new RpcRefusal(-32601, `method not found: ${method}`);
    }
  }
}

/** Throw from an override to answer with a JSON-RPC error (the node refused). */
export class RpcRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
