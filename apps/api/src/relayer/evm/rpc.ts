// A minimal EVM JSON-RPC client for the relayer (live mode only; test mode never calls an RPC).
// Endpoints per 1Click chain id come from `EVM_RPC_URLS` over the public defaults (`evmRpcUrls`).
//
// Two error kinds, because the sender treats them differently:
//   EvmRpcError        the node answered with a JSON-RPC error: it saw the request and refused it.
//   EvmTransportError  no usable answer (network, timeout, HTTP error, malformed body): for a
//                      broadcast, the outcome is unknown.
import { evmRpcUrls, type FetchLike } from '../../checkout/senders/index.js';

export const EVM_RPC_TIMEOUT_MS = 10_000;

export class EvmRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
    this.name = 'EvmRpcError';
  }
}

export class EvmTransportError extends Error {
  constructor(
    readonly method: string,
    readonly cause: unknown,
  ) {
    super(`${method}: ${String(cause)}`);
    this.name = 'EvmTransportError';
  }
}

export interface EvmCallRequest {
  from?: string;
  to: string;
  data: string;
  value?: bigint;
}

export interface EvmReceipt {
  transactionHash: string;
  /** 1 = success, 0 = reverted. */
  status: 0 | 1;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: bigint;
}

const realFetch: FetchLike = (url, init) => fetch(url, init);

const hexQty = (n: bigint) => `0x${n.toString(16)}`;

function toBig(v: unknown, what: string): bigint {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error(`${what}: not a quantity: ${String(v).slice(0, 40)}`);
}

export class EvmRpc {
  private id = 0;

  constructor(
    readonly chain: string,
    private readonly url: string,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  /** The client for a 1Click EVM chain id; throws when no endpoint is configured. */
  static forChain(chain: string, fetchImpl: FetchLike = realFetch): EvmRpc {
    const url = evmRpcUrls()[chain];
    if (!url) throw new Error(`no EVM RPC configured for ${chain}`);
    return new EvmRpc(chain, url, fetchImpl);
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    let body: unknown;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(EVM_RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      throw new EvmTransportError(method, err);
    }
    if (!body || typeof body !== 'object') {
      throw new EvmTransportError(method, new Error('not a JSON-RPC response'));
    }
    const b = body as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (b.error) {
      throw new EvmRpcError(
        method,
        typeof b.error.code === 'number' ? b.error.code : null,
        typeof b.error.message === 'string' ? b.error.message : JSON.stringify(b.error),
        b.error.data,
      );
    }
    if (!('result' in b)) throw new EvmTransportError(method, new Error('no result'));
    return b.result;
  }

  async chainId(): Promise<bigint> {
    return toBig(await this.request('eth_chainId', []), 'eth_chainId');
  }

  async transactionCount(address: string, block: 'latest' | 'pending'): Promise<bigint> {
    return toBig(
      await this.request('eth_getTransactionCount', [address, block]),
      'eth_getTransactionCount',
    );
  }

  /** Also a dry run: a call that would revert is refused here (EvmRpcError), before any gas. */
  async estimateGas(tx: EvmCallRequest): Promise<bigint> {
    return toBig(
      await this.request('eth_estimateGas', [
        { from: tx.from, to: tx.to, data: tx.data, value: hexQty(tx.value ?? 0n) },
      ]),
      'eth_estimateGas',
    );
  }

  async baseFeePerGas(): Promise<bigint> {
    const block = (await this.request('eth_getBlockByNumber', ['latest', false])) as {
      baseFeePerGas?: unknown;
    } | null;
    if (!block) throw new EvmTransportError('eth_getBlockByNumber', new Error('no block'));
    return toBig(block.baseFeePerGas, 'baseFeePerGas');
  }

  async maxPriorityFeePerGas(): Promise<bigint> {
    return toBig(await this.request('eth_maxPriorityFeePerGas', []), 'eth_maxPriorityFeePerGas');
  }

  /** Broadcasts a signed transaction; returns the node's transaction hash. */
  async sendRawTransaction(raw: string): Promise<string> {
    const hash = await this.request('eth_sendRawTransaction', [raw]);
    if (typeof hash !== 'string') {
      throw new EvmTransportError('eth_sendRawTransaction', new Error('no hash'));
    }
    return hash;
  }

  /** Whether the node knows the transaction (pending or mined). */
  async hasTransaction(hash: string): Promise<boolean> {
    return (await this.request('eth_getTransactionByHash', [hash])) !== null;
  }

  async receipt(hash: string): Promise<EvmReceipt | null> {
    const r = (await this.request('eth_getTransactionReceipt', [hash])) as Record<
      string,
      unknown
    > | null;
    if (!r) return null;
    return {
      transactionHash: String(r.transactionHash ?? hash),
      status: toBig(r.status, 'status') === 1n ? 1 : 0,
      gasUsed: toBig(r.gasUsed, 'gasUsed'),
      effectiveGasPrice: toBig(r.effectiveGasPrice, 'effectiveGasPrice'),
      blockNumber: toBig(r.blockNumber, 'blockNumber'),
    };
  }

  /** `eth_call` at the latest block; returns the 0x result. */
  async call(tx: EvmCallRequest): Promise<string> {
    const out = await this.request('eth_call', [{ to: tx.to, data: tx.data }, 'latest']);
    if (typeof out !== 'string') throw new EvmTransportError('eth_call', new Error('no result'));
    return out;
  }
}
