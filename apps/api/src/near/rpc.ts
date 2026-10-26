// Thin NEAR JSON-RPC wrapper. The transport is injectable so tests script the node; the
// production transport is @near-js/providers' JsonRpcProvider.
import { JsonRpcProvider } from '@near-js/providers';
import bs58 from 'bs58';
import type { TxResult, TxStatusResult } from './client.js';

export interface RpcTransport {
  request<T>(method: string, params: object): Promise<T>;
}

/**
 * @near-js's provider retries a request (up to 10 attempts) on HTTP 408/500/503 and fetch errors.
 * That is fine for reads, but `send_tx` must be sent exactly once per call: the node answers 408
 * when `wait_until` times out on a transaction it already accepted, and a silent resend then comes
 * back as InvalidNonce (the first one used the nonce), which would read as "never sent". So
 * `send_tx` goes through a provider with a single attempt; `RpcNearClient` decides any resend.
 */
export const SEND_TX_PROVIDER_OPTIONS = { retries: 1 } as const;

export class JsonRpcTransport implements RpcTransport {
  readonly readProvider: JsonRpcProvider;
  readonly sendProvider: JsonRpcProvider;

  constructor(url: string) {
    this.readProvider = new JsonRpcProvider({ url });
    this.sendProvider = new JsonRpcProvider({ url }, SEND_TX_PROVIDER_OPTIONS);
  }

  request<T>(method: string, params: object): Promise<T> {
    const provider = method === 'send_tx' ? this.sendProvider : this.readProvider;
    return provider.sendJsonRpc<T>(method, params);
  }
}

/** A NEAR account's balance and storage (`view_account`). */
export interface AccountState {
  amountYocto: bigint;
  lockedYocto: bigint;
  storageUsageBytes: bigint;
}

type ExecutionStatus = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };

interface FinalExecutionOutcome {
  status: ExecutionStatus | string;
  transaction?: { hash?: string; signer_id?: string; receiver_id?: string };
  transaction_outcome?: {
    id?: string;
    outcome: { logs: string[]; status: ExecutionStatus | string; executor_id?: string };
  };
  receipts_outcome?: {
    id?: string;
    outcome: { logs: string[]; status: ExecutionStatus | string; executor_id?: string };
  }[];
}

/** The node does not know the transaction (not yet, or wrong shard routing). */
const UNKNOWN_TX = /\b(UNKNOWN_TRANSACTION|UnknownTransaction)\b/;

/** A NEAR query answered with an error (e.g. unknown account, missing method, contract panic). */
export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = 'NearRpcError';
  }
}

/**
 * The transaction certainly never reached the chain: it failed before `send_tx`, or the node
 * rejected it as invalid. Nothing was spent; it is safe to retry. `cause` is the original error.
 */
export class NotBroadcastError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'NotBroadcastError';
  }
}

/**
 * The transaction may or may not have executed: `send_tx` timed out or the network failed after
 * the transaction left this process, and a resend of the identical transaction did not settle it.
 * Callers must treat it as possibly spent (keep funding reservations and relay claims) and learn
 * the outcome from the chain. `cause` is the first error, `resendError` the resend's.
 */
export class OutcomeUnknownError extends Error {
  constructor(
    cause: unknown,
    readonly resendError: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'OutcomeUnknownError';
  }
}

function errorText(err: unknown): string {
  if (!err || typeof err !== 'object') return typeof err === 'string' ? err : '';
  const e = err as { type?: unknown; name?: unknown; message?: unknown; data?: unknown };
  return [e.type, e.name, e.message]
    .filter((x): x is string => typeof x === 'string')
    .concat(safeJson(e.data))
    .join(' ');
}

/** True if `err` is the node rejecting a transaction for a stale or reused nonce. */
export function isInvalidNonce(err: unknown): boolean {
  return /\bInvalidNonce\b/.test(errorText(err));
}

/**
 * nearcore `InvalidTxError` variants (and their `InvalidAccessKeyError` children): the node
 * refused the transaction before it entered a chunk, so it was never executed. @near-js surfaces
 * them as a TypedError whose `type` is the variant name; raw RPC errors name the class.
 */
const INVALID_TX =
  /\b(INVALID_TRANSACTION|InvalidTxError|InvalidAccessKeyError|AccessKeyNotFound|ReceiverMismatch|MethodNameMismatch|RequiresFullAccess|NotEnoughAllowance|DepositWithFunctionCall|InvalidSignerId|SignerDoesNotExist|InvalidNonce|NonceTooLarge|InvalidReceiverId|InvalidSignature|NotEnoughBalance|LackBalanceForState|CostOverflow|InvalidChain|Expired|ActionsValidation|TransactionSizeExceeded|InvalidTransactionVersion|ShardCongested|ShardStuck)\b/;

/** True if the node rejected the transaction as invalid (so it was certainly not executed). */
export function isInvalidTransaction(err: unknown): boolean {
  return INVALID_TX.test(errorText(err));
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
  const successLogs = outcomes
    .filter((r) => !failureOf(r.outcome.status))
    .flatMap((r) => r.outcome.logs);
  const failure =
    failureOf(o.status) ?? outcomes.map((r) => failureOf(r.outcome.status)).find(Boolean);
  const txHash = o.transaction?.hash ?? o.transaction_outcome?.id ?? fallbackHash;
  const topLevelStatus = failureOf(o.status) ? 'failure' : 'success';
  return failure
    ? { txHash, logs, successLogs, status: 'failure', topLevelStatus, failure }
    : { txHash, logs, successLogs, status: 'success', topLevelStatus };
}

export class NearRpc {
  constructor(private readonly transport: RpcTransport) {}

  /** The current nonce of `publicKey` (`ed25519:…`) on `accountId`. */
  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    const r = await this.query<{ nonce: number | string }>({
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    });
    return BigInt(r.nonce);
  }

  /**
   * `query` can succeed at the JSON-RPC level yet carry `result.error` (a string) — e.g. a view
   * that panicked or an unknown access key. @near-js only throws for error types it recognises.
   */
  private async query<T extends object>(params: {
    request_type: string;
    [k: string]: unknown;
  }): Promise<T> {
    const r = await this.transport.request<T & { error?: unknown }>('query', params);
    if (r.error !== undefined && r.error !== null) {
      throw new NearRpcError(
        typeof r.error === 'string' ? r.error : safeJson(r.error),
        params.request_type,
      );
    }
    return r;
  }

  /** Hash of the latest final block, used as the transaction's recent block hash. */
  async finalBlockHash(): Promise<Uint8Array> {
    const r = await this.transport.request<{ header: { hash: string } }>('block', {
      finality: 'final',
    });
    return bs58.decode(r.header.hash);
  }

  async viewFunction<T>(contractId: string, method: string, args: object): Promise<T> {
    const r = await this.query<{ result: number[] }>({
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
  }

  /** `view_account`: liquid and locked balance (yoctoNEAR) and storage used (bytes). */
  async viewAccount(accountId: string): Promise<AccountState> {
    const r = await this.query<{ amount: string; locked: string; storage_usage: number }>({
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return {
      amountYocto: BigInt(r.amount),
      lockedYocto: BigInt(r.locked),
      storageUsageBytes: BigInt(r.storage_usage),
    };
  }

  /** Public keys (`ed25519:…`) of every access key on `accountId`. */
  async accessKeyList(accountId: string): Promise<string[]> {
    const r = await this.query<{ keys: { public_key: string }[] }>({
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: accountId,
    });
    return r.keys.map((k) => k.public_key);
  }

  /**
   * `EXPERIMENTAL_tx_status` of a final transaction: its signer, receiver and every receipt with
   * executor, logs and success. Null when the node does not know the transaction.
   * `accountId` (the sender, or else the receiver) routes the lookup to the right shard.
   */
  async txStatus(hash: string, accountId: string): Promise<TxStatusResult | null> {
    let o: FinalExecutionOutcome;
    try {
      o = await this.transport.request<FinalExecutionOutcome>('EXPERIMENTAL_tx_status', {
        tx_hash: hash,
        sender_account_id: accountId,
        wait_until: 'FINAL',
      });
    } catch (err) {
      if (UNKNOWN_TX.test(errorText(err))) return null;
      throw err;
    }
    return {
      hash: o.transaction?.hash ?? hash,
      signerId: o.transaction?.signer_id ?? '',
      receiverId: o.transaction?.receiver_id ?? '',
      receipts: (o.receipts_outcome ?? []).map((r) => ({
        receiptId: r.id ?? '',
        executorId: r.outcome.executor_id ?? '',
        logs: [...r.outcome.logs],
        ok: !failureOf(r.outcome.status),
      })),
    };
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
