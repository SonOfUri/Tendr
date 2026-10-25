// Where SimulatedOneClick keeps its deposits. The API process serves the test-mode `simulate`
// route while the worker polls `status`, so the default store is Redis (shared by both):
// `sim1click:<depositAddress>` → JSON, 48 h TTL. The in-memory store is for unit tests only.
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getRedis, whenReady } from '../../lib/redis.js';
import { OneClickError, type OneClickStatus, type QuoteRequest, type TxHashRef } from './types.js';

/** A simulated deposit address: its quote plus where its deposit has got to. */
export interface SimDeposit {
  req: QuoteRequest;
  amountIn: bigint;
  amountOut: bigint;
  deadline: Date;
  status: OneClickStatus;
  deposited: bigint;
  refunded: bigint;
  refundReason?: string;
  origin: TxHashRef[];
  senderAddress?: string;
  settled: boolean;
}

export interface SimStore {
  get(depositAddress: string): Promise<SimDeposit | null>;
  /** Stores `d` unless the address already has state; returns whether it stored it. */
  create(depositAddress: string, d: SimDeposit): Promise<boolean>;
  put(depositAddress: string, d: SimDeposit): Promise<void>;
  /**
   * Runs `fn` while holding the address's lock (read-modify-write across processes). A lock
   * already held elsewhere fails fast with OneClickError 409 `BUSY`.
   */
  withLock<T>(depositAddress: string, fn: () => Promise<T>): Promise<T>;
}

export const SIM_KEY_PREFIX = 'sim1click:';
export const SIM_TTL_MS = 48 * 60 * 60 * 1000;
/** Upper bound on one locked simulate (it makes NEAR calls). */
const LOCK_TTL_MS = 30_000;

const key = (depositAddress: string): string => `${SIM_KEY_PREFIX}${depositAddress}`;
const lockKey = (depositAddress: string): string => `${key(depositAddress)}:lock`;

function busy(depositAddress: string): OneClickError {
  return new OneClickError(`simulated deposit ${depositAddress} is being updated`, 409, 'BUSY');
}

interface SimDepositJson extends Omit<
  SimDeposit,
  'amountIn' | 'amountOut' | 'deadline' | 'deposited' | 'refunded'
> {
  amountIn: string;
  amountOut: string;
  deadline: string;
  deposited: string;
  refunded: string;
}

export function encodeSimDeposit(d: SimDeposit): string {
  const json: SimDepositJson = {
    ...d,
    amountIn: d.amountIn.toString(),
    amountOut: d.amountOut.toString(),
    deadline: d.deadline.toISOString(),
    deposited: d.deposited.toString(),
    refunded: d.refunded.toString(),
  };
  return JSON.stringify(json);
}

export function decodeSimDeposit(text: string): SimDeposit {
  const j = JSON.parse(text) as SimDepositJson;
  return {
    ...j,
    amountIn: BigInt(j.amountIn),
    amountOut: BigInt(j.amountOut),
    deadline: new Date(j.deadline),
    deposited: BigInt(j.deposited),
    refunded: BigInt(j.refunded),
  };
}

/** Unit tests only: state lives in this instance. */
export class MemorySimStore implements SimStore {
  private readonly items = new Map<string, string>();
  private readonly locks = new Set<string>();

  async get(depositAddress: string): Promise<SimDeposit | null> {
    const text = this.items.get(depositAddress);
    return text === undefined ? null : decodeSimDeposit(text);
  }

  async create(depositAddress: string, d: SimDeposit): Promise<boolean> {
    if (this.items.has(depositAddress)) return false;
    this.items.set(depositAddress, encodeSimDeposit(d));
    return true;
  }

  async put(depositAddress: string, d: SimDeposit): Promise<void> {
    this.items.set(depositAddress, encodeSimDeposit(d));
  }

  async withLock<T>(depositAddress: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(depositAddress)) throw busy(depositAddress);
    this.locks.add(depositAddress);
    try {
      return await fn();
    } finally {
      this.locks.delete(depositAddress);
    }
  }
}

const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Shared across processes (API + worker). Defaults to the process-wide Redis client. */
export class RedisSimStore implements SimStore {
  constructor(private readonly redis: () => Redis = getRedis) {}

  private async client(): Promise<Redis> {
    const r = this.redis();
    await whenReady(r);
    return r;
  }

  async get(depositAddress: string): Promise<SimDeposit | null> {
    const text = await (await this.client()).get(key(depositAddress));
    return text === null ? null : decodeSimDeposit(text);
  }

  async create(depositAddress: string, d: SimDeposit): Promise<boolean> {
    const r = await this.client();
    const ok = await r.set(key(depositAddress), encodeSimDeposit(d), 'PX', SIM_TTL_MS, 'NX');
    return ok === 'OK';
  }

  async put(depositAddress: string, d: SimDeposit): Promise<void> {
    await (await this.client()).set(key(depositAddress), encodeSimDeposit(d), 'PX', SIM_TTL_MS);
  }

  async withLock<T>(depositAddress: string, fn: () => Promise<T>): Promise<T> {
    const r = await this.client();
    const token = randomBytes(16).toString('hex');
    const ok = await r.set(lockKey(depositAddress), token, 'PX', LOCK_TTL_MS, 'NX');
    if (ok !== 'OK') throw busy(depositAddress);
    try {
      return await fn();
    } finally {
      await r.eval(RELEASE_LOCK, 1, lockKey(depositAddress), token).catch(() => undefined);
    }
  }
}
