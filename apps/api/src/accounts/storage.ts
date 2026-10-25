// Contract storage of merchant accounts (R35).
//
// Proposals, approvals, removed-address tombstones and limit windows are stored by the account's
// own contract and paid from the account's own NEAR. Nothing is pruned yet, so the account's free
// balance shrinks with every proposal; once it cannot cover a write, every call fails with
// LackBalanceForState, cancels and recovery cancels included. The watcher therefore checks each
// account on every reconcile and, when the free balance would cover fewer than
// `HEADROOM_PROPOSALS` more proposals, sends a fixed top-up from `funding-near` through the capped
// client (a `funding.topup` event, counted against FUNDING_DAILY_CAP_YOCTO). If the cap blocks it,
// the account is flagged (`storage_low_at`, event `merchant_account.storage_low`) and the
// dashboard's account home shows a warning.
import type { MerchantAccount } from '@prisma/client';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { nearClient, type AccountState } from '../near/client.js';
import { FundingCapError } from '../near/provision.js';

/**
 * Storage one proposal leaves behind, create -> approve -> execute, rounded up. Measured by the
 * sandbox test `storage_per_proposal` (onchain/merchant-account/tests/sandbox.rs): 401-586 bytes
 * depending on the action; that test fails if any measured proposal exceeds this.
 */
export const STORAGE_BYTES_PER_PROPOSAL = 600n;
/** Top up once the free balance covers fewer proposals than this. */
export const HEADROOM_PROPOSALS = 50n;
/** NEAR's storage price: 10^19 yoctoNEAR per byte (1 NEAR per 100 kB). */
export const YOCTO_PER_BYTE = 10n ** 19n;
/** Free balance below which the account is topped up: 50 x 600 bytes = 0.3 NEAR. */
export const STORAGE_LOW_THRESHOLD_YOCTO =
  STORAGE_BYTES_PER_PROPOSAL * HEADROOM_PROPOSALS * YOCTO_PER_BYTE;
/** At most one top-up per account in this window (a slow or unknown one is not doubled). */
export const TOPUP_COOLDOWN_MS = 10 * 60_000;

export const STORAGE_LOW_EVENT = 'merchant_account.storage_low';

/** Balance not locked up by the account's storage, in yoctoNEAR (negative when short). */
export function freeBalance(s: AccountState): bigint {
  return s.amountYocto + s.lockedYocto - s.storageUsageBytes * YOCTO_PER_BYTE;
}

export type StorageCheck = 'ok' | 'topped_up' | 'cooldown' | 'blocked' | 'failed';

/**
 * Tops the account up from `funding-near` when its free balance is below the threshold. Never
 * throws for a blocked or failed top-up (the reconcile goes on); returns what happened.
 */
export async function ensureStorageFunds(
  account: Pick<MerchantAccount, 'id' | 'merchantId' | 'livemode' | 'nearAccountId'> & {
    storageLowAt: Date | null;
  },
): Promise<StorageCheck> {
  const client = nearClient(account.livemode);
  const state = await client.viewAccount(account.nearAccountId);
  const free = freeBalance(state);
  if (free >= STORAGE_LOW_THRESHOLD_YOCTO) {
    if (account.storageLowAt) await setStorageLow(account, null);
    return 'ok';
  }
  const recent = await prisma.event.findFirst({
    where: {
      type: 'funding.topup',
      aggregateId: account.nearAccountId,
      livemode: account.livemode,
      createdAt: { gt: new Date(Date.now() - TOPUP_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recent) return 'cooldown';

  const amountYocto = env().MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO;
  try {
    const result = await client.topUpAccount({
      merchantId: account.merchantId,
      livemode: account.livemode,
      accountId: account.nearAccountId,
      amountYocto,
    });
    if (result.status !== 'success') {
      log('warn', 'storage top-up failed on chain', {
        accountId: account.id,
        txHash: result.txHash,
        failure: result.failure,
      });
      return 'failed';
    }
    log('info', 'merchant account topped up for storage', {
      accountId: account.id,
      freeYocto: free.toString(),
      amountYocto: amountYocto.toString(),
      txHash: result.txHash,
    });
    if (account.storageLowAt) await setStorageLow(account, null);
    return 'topped_up';
  } catch (err) {
    if (err instanceof FundingCapError) {
      if (!account.storageLowAt) {
        await setStorageLow(account, new Date(), {
          freeYocto: free.toString(),
          thresholdYocto: STORAGE_LOW_THRESHOLD_YOCTO.toString(),
          reason: err.message,
        });
      }
      log('warn', 'storage top-up blocked by the funding cap', {
        accountId: account.id,
        err: err.message,
      });
      return 'blocked';
    }
    log('warn', 'storage top-up failed', { accountId: account.id, err: String(err) });
    return 'failed';
  }
}

async function setStorageLow(
  account: Pick<MerchantAccount, 'id' | 'merchantId' | 'livemode' | 'nearAccountId'>,
  at: Date | null,
  details?: object,
): Promise<void> {
  const ctx = { merchantId: account.merchantId, livemode: account.livemode };
  await tenantTransaction(ctx, async (tx) => {
    await tx.merchantAccount.updateMany({
      where: { id: account.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
      data: { storageLowAt: at },
    });
    if (at) {
      await recordEvent(tx, ctx, {
        aggregateType: 'merchant_account',
        aggregateId: account.id,
        type: STORAGE_LOW_EVENT,
        payload: { nearAccountId: account.nearAccountId, ...details },
      });
    }
  });
}
