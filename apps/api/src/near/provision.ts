// Merchant-account provisioning guards: what a provisioning request may look like, and how much
// `funding-near` may spend. Every NearClient handed out by `nearClient()` is a CappedNearClient.
import type { PrismaClient, Prisma } from '@prisma/client';
import { recordEvent } from '../events/record.js';
import { AppError } from '../lib/errors.js';
import { prisma as defaultPrisma } from '../lib/prisma.js';
import type { NearClient, ProvisionParams, TxResult } from './client.js';

/** The per-mode facts a provisioning request is checked against. */
export interface ProvisionScope {
  livemode: boolean;
  parentAccountId: string;
  intentsContractId: string;
}

const LABEL = /^[a-z0-9]+([-_][a-z0-9]+)*$/;

/**
 * Rejects a request the funding key must never sign: wrong mode, an account that is not a direct
 * sub-account of this mode's parent (`<slug>.tendr.near` / `<slug>.tendr.testnet`), an init
 * pointing at another mode's intents contract, or a live account carrying a testnet admin.
 */
export function assertProvisionable(p: ProvisionParams, scope: ProvisionScope): void {
  if (p.livemode !== scope.livemode) {
    throw new Error(`provisioning livemode=${p.livemode} on a livemode=${scope.livemode} client`);
  }
  const suffix = `.${scope.parentAccountId}`;
  const label = p.accountId.endsWith(suffix) ? p.accountId.slice(0, -suffix.length) : '';
  if (!LABEL.test(label) || p.accountId.length > 64) {
    throw new Error(
      `account ${p.accountId} is not a direct sub-account of ${scope.parentAccountId}`,
    );
  }
  if (p.init.intents_contract !== scope.intentsContractId) {
    throw new Error(
      `init intents_contract ${p.init.intents_contract} is not ${scope.intentsContractId}`,
    );
  }
  if (scope.livemode && p.init.testnet_admin !== null) {
    throw new Error('a live merchant account must not have a testnet_admin');
  }
}

export interface FundingCaps {
  perAccountYocto: bigint;
  dailyYocto: bigint;
}

/** One advisory-lock key per mode, so live and test provisioning never block each other. */
const FUNDING_LOCK = { live: 0x74656e6472_01n, test: 0x74656e6472_00n } as const; // "tendr"

type Db = PrismaClient | Prisma.TransactionClient;

/** yoctoNEAR recorded as `funding.spent` in `livemode` during the last 24 hours. */
export async function fundingSpentLast24h(db: Db, livemode: boolean): Promise<bigint> {
  const [row] = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM((payload->>'amountYocto')::numeric), 0)::text AS total
    FROM events
    WHERE type = 'funding.spent'
      AND livemode = ${livemode}
      AND created_at > now() - interval '24 hours'`;
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
 * Wraps a NearClient so `provisionAccount` spends within the caps. The spend is reserved — a
 * `funding.spent` event on the provisioned merchant — in a transaction holding the mode's
 * advisory lock before anything is signed, so concurrent provisionings cannot both pass the
 * daily cap. A provisioning that later fails keeps its reservation: the cap errs on the side
 * of spending less.
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
  accessKeys: NearClient['accessKeys'] = (...args) => this.inner.accessKeys(...args);

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
    await this.db.$transaction(async (tx) => {
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
      await recordEvent(
        tx,
        { merchantId: p.merchantId, livemode: p.livemode },
        {
          aggregateType: 'near_account',
          aggregateId: p.accountId,
          type: 'funding.spent',
          payload: { accountId: p.accountId, amountYocto: amount.toString() },
        },
      );
    });
    return this.inner.provisionAccount(p);
  }
}
