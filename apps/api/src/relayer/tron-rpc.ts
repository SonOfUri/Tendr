// The Tron HTTP API (TronGrid-compatible, `TRON_RPC_URL`) as gasless Tron payments use it
// (project 5a, ruling T9-e): blocks, accounts and resources, constant calls, broadcasting signed
// transactions and reading their outcome. Every address is base58 (`visible: true`). A small
// in-house client (no TronWeb): only these calls, a timeout on each, and nothing logged but the
// path. `walletsolidity/*` answers from the solidified (final) chain.
import { z } from 'zod';
import { env } from '../env.js';

/** The Tron API could not be reached or answered something unusable. */
export class TronRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TronRpcError';
  }
}

export interface TronBlock {
  /** `blockID`, hex. */
  id: string;
  number: bigint;
  /** ms since the epoch. */
  timestamp: number;
}

export interface TronResources {
  freeNetLimit: bigint;
  freeNetUsed: bigint;
  netLimit: bigint;
  netUsed: bigint;
  energyLimit: bigint;
  energyUsed: bigint;
  totalEnergyLimit: bigint;
  totalEnergyWeight: bigint;
  totalNetLimit: bigint;
  totalNetWeight: bigint;
}

export interface TronLog {
  /** 20-byte hex, no prefix. */
  address: string;
  topics: string[];
  data: string;
}

/** `gettransactioninfobyid`: a transaction included in a block. */
export interface TronTxInfo {
  id: string;
  blockNumber: number;
  blockTimeStamp: number;
  /** Total TRX burned (sun). */
  fee: bigint;
  /** `FAILED` when the contract failed; absent on success. */
  result: string | null;
  /** Contract calls: `SUCCESS`, `REVERT`, `OUT_OF_ENERGY`, …; absent for system contracts. */
  receiptResult: string | null;
  /** Energy taken from the payer's own (or delegated) energy, and bought by burning TRX. */
  energyUsage: bigint;
  energyFee: bigint;
  /** Bandwidth taken from the payer's own (or delegated) bandwidth, and burned for. */
  netUsage: bigint;
  netFee: bigint;
  logs: TronLog[];
}

/** `broadcasthex`: accepted, or refused with the node's code. */
export type BroadcastResult = { ok: true } | { ok: false; code: string; message: string };

/** The Tron API calls gasless payments make (tests script it). */
export interface TronApi {
  nowBlock(solid: boolean): Promise<TronBlock>;
  /** Whether the account exists on chain (activated). */
  accountExists(address: string): Promise<boolean>;
  resources(address: string): Promise<TronResources>;
  /** The most TRX (sun) `owner` can delegate now for the resource. */
  canDelegateMaxSun(owner: string, resource: 'energy' | 'bandwidth'): Promise<bigint>;
  /** TRX (sun) `from` has delegated to `to` for the resource right now. */
  delegatedSun(from: string, to: string, resource: 'energy' | 'bandwidth'): Promise<bigint>;
  /** A read-only call: the returned word (hex) and the energy it used. */
  constantCall(
    owner: string,
    contract: string,
    selector: string,
    parameter: string,
  ): Promise<{ result: string; energyUsed: bigint }>;
  /** sun per energy unit (`getEnergyFee`). */
  energyPrice(): Promise<bigint>;
  broadcastHex(signedHex: string): Promise<BroadcastResult>;
  /** The transaction's info, or null while it is not in a (solidified, when `solid`) block. */
  txInfo(txId: string, solid: boolean): Promise<TronTxInfo | null>;
}

const big = (v: unknown): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,30}$/.test(v)) return BigInt(v);
  return 0n;
};

const BlockSchema = z.object({
  blockID: z.string().regex(/^[0-9a-fA-F]{64}$/),
  block_header: z.object({
    raw_data: z.object({ number: z.number().int().nonnegative(), timestamp: z.number().int() }),
  }),
});

const InfoSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{64}$/),
  blockNumber: z.number().int().nonnegative(),
  blockTimeStamp: z.number().int(),
  fee: z.number().optional(),
  result: z.string().optional(),
  receipt: z.record(z.string(), z.unknown()).optional(),
  log: z
    .array(
      z.object({
        address: z.string().optional(),
        topics: z.array(z.string()).optional(),
        data: z.string().optional(),
      }),
    )
    .optional(),
});

/** The live client: `TRON_RPC_URL`. */
export class TronHttp implements TronApi {
  constructor(
    private readonly deps: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const url = `${this.deps.url ?? env().TRON_RPC_URL}${path}`;
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new TronRpcError(`${path}: unreachable (${String(err).slice(0, 120)})`);
    }
    if (!res.ok) throw new TronRpcError(`${path}: HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new TronRpcError(`${path}: invalid JSON`);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new TronRpcError(`${path}: unexpected answer`);
    }
    const o = json as Record<string, unknown>;
    if (typeof o.Error === 'string') throw new TronRpcError(`${path}: ${o.Error.slice(0, 200)}`);
    return o;
  }

  async nowBlock(solid: boolean): Promise<TronBlock> {
    const r = BlockSchema.safeParse(
      await this.post(solid ? '/walletsolidity/getnowblock' : '/wallet/getnowblock', {}),
    );
    if (!r.success) throw new TronRpcError('getnowblock: unexpected answer');
    return {
      id: r.data.blockID.toLowerCase(),
      number: BigInt(r.data.block_header.raw_data.number),
      timestamp: r.data.block_header.raw_data.timestamp,
    };
  }

  async accountExists(address: string): Promise<boolean> {
    const r = await this.post('/wallet/getaccount', { address, visible: true });
    return typeof r.address === 'string';
  }

  async resources(address: string): Promise<TronResources> {
    const r = await this.post('/wallet/getaccountresource', { address, visible: true });
    return {
      freeNetLimit: big(r.freeNetLimit),
      freeNetUsed: big(r.freeNetUsed),
      netLimit: big(r.NetLimit),
      netUsed: big(r.NetUsed),
      energyLimit: big(r.EnergyLimit),
      energyUsed: big(r.EnergyUsed),
      totalEnergyLimit: big(r.TotalEnergyLimit),
      totalEnergyWeight: big(r.TotalEnergyWeight),
      totalNetLimit: big(r.TotalNetLimit),
      totalNetWeight: big(r.TotalNetWeight),
    };
  }

  async canDelegateMaxSun(owner: string, resource: 'energy' | 'bandwidth'): Promise<bigint> {
    const r = await this.post('/wallet/getcandelegatedmaxsize', {
      owner_address: owner,
      type: resource === 'energy' ? 1 : 0,
      visible: true,
    });
    return big(r.max_size);
  }

  async delegatedSun(from: string, to: string, resource: 'energy' | 'bandwidth'): Promise<bigint> {
    const r = await this.post('/wallet/getdelegatedresourcev2', {
      fromAddress: from,
      toAddress: to,
      visible: true,
    });
    const list = Array.isArray(r.delegatedResource) ? r.delegatedResource : [];
    let total = 0n;
    for (const d of list) {
      const o = (d ?? {}) as Record<string, unknown>;
      total += big(
        resource === 'energy' ? o.frozen_balance_for_energy : o.frozen_balance_for_bandwidth,
      );
    }
    return total;
  }

  async constantCall(owner: string, contract: string, selector: string, parameter: string) {
    const r = await this.post('/wallet/triggerconstantcontract', {
      owner_address: owner,
      contract_address: contract,
      function_selector: selector,
      parameter,
      visible: true,
    });
    const res = (r.result ?? {}) as Record<string, unknown>;
    const out = Array.isArray(r.constant_result) ? r.constant_result[0] : undefined;
    if (res.result !== true || typeof out !== 'string' || !/^[0-9a-fA-F]*$/.test(out)) {
      throw new TronRpcError(`triggerconstantcontract ${selector}: refused`);
    }
    return { result: out.toLowerCase(), energyUsed: big(r.energy_used) };
  }

  async energyPrice(): Promise<bigint> {
    const r = await this.post('/wallet/getchainparameters', {});
    const params = Array.isArray(r.chainParameter) ? r.chainParameter : [];
    const fee = params.find((p) => (p as Record<string, unknown>)?.key === 'getEnergyFee') as
      Record<string, unknown> | undefined;
    const v = big(fee?.value);
    if (v <= 0n) throw new TronRpcError('getchainparameters: no energy fee');
    return v;
  }

  async broadcastHex(signedHex: string): Promise<BroadcastResult> {
    const r = await this.post('/wallet/broadcasthex', { transaction: signedHex });
    if (r.result === true) return { ok: true };
    const code = typeof r.code === 'string' ? r.code : 'OTHER_ERROR';
    let message = typeof r.message === 'string' ? r.message : '';
    // TronGrid hex-encodes the message.
    if (/^[0-9a-fA-F]+$/.test(message)) message = Buffer.from(message, 'hex').toString('utf8');
    return { ok: false, code, message: message.slice(0, 300) };
  }

  async txInfo(txId: string, solid: boolean): Promise<TronTxInfo | null> {
    const r = await this.post(
      solid ? '/walletsolidity/gettransactioninfobyid' : '/wallet/gettransactioninfobyid',
      { value: txId },
    );
    if (Object.keys(r).length === 0) return null;
    const p = InfoSchema.safeParse(r);
    if (!p.success || p.data.id.toLowerCase() !== txId.toLowerCase()) {
      throw new TronRpcError('gettransactioninfobyid: unexpected answer');
    }
    const receipt = p.data.receipt ?? {};
    return {
      id: p.data.id.toLowerCase(),
      blockNumber: p.data.blockNumber,
      blockTimeStamp: p.data.blockTimeStamp,
      fee: big(p.data.fee),
      result: p.data.result ?? null,
      receiptResult: typeof receipt.result === 'string' ? receipt.result : null,
      energyUsage: big(receipt.energy_usage),
      energyFee: big(receipt.energy_fee),
      netUsage: big(receipt.net_usage),
      netFee: big(receipt.net_fee),
      logs: (p.data.log ?? []).map((l) => ({
        address: (l.address ?? '').toLowerCase(),
        topics: (l.topics ?? []).map((t) => t.toLowerCase()),
        data: (l.data ?? '').toLowerCase(),
      })),
    };
  }
}

/**
 * Broadcast codes after which the node refused the transaction before it could enter a block:
 * nothing was spent and it never executes. Anything else (busy, no connection, …) is unknown.
 */
export const TRON_REJECTED_CODES = new Set([
  'SIGERROR',
  'CONTRACT_VALIDATE_ERROR',
  'CONTRACT_EXE_ERROR',
  'BANDWITH_ERROR',
  'TAPOS_ERROR',
  'TOO_BIG_TRANSACTION_ERROR',
  'TRANSACTION_EXPIRATION_ERROR',
]);

/** The node already has it: as good as accepted. */
export const TRON_DUPLICATE_CODE = 'DUP_TRANSACTION_ERROR';
