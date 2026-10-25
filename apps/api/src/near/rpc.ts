// Thin NEAR JSON-RPC wrapper. The transport is injectable so tests script the node; the
// production transport is @near-js/providers' JsonRpcProvider.
import { JsonRpcProvider } from '@near-js/providers';
import bs58 from 'bs58';
import type { TxResult } from './client.js';

export interface RpcTransport {
  request<T>(method: string, params: object): Promise<T>;
}

export class JsonRpcTransport implements RpcTransport {
  private readonly provider: JsonRpcProvider;

  constructor(url: string) {
    this.provider = new JsonRpcProvider({ url });
  }

  request<T>(method: string, params: object): Promise<T> {
    return this.provider.sendJsonRpc<T>(method, params);
  }
}

type ExecutionStatus = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };

interface FinalExecutionOutcome {
  status: ExecutionStatus | string;
  transaction?: { hash?: string };
  transaction_outcome?: {
    id?: string;
    outcome: { logs: string[]; status: ExecutionStatus | string };
  };
  receipts_outcome?: {
    id?: string;
    outcome: { logs: string[]; status: ExecutionStatus | string };
  }[];
}

/** True if `err` is the node rejecting a transaction for a stale or reused nonce. */
export function isInvalidNonce(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { type?: unknown; message?: unknown; data?: unknown };
  if (e.type === 'InvalidNonce') return true;
  const text = `${typeof e.message === 'string' ? e.message : ''} ${safeJson(e.data)}`;
  return text.includes('InvalidNonce');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

function failureOf(status: ExecutionStatus | string | undefined): string | undefined {
  if (!status || typeof status === 'string') {
    return status === 'Failure' ? 'Failure' : undefined;
  }
  return status.Failure !== undefined ? JSON.stringify(status.Failure) : undefined;
}

/** Maps a final execution outcome to a TxResult: logs of every receipt, first failure wins. */
export function toTxResult(o: FinalExecutionOutcome, fallbackHash: string): TxResult {
  const outcomes = [
    ...(o.transaction_outcome ? [o.transaction_outcome] : []),
    ...(o.receipts_outcome ?? []),
  ];
  const logs = outcomes.flatMap((r) => r.outcome.logs);
  const failure =
    failureOf(o.status) ?? outcomes.map((r) => failureOf(r.outcome.status)).find(Boolean);
  const txHash = o.transaction?.hash ?? o.transaction_outcome?.id ?? fallbackHash;
  return failure
    ? { txHash, logs, status: 'failure', failure }
    : { txHash, logs, status: 'success' };
}

export class NearRpc {
  constructor(private readonly transport: RpcTransport) {}

  /** The current nonce of `publicKey` (`ed25519:…`) on `accountId`. */
  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    const r = await this.transport.request<{ nonce: number | string }>('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    });
    return BigInt(r.nonce);
  }

  /** Hash of the latest final block, used as the transaction's recent block hash. */
  async finalBlockHash(): Promise<Uint8Array> {
    const r = await this.transport.request<{ header: { hash: string } }>('block', {
      finality: 'final',
    });
    return bs58.decode(r.header.hash);
  }

  async viewFunction<T>(contractId: string, method: string, args: object): Promise<T> {
    const r = await this.transport.request<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
  }

  /** Public keys (`ed25519:…`) of every access key on `accountId`. */
  async accessKeyList(accountId: string): Promise<string[]> {
    const r = await this.transport.request<{ keys: { public_key: string }[] }>('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: accountId,
    });
    return r.keys.map((k) => k.public_key);
  }

  /** Broadcasts a signed transaction and waits until it is final. */
  async sendTx(signedBytes: Uint8Array, hash: string): Promise<TxResult> {
    const o = await this.transport.request<FinalExecutionOutcome>('send_tx', {
      signed_tx_base64: Buffer.from(signedBytes).toString('base64'),
      wait_until: 'FINAL',
    });
    return toTxResult(o, hash);
  }
}
