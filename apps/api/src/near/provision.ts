// Merchant-account provisioning guards: what a provisioning request may look like, and how much
// `funding-near` may spend. Every NearClient handed out by `nearClient()` is a CappedNearClient.
import type { PrismaClient, Prisma } from '@prisma/client';
import { recordEvent } from '../events/record.js';
import { AppError } from '../lib/errors.js';
import { prisma as defaultPrisma } from '../lib/prisma.js';
import type { NearClient, ProvisionParams, TopUpParams, TxResult } from './client.js';
import { NotBroadcastError } from './rpc.js';

/** The per-mode facts a provisioning request is checked against. */
export interface ProvisionScope {
  livemode: boolean;
  parentAccountId: string;
  intentsContractId: string;
}

const LABEL = /^[a-z0-9]+([-_][a-z0-9]+)*$/;

/** A provisioning request the funding key refuses to sign; retrying it fails the same way. */
export class ProvisionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionRequestError';
  }
}

/**
 * Rejects a request the funding key must never sign: wrong mode, an account that is not a direct
 * sub-account of this mode's parent (`<slug>.tendr.near` / `<slug>.tendr.testnet`), an init
 * pointing at another mode's intents contract, or a live account carrying a testnet admin.
 */
export function assertProvisionable(p: ProvisionParams, scope: ProvisionScope): void {
  if (p.livemode !== scope.livemode) {
    throw new ProvisionRequestError(
      `provisioning livemode=${p.livemode} on a livemode=${scope.livemode} client`,
    );
  }
  const suffix = `.${scope.parentAccountId}`;
  const label = p.accountId.endsWith(suffix) ? p.accountId.slice(0, -suffix.length) : '';
  if (!LABEL.test(label) || p.accountId.length > 64) {
    throw new ProvisionRequestError(
      `account ${p.accountId} is not a direct sub-account of ${scope.parentAccountId}`,
    );
  }
  if (p.init.intents_contract !== scope.intentsContractId) {
    throw new ProvisionRequestError(
      `init intents_contract ${p.init.intents_contract} is not ${scope.intentsContractId}`,
    );
  }
  if (scope.livemode && p.init.testnet_admin !== null) {
    throw new ProvisionRequestError('a live merchant account must not have a testnet_admin');
  }
}

/**
 * Rejects a storage top-up the funding key must never sign: wrong mode, a receiver that is not a
 * direct sub-account of this mode's parent (a merchant account), or a non-positive amount.
 */
export function assertTopUpAllowed(p: TopUpParams, scope: ProvisionScope): void {
  if (p.livemode !== scope.livemode) {
    throw new ProvisionRequestError(
      `top-up livemode=${p.livemode} on a livemode=${scope.livemode} client`,
    );
  }
  const suffix = `.${scope.parentAccountId}`;
  const label = p.accountId.endsWith(suffix) ? p.accountId.slice(0, -suffix.length) : '';
  if (!LABEL.test(label) || p.accountId.length > 64) {
    throw new ProvisionRequestError(
      `account ${p.accountId} is not a direct sub-account of ${scope.parentAccountId}`,
    );
  }
  if (p.amountYocto <= 0n) throw new ProvisionRequestError('top-up amount must be positive');
}

/**
 * Guards `callAsTestnetAdmin`: only on a testnet client, and only to a direct sub-account of the
 * test parent (a merchant test account, whose `testnet_admin` is that parent).
 */
export function assertTestnetAdminCall(scope: ProvisionScope, contractId: string): void {
  if (scope.livemode) {
    throw new Error('testnet admin calls are testnet only; a live client never makes them');
  }
  const suffix = `.${scope.parentAccountId}`;
  const label = contractId.endsWith(suffix) ? contractId.slice(0, -suffix.length) : '';
  if (!LABEL.test(label) || contractId.length > 64) {
    throw new Error(
      `account ${contractId} is not a direct sub-account of ${scope.parentAccountId}`,
    );
  }
}

export interface FundingCaps {
  perAccountYocto: bigint;
  dailyYocto: bigint;
}

/** One advisory-lock key per mode, so live and test provisioning never block each other. */
const FUNDING_LOCK = { live: 0x74656e6472_01n, test: 0x74656e6472_00n } as const; // "tendr"

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Net yoctoNEAR reserved in `livemode` during the last 24 hours: `funding.spent` (provisioning)
 * and `funding.topup` (storage top-ups) rows in the window, minus the `funding.released` rows
 * that cancel one of those reservations (matched by `reservationId`, so a release never outlives
 * the reservation it cancels).
 */
export async function fundingSpentLast24h(db: Db, livemode: boolean): Promise<bigint> {
  const [row] = await db.$queryRaw<{ total: string }[]>`
    WITH spent AS (
      SELECT id, (payload->>'amountYocto')::numeric AS amount
      FROM events
      WHERE type IN ('funding.spent', 'funding.topup')
        AND livemode = ${livemode}
        AND created_at > now() - interval '24 hours'
    )
    SELECT (
      COALESCE((SELECT SUM(amount) FROM spent), 0)
      - COALESCE((
          SELECT SUM((payload->>'amountYocto')::numeric)
          FROM events
          WHERE type = 'funding.released'
            AND payload->>'reservationId' IN (SELECT id FROM spent)
        ), 0)
    )::text AS total`;
  return BigInt(row?.total ?? '0');
}

export class FundingCapError extends AppError {
  constructor(cap: 'per_account' | 'daily', message: string) {
    super(
      cap === 'daily' ? 'RATE_LIMITED' : 'VALIDATION_ERROR',
      message,
      cap === 'daily' ? 429 : 400,
      { cap },
    );
    this.name = 'FundingCapError';
  }
}

/**
 * Wraps a NearClient so `provisionAccount` spends within the caps.
 *
 * 1. Preflight (request shape, caps, inner `preflightProvision`: config + key vault) — nothing is
 *    reserved if any of it fails.
 * 2. Reserve: a `funding.spent` event on the provisioned merchant, written in a transaction
 *    holding the mode's advisory lock, so concurrent provisionings cannot both pass the cap.
 * 3. Send. The reservation is cancelled by a `funding.released` event (same amount,
 *    `reservationId` = the spent event) when the spend certainly did not happen: the inner client
 *    threw NotBroadcastError (failed before broadcast, or rejected as an invalid tx), or the
 *    batch failed on chain (one receipt, so the whole batch — transfer included — reverted).
 *    Timeouts and other unknown outcomes keep the reservation: the cap errs toward spending less.
 */
export class CappedNearClient implements NearClient {
  constructor(
    private readonly inner: NearClient,
    private readonly scope: ProvisionScope,
    private readonly caps: FundingCaps,
    private readonly db: PrismaClient = defaultPrisma,
  ) {}

  call: NearClient['call'] = (...args) => this.inner.call(...args);
  view: NearClient['view'] = (...args) => this.inner.view(...args);
  viewAccount: NearClient['viewAccount'] = (...args) => this.inner.viewAccount(...args);
  accessKeys: NearClient['accessKeys'] = (...args) => this.inner.accessKeys(...args);

  async callAsTestnetAdmin(
    ...args: Parameters<NearClient['callAsTestnetAdmin']>
  ): Promise<TxResult> {
    assertTestnetAdminCall(this.scope, args[0]);
    return this.inner.callAsTestnetAdmin(...args);
  }

  async provisionAccount(p: ProvisionParams): Promise<TxResult> {
    // Validate before reserving, so a malformed request never consumes cap.
    assertProvisionable(p, this.scope);
    const amount = p.initialBalanceYocto;
    if (amount <= 0n) throw new FundingCapError('per_account', 'initial balance must be positive');
    if (amount > this.caps.perAccountYocto) {
      throw new FundingCapError(
        'per_account',
        `initial balance ${amount} yocto exceeds the per-account cap ${this.caps.perAccountYocto}`,
      );
    }
    await this.inner.preflightProvision?.(p);
    const spend = { ...p, amountYocto: amount };
    return this.spendWithinCap(spend, 'funding.spent', () => this.inner.provisionAccount(p));
  }

  /**
   * A storage top-up of an existing merchant account (R35): the same guards as provisioning (a
   * direct sub-account of the parent, at most the per-account cap) and the same daily cap,
   * reserved as a `funding.topup` event.
   */
  async topUpAccount(p: TopUpParams): Promise<TxResult> {
    assertTopUpAllowed(p, this.scope);
    if (p.amountYocto > this.caps.perAccountYocto) {
      throw new FundingCapError(
        'per_account',
        `top-up ${p.amountYocto} yocto exceeds the per-account cap ${this.caps.perAccountYocto}`,
      );
    }
    return this.spendWithinCap(p, 'funding.topup', () => this.inner.topUpAccount(p));
  }

  /** Reserves `amountYocto` against the daily cap, runs `send`, releases it if nothing was spent. */
  private async spendWithinCap(
    p: TopUpParams,
    type: 'funding.spent' | 'funding.topup',
    send: () => Promise<TxResult>,
  ): Promise<TxResult> {
    const amount = p.amountYocto;
    const reservationId = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${
        p.livemode ? FUNDING_LOCK.live : FUNDING_LOCK.test
      })`;
      const spent = await fundingSpentLast24h(tx, p.livemode);
      if (spent + amount > this.caps.dailyYocto) {
        throw new FundingCapError(
          'daily',
          `funding daily cap reached: ${spent} + ${amount} > ${this.caps.dailyYocto} yocto`,
        );
      }
      return recordEvent(
        tx,
        { merchantId: p.merchantId, livemode: p.livemode },
        {
          aggregateType: 'near_account',
          aggregateId: p.accountId,
          type,
          payload: { accountId: p.accountId, amountYocto: amount.toString() },
        },
      );
    });

    let result: TxResult;
    try {
      result = await send();
    } catch (err) {
      if (err instanceof NotBroadcastError) {
        await this.release(p, reservationId, 'not_broadcast');
      }
      throw err;
    }
    if (result.status === 'failure') {
      await this.release(p, reservationId, 'failed_on_chain', result.txHash);
    }
    return result;
  }

  private async release(
    p: TopUpParams,
    reservationId: string,
    reason: 'not_broadcast' | 'failed_on_chain',
    txHash?: string,
  ): Promise<void> {
    await this.db.$transaction((tx) =>
      recordEvent(
        tx,
        { merchantId: p.merchantId, livemode: p.livemode },
        {
          aggregateType: 'near_account',
          aggregateId: p.accountId,
          type: 'funding.released',
          payload: {
            accountId: p.accountId,
            amountYocto: p.amountYocto.toString(),
            reservationId,
            reason,
            ...(txHash ? { txHash } : {}),
          },
        },
      ),
    );
  }
}
