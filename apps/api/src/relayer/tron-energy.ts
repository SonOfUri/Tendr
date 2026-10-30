// Just-in-time energy for gasless Tron payments (project 5a, spec §2.3 Tron; rulings T9-b, T9-d,
// T9-e): `gas-tron` lends the shopper just enough energy (and bandwidth, if the shopper's free
// bandwidth will not cover it) for ONE `approve`, broadcasts the shopper's signed approve itself,
// and takes the resources back with `undelegateResource`.
//
//   when      only at submit, after the approve passed every check (fee_limit exactly as issued,
//             the USDT balance covers amount + fee, the approve's simulation does not revert),
//             the session's and the wallet's limits, at most 3 funded approvals per address per
//             UTC day, and the claim (an open session with no live delegation and no other
//             approval of the wallet that could still pay). Never at prepare.
//   how much  the approve's energy estimate (`triggerconstantcontract` from the shopper) + 20 %,
//             less the energy the shopper already has, turned into staked TRX at the network's
//             current energy-per-TRX; bandwidth likewise when free + own bandwidth is short. A
//             delegation is lock-free (Stake 2.0 `lock = false`), so it can be undelegated at once.
//   ledger    `tron_delegations`, one row per delegation, written before the delegate transaction
//             is broadcast (its txid known); `tron_approvals` the approve it funds.
//   reclaim   `pollTronEnergy` (worker): once the approve's outcome is final, or ten minutes after
//             the delegation (whichever first), `gas-tron` sends `undelegateResource` for the same
//             balance; an undelegation that fails or can no longer land is retried; one the chain
//             shows nothing left to undelegate for is done. All state is in the rows: idempotent
//             across restarts.
//
// Cost model (ruling T9-e). Energy is valued at the network's burn price (`getEnergyFee`, sun per
// unit) whether it comes from `gas-tron`'s stake, a delegation, or TRX burned; staked and free
// bandwidth is treated as free (it regenerates daily); TRX actually burned (`fee`) counts as is.
//   - `gas-tron`'s own transactions (delegate, undelegate, payWithApproval): fee + energy × price.
//   - The approve's loan: the lent energy actually consumed, by the approve or by anything else
//     the shopper sent with it: the receiver's `EnergyUsed` is read when the loan is planned and
//     again just before the reclaim, and the difference (at most what was lent) counts, or the
//     approve's receipt if that shows more. Until it is measured: the receipt, or without one ALL
//     the energy lent (undelegating hands any usage to `gas-tron`).
//   - Exposure: the most a loan can cost (all energy lent × price) is recorded as Tendr's
//     (`sponsor = tendr`, recognised at once) before anything is lent, so the daily loss cap
//     bounds it; the row is set to the actual unrecovered cost when the approval closes.
//   - Lending unused energy for minutes costs nothing: undelegation returns what was not used.
// An approval's cost (delegate transactions + the approve) is added to its payment's cost when
// `payWithApproval` is broadcast (the quote's estimate covers approve + payment); a cost no payment
// carries (the approve failed, or no payment followed) and any undelegation fee are recorded as
// Tendr's own (`sponsor = tendr`, recognised at once, counted by the daily loss cap).
import type { Prisma, TronApproval, TronDelegation } from '@prisma/client';
import { env } from '../env.js';
import { nativeUsd } from '../gas/fees.js';
import { getKeyVault } from '../keyvault/index.js';
import type { KeyVault } from '../keyvault/types.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { MIN_RELAY_WINDOW_MS } from './submissions.js';
import {
  TRON_REJECTED_CODES,
  TronCallReverted,
  TronHttp,
  type TronApi,
  type TronTxInfo,
} from './tron-rpc.js';
import {
  allowanceParameter,
  approveData,
  refBlockOf,
  signGasTron,
  tronAddressOfPublicKey,
  type GasTronPolicy,
  type TronResource,
} from './tron-tx.js';

/** A delegation is reclaimed this long after it was made at the latest (ruling T9-d). */
export const TRON_RECLAIM_AFTER_MS = 10 * 60_000;
/** "Can no longer land": two looks this far apart, both past the expiration at the solid head. */
export const TRON_EXPIRY_CONFIRM_MS = 15_000;
/** Expiration of `gas-tron`'s own transactions. */
export const TRON_TX_TTL_MS = 60_000;
/** Headroom on the approve's energy estimate. */
export const TRON_APPROVE_ENERGY_MARGIN_PCT = 20n;
/** An approve estimated above this much energy is not funded (a USDT approve needs ~30–50k). */
export const TRON_MAX_APPROVE_ENERGY = 100_000n;
/**
 * The most TRX (sun) one delegation may lend (`gas-tron` signing guard): the largest approve
 * funded (TRON_MAX_APPROVE_ENERGY + margin = 120k energy) at ~10 energy per staked TRX is ~12k TRX.
 */
export const TRON_MAX_DELEGATION_SUN = 20_000_000_000n;
/** Approvals funded with lent resources per receiving address per UTC day. */
export const TRON_DELEGATIONS_PER_ADDRESS_PER_DAY = 3;
/** A pending approval with fewer delegation rows than planned this long after its claim failed. */
export const TRON_ORPHAN_APPROVAL_MS = 2 * 60_000;
/** fee_limit of the shopper's approve (sun): covers the funded energy at the burn price. */
export const TRON_APPROVE_FEE_LIMIT_SUN = 30_000_000n;
/** fee_limit of `gas-tron`'s payWithApproval, and the most the signing guard allows. */
export const TRON_PAYMENT_FEE_LIMIT_SUN = 100_000_000n;
export const TRON_MAX_FEE_LIMIT_SUN = 150_000_000n;
/** An issued TendrPayment is treated as runnable until this long after its deadline. */
export const TRON_DEADLINE_MARGIN_MS = 60_000;
/** Bytes a transaction costs beyond its raw data (signature, envelope, result). */
const TX_BANDWIDTH_OVERHEAD = 140n;
const SUN = 1_000_000n;

const unavailable = () =>
  new AppError('PROVIDER_UNAVAILABLE', 'Gasless payments are unavailable; try again', 503);

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/** The Tron forwarder (`TRON_FORWARDER_ADDRESS`), or null: gasless Tron is then unavailable. */
export function tronForwarderAddress(): string | null {
  return env().TRON_FORWARDER_ADDRESS ?? null;
}

const addresses = new Map<string, string>();

async function keyAddress(kv: KeyVault, key: 'gas-tron' | 'gas-fees-tron'): Promise<string> {
  const hit = addresses.get(key);
  if (hit) return hit;
  const { curve, raw } = await kv.publicKey(key);
  if (curve !== 'secp256k1') throw new Error(`${key} is not a secp256k1 key`);
  const a = tronAddressOfPublicKey(raw);
  addresses.set(key, a);
  return a;
}

/** `gas-tron`'s Tron address (pays energy for payWithApproval; lends energy to shoppers). */
export const gasTronAddress = (kv: KeyVault = getKeyVault()) => keyAddress(kv, 'gas-tron');
/** Tendr's Tron gas-fee address: the `gas-fees-tron` key (ruling T9-a). */
export const tronGasFeeAddress = (kv: KeyVault = getKeyVault()) => keyAddress(kv, 'gas-fees-tron');

export async function gasTronPolicy(kv: KeyVault = getKeyVault()): Promise<GasTronPolicy> {
  const forwarder = tronForwarderAddress();
  if (!forwarder) throw new Error('TRON_FORWARDER_ADDRESS is not set');
  return {
    gasTron: await gasTronAddress(kv),
    forwarder,
    maxFeeLimitSun: TRON_MAX_FEE_LIMIT_SUN,
    maxDelegationSun: TRON_MAX_DELEGATION_SUN,
  };
}

let liveApi: TronApi | null = null;
/** The live Tron API (`TRON_RPC_URL`). */
export function tronApi(): TronApi {
  liveApi ??= new TronHttp();
  return liveApi;
}

/** Drops cached state (tests). */
export function resetTronEnergy(): void {
  addresses.clear();
  liveApi = null;
}

export interface EnergyDeps {
  api: TronApi;
  kv: KeyVault;
  now: Date;
}

/** Builds and signs a `gas-tron` transaction against the current head. */
export async function gasTronTx(
  deps: EnergyDeps,
  contract: Parameters<typeof signGasTron>[1]['contract'],
  opts: { expiration?: Date; feeLimit?: bigint } = {},
) {
  const head = await deps.api.nowBlock(false);
  const expiration = opts.expiration ?? new Date(deps.now.getTime() + TRON_TX_TTL_MS);
  const signed = await signGasTron(
    deps.kv,
    {
      ref: refBlockOf(head.id),
      expiration: BigInt(expiration.getTime()),
      timestamp: BigInt(deps.now.getTime()),
      feeLimit: opts.feeLimit ?? 0n,
      contract,
    },
    await gasTronPolicy(deps.kv),
  );
  return { ...signed, expiration };
}

// ---------------------------------------------------------------------------------------------
// How much to lend
// ---------------------------------------------------------------------------------------------

export interface DelegationNeed {
  resource: TronResource;
  /** Resource units the balance gives at today's network ratio (≥ the shortfall). */
  units: bigint;
  balanceSun: bigint;
  /** Energy: the receiver's `EnergyUsed` when the loan was planned (consumption is measured from it). */
  usedBefore?: bigint;
}

const wouldRevert = () =>
  new AppError(
    'GASLESS_SUBMIT_FAILED',
    'This approval would fail on chain (check the token balance and any earlier approval)',
    409,
    { reason: 'approve_would_revert' },
  );

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const positive = (a: bigint) => (a > 0n ? a : 0n);

/**
 * What `gas-tron` must lend `wallet` for its approve of `value` to `spender` on `token` (raw data
 * `rawBytes` long): energy (estimate + margin, less what the wallet has) and, if its free and own
 * bandwidth is short, bandwidth. 503 when the estimate is unusable or `gas-tron` cannot lend it.
 */
export async function delegationsFor(
  api: TronApi,
  approve: { wallet: string; token: string; spender: string; value: bigint; rawBytes: number },
  gasTron: string,
): Promise<DelegationNeed[]> {
  let estimate: bigint;
  try {
    const param = Buffer.from(approveData(approve.spender, approve.value).subarray(4)).toString(
      'hex',
    );
    estimate = (
      await api.constantCall(approve.wallet, approve.token, 'approve(address,uint256)', param)
    ).energyUsed;
  } catch (err) {
    // The simulation reverted: the approve would fail on chain; never lend energy for it.
    if (err instanceof TronCallReverted) throw wouldRevert();
    log('warn', 'tron gasless: approve estimate unavailable', { err: String(err) });
    throw unavailable();
  }
  if (estimate <= 0n || estimate > TRON_MAX_APPROVE_ENERGY) {
    log('error', 'tron gasless: unexpected approve energy estimate', {
      estimate: estimate.toString(),
    });
    throw unavailable();
  }
  const r = await api.resources(approve.wallet);
  const needs: DelegationNeed[] = [];
  const energy = positive(
    ceilDiv(estimate * (100n + TRON_APPROVE_ENERGY_MARGIN_PCT), 100n) -
      positive(r.energyLimit - r.energyUsed),
  );
  if (energy > 0n) {
    if (r.totalEnergyLimit <= 0n || r.totalEnergyWeight <= 0n) throw unavailable();
    const trx = ceilDiv(energy * r.totalEnergyWeight, r.totalEnergyLimit);
    const units = (trx * r.totalEnergyLimit) / r.totalEnergyWeight;
    needs.push({
      resource: 'energy',
      units,
      balanceSun: (trx > 0n ? trx : 1n) * SUN,
      usedBefore: r.energyUsed,
    });
  }
  const bytes = BigInt(approve.rawBytes) + TX_BANDWIDTH_OVERHEAD;
  const bandwidth = positive(
    bytes - positive(r.freeNetLimit - r.freeNetUsed) - positive(r.netLimit - r.netUsed),
  );
  if (bandwidth > 0n) {
    if (r.totalNetLimit <= 0n || r.totalNetWeight <= 0n) throw unavailable();
    const trx = ceilDiv(bandwidth * r.totalNetWeight, r.totalNetLimit);
    const units = (trx * r.totalNetLimit) / r.totalNetWeight;
    needs.push({ resource: 'bandwidth', units, balanceSun: (trx > 0n ? trx : 1n) * SUN });
  }
  for (const n of needs) {
    if (n.balanceSun > TRON_MAX_DELEGATION_SUN) throw unavailable();
    const max = await api.canDelegateMaxSun(gasTron, n.resource);
    if (max < n.balanceSun) {
      log('error', 'tron gasless: gas-tron cannot lend enough', {
        resource: n.resource,
        need: n.balanceSun.toString(),
      });
      throw unavailable();
    }
  }
  return needs;
}

// ---------------------------------------------------------------------------------------------
// Delegating, and sending the approve
// ---------------------------------------------------------------------------------------------

/** What `gas-tron`'s own transaction cost (sun): TRX burned + its own energy at the burn price. */
export const ownTxCostSun = (info: TronTxInfo, price: bigint) =>
  info.fee + info.energyUsage * price;

/**
 * Lends `needs` to the approval's wallet: each delegation is signed, recorded (txid first) and
 * broadcast. Returns false when the node refused one (no resources moved by it; the rest are
 * reclaimed by the poller); a delegation whose broadcast outcome is unknown stays `delegating`.
 */
export async function delegate(
  deps: EnergyDeps,
  approval: Pick<TronApproval, 'id' | 'livemode' | 'wallet'>,
  needs: DelegationNeed[],
): Promise<boolean> {
  const gasTron = await gasTronAddress(deps.kv);
  for (const n of needs) {
    const tx = await gasTronTx(deps, {
      type: 'delegate',
      owner: gasTron,
      receiver: approval.wallet,
      resource: n.resource,
      balance: n.balanceSun,
    });
    const id = newId('tdl');
    // Recorded before the broadcast; the database refuses a second live delegation per receiver.
    await prisma.tronDelegation.create({
      data: {
        id,
        approvalId: approval.id,
        livemode: approval.livemode,
        resource: n.resource,
        receiver: approval.wallet,
        balanceSun: n.balanceSun,
        units: n.units,
        status: 'delegating',
        delegateTxId: tx.txId,
        delegateTx: tx.signedHex,
        delegateExpiration: tx.expiration,
        ...(n.usedBefore !== undefined ? { energyUsedBefore: n.usedBefore } : {}),
      },
    });
    let res;
    try {
      res = await deps.api.broadcastHex(tx.signedHex);
    } catch (err) {
      log('warn', 'tron gasless: delegation broadcast outcome unknown', { id, err: String(err) });
      continue;
    }
    if (!res.ok && TRON_REJECTED_CODES.has(res.code)) {
      await prisma.tronDelegation.updateMany({
        where: { id, status: 'delegating' },
        data: { status: 'failed', lastError: `${res.code} ${res.message}`.slice(0, 500) },
      });
      log('error', 'tron gasless: delegation refused', { id, code: res.code });
      return false;
    }
  }
  return true;
}

/**
 * Whether every delegation of the approval is in effect ('ready'), one never will be ('failed'),
 * or some are still landing ('pending'). Looks each `delegating` one up on the fullnode.
 */
export async function delegationsReady(
  deps: EnergyDeps,
  approvalId: string,
): Promise<'ready' | 'failed' | 'pending'> {
  const rows = await prisma.tronDelegation.findMany({ where: { approvalId } });
  const approval = await prisma.tronApproval.findUnique({
    where: { id: approvalId },
    select: { plannedDelegations: true, createdAt: true },
  });
  // Rows missing (the claim's process stopped before recording them): never send the approve
  // without its energy (it would burn the shopper's own TRX).
  if (approval && rows.length < approval.plannedDelegations) {
    return deps.now.getTime() - approval.createdAt.getTime() >= TRON_ORPHAN_APPROVAL_MS
      ? 'failed'
      : 'pending';
  }
  let pending = false;
  for (const d of rows) {
    if (d.status === 'failed') return 'failed';
    if (d.status !== 'delegating') continue;
    const info = await deps.api.txInfo(d.delegateTxId, false);
    if (!info) {
      pending = true;
      continue;
    }
    if (!(await settleDelegate(deps, d, info))) return 'failed';
  }
  return pending ? 'pending' : 'ready';
}

/** A delegate transaction was mined: `delegated` (true), or `failed`. */
async function settleDelegate(deps: EnergyDeps, d: TronDelegation, info: TronTxInfo) {
  const ok = info.result !== 'FAILED';
  const price = await deps.api.energyPrice();
  await prisma.tronDelegation.updateMany({
    where: { id: d.id, status: 'delegating' },
    data: ok
      ? {
          status: 'delegated',
          delegatedAt: new Date(info.blockTimeStamp || deps.now.getTime()),
          delegateFeeSun: ownTxCostSun(info, price),
          expiredSeenAt: null,
        }
      : {
          status: 'failed',
          delegateFeeSun: ownTxCostSun(info, price),
          lastError: 'delegate failed',
        },
  });
  return ok;
}

/**
 * Broadcasts the approval's signed approve (its txid is already recorded): `submitted`, or
 * `failed` when the node refused it (it never executes). Unknown → `submitted` (re-sent later).
 */
export async function sendApprove(
  deps: EnergyDeps,
  approval: Pick<TronApproval, 'id' | 'signedTx'>,
): Promise<'submitted' | 'refused'> {
  // Never broadcast an approve the record no longer expects (failed or expired meanwhile).
  const now = await prisma.tronApproval.findUnique({
    where: { id: approval.id },
    select: { status: true },
  });
  if (now?.status !== 'pending') return now?.status === 'failed' ? 'refused' : 'submitted';
  let res;
  try {
    res = await deps.api.broadcastHex(approval.signedTx);
  } catch (err) {
    log('warn', 'tron gasless: approve broadcast outcome unknown', {
      approvalId: approval.id,
      err: String(err),
    });
    res = null;
  }
  if (res && !res.ok && TRON_REJECTED_CODES.has(res.code)) {
    await failApproval(deps, approval.id, `${res.code} ${res.message}`, null);
    return 'refused';
  }
  await prisma.tronApproval.updateMany({
    where: { id: approval.id, status: 'pending' },
    data: { status: 'submitted', broadcastAt: deps.now },
  });
  return 'submitted';
}

/**
 * The approval failed (never sent, refused, reverted or expired). Its cost: the delegations'
 * own fees + the delegated energy the approve used (`info`), or all of it without a receipt.
 */
export async function failApproval(
  deps: EnergyDeps,
  approvalId: string,
  reason: string,
  info: TronTxInfo | null,
): Promise<void> {
  const costSun = await approvalCostSun(deps, approvalId, info ? info.energyUsage : null, false);
  await prisma.tronApproval.updateMany({
    where: { id: approvalId, status: { in: ['pending', 'submitted'] } },
    data: {
      status: 'failed',
      lastError: reason.slice(0, 500),
      costSun,
      ...(info ? { energyUsed: info.energyUsage } : {}),
    },
  });
}

/**
 * See the cost model in the file header. `receiptEnergy`: the approve's receipt `energy_usage`
 * (null: no receipt). `succeeded`: the approve has a SUCCESS receipt. When it did not succeed
 * (failed, reverted, never landed) the whole lent energy is the cost (Task 9 ruling: the shopper
 * may have spent it on something else, and EnergyUsed decays at read time, so a measured delta can
 * understate it). Otherwise, once the receiver's energy use has been read before the reclaim, the
 * lent energy actually consumed (by anything) counts when it is more than the receipt shows.
 */
async function approvalCostSun(
  deps: EnergyDeps,
  approvalId: string,
  receiptEnergy: bigint | null,
  succeeded: boolean,
): Promise<bigint> {
  const rows = await prisma.tronDelegation.findMany({ where: { approvalId } });
  const lent = rows.filter((d) => d.status !== 'failed' && d.resource === 'energy');
  const energyLent = lent.reduce((t, d) => t + d.units, 0n);
  const fees = rows.reduce((t, d) => t + (d.delegateFeeSun ?? 0n), 0n);
  if (energyLent === 0n) return fees;
  if (!succeeded) return fees + energyLent * (await deps.api.energyPrice());
  const cap = (x: bigint) => (x < energyLent ? x : energyLent);
  const fromReceipt = receiptEnergy === null ? null : cap(receiptEnergy);
  const measuredRows = lent.filter(
    (d) => d.energyUsedBefore !== null && d.energyUsedAfter !== null,
  );
  let used: bigint;
  if (measuredRows.length > 0) {
    const measured = cap(
      measuredRows.reduce((t, d) => {
        const delta = positive(d.energyUsedAfter! - d.energyUsedBefore!);
        return t + (delta < d.units ? delta : d.units);
      }, 0n),
    );
    used = fromReceipt !== null && fromReceipt > measured ? fromReceipt : measured;
  } else {
    // Not measured yet: the receipt, or (none) everything lent, the upper bound.
    used = fromReceipt ?? energyLent;
  }
  return fees + used * (await deps.api.energyPrice());
}

/**
 * Recognises the most the approval's loans can cost (all energy lent, at the burn price) as
 * Tendr's at once, before anything is lent, so the daily loss cap bounds the exposure; the row is
 * set to the actual unrecovered cost when the approval closes. Throws 503 when it cannot be priced.
 */
export async function recordProvisionalCost(
  deps: EnergyDeps,
  approval: Pick<TronApproval, 'id' | 'merchantId' | 'livemode' | 'sessionId' | 'quoteId' | 'txId'>,
  needs: DelegationNeed[],
): Promise<void> {
  const energy = needs.filter((n) => n.resource === 'energy').reduce((t, n) => t + n.units, 0n);
  if (energy === 0n) return;
  let costUsd: string;
  let sun: bigint;
  try {
    sun = energy * (await deps.api.energyPrice());
    costUsd = await nativeUsd('tron', sun, approval.livemode);
  } catch (err) {
    log('warn', 'tron gasless: delegation cost unpriced', { err: String(err) });
    throw unavailable();
  }
  const id = newId('gas');
  await prisma.$transaction(async (tx) => {
    await tx.gasSponsorship.create({
      data: {
        id,
        merchantId: approval.merchantId,
        livemode: approval.livemode,
        sessionId: approval.sessionId,
        chain: 'tron',
        method: 'forwarder',
        provider: 'gas-tron',
        sponsor: 'tendr',
        status: 'confirmed',
        txHash: approval.txId,
        costUsd,
        lossRecognizedAt: deps.now,
        paymasterData: {
          kind: 'tron_approval',
          approval_id: approval.id,
          quote_id: approval.quoteId,
          sun: sun.toString(),
          provisional: true,
        },
      },
    });
    await tx.tronApproval.update({
      where: { id: approval.id },
      data: { provisionalCostId: id },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Can an approval still pay? (the double-payment rule, ruling T9-c)
// ---------------------------------------------------------------------------------------------

/**
 * Whether the approval's allowance could still be spent by a TendrPayment: its approve may still
 * land; or it is confirmed and its quote's payment is in flight, or an issued TendrPayment is
 * within its deadline (+ margin) and not executed, or the quote can still be relayed (a
 * TendrPayment may still be issued for it).
 */
export async function approvalCanStillPay(
  a: Pick<TronApproval, 'status' | 'quoteId' | 'merchantId' | 'livemode' | 'paymentDeadline'>,
  now: Date,
): Promise<boolean> {
  if (a.status === 'pending' || a.status === 'submitted') return true;
  if (a.status !== 'confirmed') return false;
  const scope = { merchantId: a.merchantId, livemode: a.livemode };
  const payments = await prisma.gasSponsorship.findMany({
    where: { ...scope, quoteId: a.quoteId, method: 'forwarder' },
    select: { status: true },
  });
  if (payments.some((p) => p.status === 'confirmed')) return false;
  if (payments.some((p) => p.status === 'pending' || p.status === 'submitted')) return true;
  if (a.paymentDeadline) {
    return now.getTime() <= a.paymentDeadline.getTime() + TRON_DEADLINE_MARGIN_MS;
  }
  const quote = await prisma.quote.findFirst({
    where: { ...scope, id: a.quoteId },
    select: {
      supersededAt: true,
      deadline: true,
      session: { select: { status: true, expiresAt: true } },
    },
  });
  if (!quote) return false;
  return (
    !quote.supersededAt &&
    quote.deadline.getTime() - MIN_RELAY_WINDOW_MS > now.getTime() &&
    quote.session.status === 'PENDING_DEPOSIT' &&
    quote.session.expiresAt.getTime() > now.getTime()
  );
}

/** Approvals of `wallet` for other quotes whose allowance could still be spent (recent ones). */
export async function walletBlockedBy(
  db: Prisma.TransactionClient | typeof prisma,
  wallet: string,
  quoteId: string,
  now: Date,
  livemode: boolean,
): Promise<string | null> {
  const rows = await db.tronApproval.findMany({
    where: {
      wallet,
      livemode,
      quoteId: { not: quoteId },
      status: { in: ['pending', 'submitted', 'confirmed'] },
      createdAt: { gte: new Date(now.getTime() - 2 * 24 * 3600_000) },
    },
    orderBy: { createdAt: 'desc' },
  });
  for (const a of rows) if (await approvalCanStillPay(a, now)) return a.id;
  return null;
}

/** Serialises approvals and TendrPayment issuance of one wallet (inside a transaction). */
export async function lockWallet(tx: Prisma.TransactionClient, wallet: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`tendr:tron-wallet:${wallet}`}))::text`;
}

// ---------------------------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------------------------

export type Landing =
  { info: TronTxInfo } | { state: 'pending' } | { state: 'first-expired' } | { state: 'dead' };

/**
 * Where a transaction stands. Found → its info. Not found while the solidified head is at or
 * before its expiration → pending (the caller re-sends the same bytes). Past it, unknown on two
 * looks at least TRON_EXPIRY_CONFIRM_MS apart → dead (it can never land).
 */
export async function landing(
  api: TronApi,
  txId: string,
  expiration: Date,
  seenAt: Date | null,
  now: Date,
  solid: boolean,
): Promise<Landing> {
  const info = await api.txInfo(txId, solid);
  if (info) return { info };
  const head = await api.nowBlock(true);
  if (head.timestamp <= expiration.getTime()) return { state: 'pending' };
  const final = await api.txInfo(txId, true);
  if (final) return { info: final };
  if (!seenAt || now.getTime() - seenAt.getTime() < TRON_EXPIRY_CONFIRM_MS) {
    return { state: 'first-expired' };
  }
  return { state: 'dead' };
}

async function resend(api: TronApi, signedHex: string, what: string) {
  try {
    await api.broadcastHex(signedHex);
  } catch (err) {
    log('warn', 'tron gasless: re-send failed', { what, err: String(err) });
  }
}

/**
 * One pass of the energy job (worker): delegations landing, approves to send and to resolve,
 * delegations to reclaim, approvals to close. Every row visited is touched (failing rows rotate).
 * Returns how many rows changed state.
 */
export async function pollTronEnergy(
  deps: { api?: TronApi; kv?: KeyVault; now?: () => Date; livemode?: boolean } = {},
): Promise<number> {
  const livemode = deps.livemode ?? true;
  const d: EnergyDeps = {
    api: deps.api ?? tronApi(),
    kv: deps.kv ?? getKeyVault(),
    now: deps.now?.() ?? new Date(),
  };
  let changed = 0;
  const each = async <T extends { id: string }>(
    rows: T[],
    table: 'approval' | 'delegation',
    f: (r: T) => Promise<boolean>,
  ) => {
    for (const r of rows) {
      try {
        if (await f(r)) changed++;
        else await touch(table, r.id, d.now);
      } catch (err) {
        log('warn', 'tron gasless: energy job step failed', { id: r.id, err: String(err) });
        try {
          await touch(table, r.id, d.now);
        } catch {
          // The next pass retries.
        }
      }
    }
  };
  const take = 100;
  const order = { updatedAt: 'asc' } as const;

  // 1. Delegations landing.
  await each(
    await prisma.tronDelegation.findMany({
      where: { livemode, status: 'delegating' },
      orderBy: order,
      take,
    }),
    'delegation',
    (row) => resolveDelegate(d, row),
  );
  // 2. Approvals waiting for their energy: send the approve once every delegation is in effect.
  await each(
    await prisma.tronApproval.findMany({
      where: { livemode, status: 'pending' },
      orderBy: order,
      take,
    }),
    'approval',
    async (a) => {
      const ready = await delegationsReady(d, a.id);
      if (ready === 'failed') {
        await failApproval(d, a.id, 'the energy delegation failed', null);
        return true;
      }
      if (ready === 'pending') return false;
      if (a.expiration.getTime() <= d.now.getTime()) {
        await failApproval(d, a.id, 'the approve expired before its energy arrived', null);
        return true;
      }
      await sendApprove(d, a);
      return true;
    },
  );
  // 3. Approves sent: their final outcome (solidified).
  await each(
    await prisma.tronApproval.findMany({
      where: { livemode, status: 'submitted' },
      orderBy: order,
      take,
    }),
    'approval',
    (a) => resolveApprove(d, a),
  );
  // 4–5. Reclaims due, and reclaims landing.
  await each(
    await prisma.tronDelegation.findMany({
      where: { livemode, status: { in: ['delegated', 'reclaiming'] } },
      include: { approval: { select: { status: true } } },
      orderBy: order,
      take,
    }),
    'delegation',
    (row) => reclaim(d, row),
  );
  // 6. Approvals whose outcome and reclaims are final: count their cost, close them.
  await each(
    await prisma.tronApproval.findMany({
      where: { livemode, status: { in: ['confirmed', 'failed'] }, closedAt: null },
      include: { delegations: true },
      orderBy: order,
      take,
    }),
    'approval',
    (a) => closeApproval(d, a),
  );
  return changed;
}

async function touch(table: 'approval' | 'delegation', id: string, now: Date) {
  if (table === 'approval') {
    await prisma.tronApproval.updateMany({ where: { id }, data: { updatedAt: now } });
  } else {
    await prisma.tronDelegation.updateMany({ where: { id }, data: { updatedAt: now } });
  }
}

async function resolveDelegate(d: EnergyDeps, row: TronDelegation): Promise<boolean> {
  const l = await landing(
    d.api,
    row.delegateTxId,
    row.delegateExpiration,
    row.expiredSeenAt,
    d.now,
    false,
  );
  if ('info' in l) return settleDelegate(d, row, l.info).then(() => true);
  if (l.state === 'pending') {
    await resend(d.api, row.delegateTx, row.id);
    return false;
  }
  if (l.state === 'first-expired') {
    await prisma.tronDelegation.updateMany({
      where: { id: row.id, expiredSeenAt: null },
      data: { expiredSeenAt: d.now },
    });
    return false;
  }
  await prisma.tronDelegation.updateMany({
    where: { id: row.id, status: 'delegating' },
    data: { status: 'failed', lastError: 'the delegation never landed' },
  });
  return true;
}

async function resolveApprove(d: EnergyDeps, a: TronApproval): Promise<boolean> {
  const l = await landing(d.api, a.txId, a.expiration, a.expiredSeenAt, d.now, true);
  if ('info' in l) {
    const ok = l.info.result !== 'FAILED' && l.info.receiptResult === 'SUCCESS';
    if (!ok) {
      await failApproval(
        d,
        a.id,
        `the approve failed (${l.info.receiptResult ?? 'FAILED'})`,
        l.info,
      );
      return true;
    }
    const costSun = await approvalCostSun(d, a.id, l.info.energyUsage, true);
    await prisma.tronApproval.updateMany({
      where: { id: a.id, status: 'submitted' },
      data: { status: 'confirmed', energyUsed: l.info.energyUsage, costSun, expiredSeenAt: null },
    });
    return true;
  }
  if (l.state === 'pending') {
    await resend(d.api, a.signedTx, a.id);
    if (a.expiredSeenAt) {
      await prisma.tronApproval.updateMany({ where: { id: a.id }, data: { expiredSeenAt: null } });
    }
    return false;
  }
  if (l.state === 'first-expired') {
    await prisma.tronApproval.updateMany({
      where: { id: a.id, expiredSeenAt: null },
      data: { expiredSeenAt: d.now },
    });
    return false;
  }
  await failApproval(d, a.id, 'the approve never landed (expired)', null);
  return true;
}

/** Starts or follows the undelegation of a delegation that is due (see the file header). */
async function reclaim(
  d: EnergyDeps,
  row: TronDelegation & { approval: { status: string } },
): Promise<boolean> {
  const gasTron = await gasTronAddress(d.kv);
  const resource = row.resource as TronResource;
  if (row.status === 'delegated') {
    const final = row.approval.status === 'confirmed' || row.approval.status === 'failed';
    const timedOut =
      row.delegatedAt !== null &&
      d.now.getTime() - row.delegatedAt.getTime() >= TRON_RECLAIM_AFTER_MS;
    if (!final && !timedOut) return false;
    return startUndelegate(d, row, gasTron, resource);
  }
  // reclaiming
  if (!row.undelegateTxId || !row.undelegateExpiration || !row.undelegateTx) {
    return startUndelegate(d, row, gasTron, resource);
  }
  const l = await landing(
    d.api,
    row.undelegateTxId,
    row.undelegateExpiration,
    row.expiredSeenAt,
    d.now,
    true,
  );
  if ('info' in l) {
    const price = await d.api.energyPrice();
    const fee = (row.undelegateFeeSun ?? 0n) + ownTxCostSun(l.info, price);
    if (l.info.result !== 'FAILED') {
      await prisma.tronDelegation.updateMany({
        where: { id: row.id, status: 'reclaiming' },
        data: {
          status: 'reclaimed',
          reclaimedAt: d.now,
          undelegateFeeSun: fee,
          expiredSeenAt: null,
        },
      });
      return true;
    }
    // Failed: done if nothing is left delegated, else try again.
    await prisma.tronDelegation.updateMany({
      where: { id: row.id },
      data: {
        undelegateFeeSun: fee,
        undelegateTxId: null,
        undelegateTx: null,
        undelegateExpiration: null,
      },
    });
    return settleIfNothingLeft(d, row, gasTron, resource);
  }
  if (l.state === 'pending') {
    await resend(d.api, row.undelegateTx, row.id);
    return false;
  }
  if (l.state === 'first-expired') {
    await prisma.tronDelegation.updateMany({
      where: { id: row.id, expiredSeenAt: null },
      data: { expiredSeenAt: d.now },
    });
    return false;
  }
  // It can never land: a new undelegation next pass.
  await prisma.tronDelegation.updateMany({
    where: { id: row.id, status: 'reclaiming' },
    data: {
      undelegateTxId: null,
      undelegateTx: null,
      undelegateExpiration: null,
      expiredSeenAt: null,
    },
  });
  return true;
}

async function settleIfNothingLeft(
  d: EnergyDeps,
  row: TronDelegation,
  gasTron: string,
  resource: TronResource,
): Promise<boolean> {
  const left = await d.api.delegatedSun(gasTron, row.receiver, resource);
  if (left > 0n) return true;
  await prisma.tronDelegation.updateMany({
    where: { id: row.id, status: 'reclaiming' },
    data: { status: 'reclaimed', reclaimedAt: d.now },
  });
  return true;
}

/**
 * Reads the receiver's energy use just before the first reclaim (ruling I1): the lent energy it
 * consumed since the loan, by the approve or by anything else, is part of the approval's cost. A
 * final approval's cost is recomputed with it (a payment it is booked to carries what was booked;
 * any more is Tendr's at close).
 */
async function measureUse(d: EnergyDeps, row: TronDelegation): Promise<void> {
  const r = await d.api.resources(row.receiver);
  await prisma.tronDelegation.updateMany({
    where: { id: row.id, energyUsedAfter: null },
    data: { energyUsedAfter: r.energyUsed },
  });
  const a = await prisma.tronApproval.findUnique({
    where: { id: row.approvalId },
    select: { status: true, energyUsed: true },
  });
  if (a && (a.status === 'confirmed' || a.status === 'failed')) {
    const costSun = await approvalCostSun(
      d,
      row.approvalId,
      a.energyUsed,
      a.status === 'confirmed',
    );
    await prisma.tronApproval.updateMany({
      where: { id: row.approvalId, closedAt: null },
      data: { costSun },
    });
  }
}

async function startUndelegate(
  d: EnergyDeps,
  row: TronDelegation,
  gasTron: string,
  resource: TronResource,
): Promise<boolean> {
  if (resource === 'energy' && row.energyUsedAfter === null) await measureUse(d, row);
  // Only what is still delegated (a previous attempt may have landed unseen).
  const left = await d.api.delegatedSun(gasTron, row.receiver, resource);
  const balance = left < row.balanceSun ? left : row.balanceSun;
  if (balance <= 0n) {
    await prisma.tronDelegation.updateMany({
      where: { id: row.id, status: { in: ['delegated', 'reclaiming'] } },
      data: { status: 'reclaimed', reclaimedAt: d.now },
    });
    return true;
  }
  const tx = await gasTronTx(d, {
    type: 'undelegate',
    owner: gasTron,
    receiver: row.receiver,
    resource,
    balance,
  });
  // Recorded before the broadcast.
  const { count } = await prisma.tronDelegation.updateMany({
    where: {
      id: row.id,
      status: { in: ['delegated', 'reclaiming'] },
      undelegateTxId: row.undelegateTxId,
    },
    data: {
      status: 'reclaiming',
      undelegateTxId: tx.txId,
      undelegateTx: tx.signedHex,
      undelegateExpiration: tx.expiration,
      expiredSeenAt: null,
    },
  });
  if (count !== 1) return false;
  let res;
  try {
    res = await d.api.broadcastHex(tx.signedHex);
  } catch (err) {
    log('warn', 'tron gasless: undelegation outcome unknown', { id: row.id, err: String(err) });
    return true;
  }
  if (!res.ok && TRON_REJECTED_CODES.has(res.code)) {
    log('warn', 'tron gasless: undelegation refused', { id: row.id, code: res.code });
    await prisma.tronDelegation.updateMany({
      where: { id: row.id, undelegateTxId: tx.txId },
      data: {
        undelegateTxId: null,
        undelegateTx: null,
        undelegateExpiration: null,
        lastError: `${res.code} ${res.message}`.slice(0, 500),
      },
    });
    return settleIfNothingLeft(d, { ...row, status: 'reclaiming' }, gasTron, resource);
  }
  return true;
}

/**
 * Closes an approval whose outcome is final and whose delegations are all reclaimed (or never
 * took effect): any cost no payment carries is recorded as Tendr's. A confirmed approval whose
 * cost is not yet carried waits while its quote can still be paid (the payment will carry it).
 */
async function closeApproval(
  d: EnergyDeps,
  a: TronApproval & { delegations: TronDelegation[] },
): Promise<boolean> {
  if (a.delegations.some((x) => x.status !== 'reclaimed' && x.status !== 'failed')) return false;
  if (
    a.status === 'confirmed' &&
    a.costBookedTo === null &&
    (await approvalCanStillPay(a, d.now))
  ) {
    return false;
  }
  // Booked to a payment still in flight: it may never land and hand the cost back.
  if (a.costBookedTo && !a.costBookedTo.startsWith('tendr:') && a.costBookedTo !== 'none') {
    const sp = await prisma.gasSponsorship.findUnique({
      where: { id: a.costBookedTo },
      select: { status: true },
    });
    if (sp?.status === 'pending' || sp?.status === 'submitted') return false;
  }
  // Tendr's part: undelegation fees (never carried by a payment), and the approval's cost when no
  // payment carries it, or what was measured beyond what the payment carries.
  const undelegateSun = a.delegations.reduce((t, x) => t + (x.undelegateFeeSun ?? 0n), 0n);
  const tendrPart = (f: Pick<TronApproval, 'costBookedTo' | 'costSun' | 'costBookedSun'>) =>
    undelegateSun +
    (f.costBookedTo === null
      ? (f.costSun ?? 0n)
      : positive((f.costSun ?? 0n) - (f.costBookedSun ?? f.costSun ?? 0n)));
  const priced = async (sun: bigint): Promise<string | null> => {
    if (sun === 0n) return '0';
    try {
      return await nativeUsd('tron', sun, a.livemode);
    } catch (err) {
      log('warn', 'tron gasless: approval cost unpriced', { approvalId: a.id, err: String(err) });
      return null;
    }
  };
  const expected = tendrPart(a);
  const expectedUsd = await priced(expected);
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.tronApproval.findUniqueOrThrow({ where: { id: a.id } });
    if (fresh.closedAt) return false;
    const tendrSun = tendrPart(fresh);
    // Priced outside the transaction; re-priced only if a payment booked it meanwhile.
    const costUsd = tendrSun === expected ? expectedUsd : await priced(tendrSun);
    const data = {
      kind: 'tron_approval',
      approval_id: a.id,
      quote_id: a.quoteId,
      sun: tendrSun.toString(),
    };
    let rowId: string | null = fresh.provisionalCostId;
    if (rowId) {
      // The provisional maximum becomes the actual (0 when a payment carries it all). Unpriced:
      // the provisional amount stays (errs high).
      await tx.gasSponsorship.updateMany({
        where: { id: rowId, sponsor: 'tendr' },
        data: { ...(costUsd !== null ? { costUsd } : {}), paymasterData: data },
      });
    } else if (tendrSun > 0n) {
      rowId = newId('gas');
      await tx.gasSponsorship.create({
        data: {
          id: rowId,
          merchantId: a.merchantId,
          livemode: a.livemode,
          sessionId: a.sessionId,
          chain: 'tron',
          method: 'forwarder',
          provider: 'gas-tron',
          sponsor: 'tendr',
          status: 'confirmed',
          txHash: a.txId,
          ...(costUsd ? { costUsd } : {}),
          lossRecognizedAt: d.now,
          paymasterData: data,
        },
      });
    }
    await tx.tronApproval.updateMany({
      where: { id: a.id, closedAt: null },
      data: {
        closedAt: d.now,
        costBookedTo: fresh.costBookedTo ?? (rowId ? `tendr:${rowId}` : 'none'),
      },
    });
    return true;
  });
}

/** The allowance `owner` gave `spender` on `token` (live read). */
export async function allowanceOf(api: TronApi, token: string, owner: string, spender: string) {
  const r = await api.constantCall(
    owner,
    token,
    'allowance(address,address)',
    allowanceParameter(owner, spender),
  );
  return BigInt(`0x${r.result || '0'}`);
}
