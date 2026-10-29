// Gas-fee sweep (project 5a, Task 12, spec §2.5): converts the shopper-paid network fees collected
// on the receive-only gas-fee accounts (`gas-fees-evm|solana|near|tron`) into USDC on NEAR,
// credited to Tendr's fee account (TENDR_FEE_ACCOUNT_NEAR), through a 1Click swap.
//
//   planFeeSweeps(livemode, now)  per gas-fee account and token: due when its value is at least
//                                 FEE_SWEEP_THRESHOLD_USD, or (a token worth at least $1, never a
//                                 native coin) when the last executed sweep of that account and token
//                                 is 7 days old (or there is none). A failed attempt backs off 6 h.
//                                 Live mode only (ruling R12-a): test mode plans nothing. Each due
//                                 sweep is recorded as the account+token's one open plan.
//   runFeeSweep(now)              the worker job: plans, then, only with FEE_SWEEP_ENABLED=true and
//                                 TENDR_FEE_ACCOUNT_NEAR set, executes each plan; otherwise one
//                                 operator notice (per 6 h) says what is waiting and why.
//
// Executing a plan: a token sweep needs the account's own native gas for the transfer; without
// it the plan becomes `needs_gas` and operators are told (once per 6 h per account); the relayer
// never tops a gas-fee account up (ruling R12-d). Then a 1Click EXACT_INPUT quote (origin: the
// token on its chain; destination: USDC on NEAR; recipient: TENDR_FEE_ACCOUNT_NEAR; refunds to
// the gas-fee address itself, R12-b), the transport builds the one transfer to the quote's deposit
// address, `signSweep` checks those exact bytes and signs (R12-c), and the transfer is broadcast.
// A native-coin sweep (EVM, R12-k) sends only the excess above a reserve: gas for 3 future token
// sweeps at the chain's fee cap plus its own transfer. The quote must pay at least 95 % of the
// plan's USD value after slippage, and an execution is time-bounded below its lease.
//
// After the broadcast (final review m2) the row is `broadcast` until the transfer is found final
// on chain by its hash: `executed` only once confirmed, `failed` if it reverted or never landed
// (unknown to the node FEE_SWEEP_UNKNOWN_FAIL_MS after it was sent). While a `broadcast` row
// exists its account and token are not planned again (a still-pending transfer is never doubled).
// Every run reconciles `broadcast` rows first. A step that fails after the hash was recorded (a
// broadcast timeout) is reconciled the same way before anything is marked failed. Every write
// after the claim is conditional on this executor still holding the lease.
import { Prisma } from '@prisma/client';
import type { FeeSweepStatus } from '@prisma/client';
import { isValidAddress } from '../checkout/address-format.js';
import { providerFor, type OneClickProvider, type TokenInfo } from '../checkout/oneclick/index.js';
import { tokenList } from '../checkout/tokens.js';
import { env } from '../env.js';
import { opsNotice } from '../gas/ops-notice.js';
import { getKeyVault } from '../keyvault/index.js';
import type { KeyVault } from '../keyvault/types.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { NEAR_GASLESS_TOKENS } from '../near/tokens.js';
import {
  liveSweepChains,
  type SweepChain,
  type SweepOutcome,
  type SweepToken,
} from './fee-sweep-chains.js';
import {
  signSweep,
  sweepKeyAddress,
  type SweepFamily,
  type SweepIntent,
} from './fee-sweep-guard.js';

/** The weekly rule: a token is swept when its last executed sweep is this old. */
export const FEE_SWEEP_WEEKLY_MS = 7 * 24 * 60 * 60_000;
/** The weekly rule skips dust: a balance worth less than this (USD) waits for the threshold. */
export const FEE_SWEEP_WEEKLY_MIN_USD = '1';
/** A failed attempt: the account and token are not planned again for this long. */
export const FEE_SWEEP_RETRY_AFTER_MS = 6 * 60 * 60_000;
/** How long one executor holds a plan. */
export const FEE_SWEEP_LEASE_MS = 10 * 60_000;
/**
 * Time budget of one execution, below the lease: a step still running past it fails the attempt
 * before anything is signed, and the lease is renewed (still held) just before the broadcast.
 */
export const FEE_SWEEP_EXECUTE_MS = 5 * 60_000;
/** A sent transfer the node still does not know this long after its broadcast never landed. */
export const FEE_SWEEP_UNKNOWN_FAIL_MS = 60 * 60_000;
/** The quote's minimum USD out (after slippage) must be at least this share of the plan (bps). */
export const FEE_SWEEP_MIN_OUT_BPS = 9_500n;
/** How long the sweep's 1Click quote stays open. */
export const FEE_SWEEP_QUOTE_TTL_MS = 30 * 60_000;
export const FEE_SWEEP_SLIPPAGE_BPS = 100;
/** USDC on NEAR: what every sweep swaps into. */
export const FEE_SWEEP_DESTINATION_ASSET = NEAR_GASLESS_TOKENS.find(
  (t) => t.symbol === 'USDC',
)!.assetId;

/** Operator notices (internal system events; never webhooks). */
export const FEE_SWEEP_WAITING = 'gas.fee_sweep_waiting';
export const FEE_SWEEP_NEEDS_GAS = 'gas.fee_sweep_needs_gas';
export const FEE_SWEEP_FAILED = 'gas.fee_sweep_failed';

export interface SweepPlan {
  /** The `fee_sweeps` row. */
  id: string;
  family: SweepFamily;
  chain: string;
  /** The gas-fee account. */
  account: string;
  token: SweepToken;
  /** Base units to transfer (for a native coin: the balance less the transfer's fee reserve). */
  amount: bigint;
  amountUsd: string;
  reason: 'threshold' | 'weekly';
  status: FeeSweepStatus;
}

export interface FeeSweepDeps {
  chains: () => SweepChain[];
  tokens: (livemode: boolean) => Promise<Map<string, TokenInfo>>;
  oneclick: () => OneClickProvider;
  kv: () => KeyVault;
  /** The execution time budget (FEE_SWEEP_EXECUTE_MS; tests shorten it). */
  executeMs: number;
}

const DEFAULT_DEPS: FeeSweepDeps = {
  chains: liveSweepChains,
  tokens: tokenList,
  oneclick: () => providerFor(true),
  kv: getKeyVault,
  executeMs: FEE_SWEEP_EXECUTE_MS,
};
let deps: FeeSweepDeps = DEFAULT_DEPS;

/** Overrides the transports, token list, 1Click and key vault (tests); null restores them. */
export function setFeeSweepDeps(overrides: Partial<FeeSweepDeps> | null): void {
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

const OPEN: FeeSweepStatus[] = ['planned', 'needs_gas'];

/** USD of `amount` base units at the token-list price, rounded down to the micro-dollar. */
export function usdValue(amount: bigint, decimals: number, priceUsd: string): string {
  return new Prisma.Decimal(amount.toString())
    .mul(new Prisma.Decimal(priceUsd))
    .div(new Prisma.Decimal(10).pow(decimals))
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN)
    .toFixed();
}

/**
 * The least USD a quote pays out after slippage: the lower of 1Click's `amountOutUsd` and the USDC
 * amount itself (6 decimals, ~$1), less FEE_SWEEP_SLIPPAGE_BPS. Null when unreadable.
 */
export function quoteMinOutUsd(quote: {
  amountOut: string;
  amountOutUsd: string;
}): Prisma.Decimal | null {
  if (!/^\d+$/.test(quote.amountOut) || !/^\d+(\.\d+)?$/.test(quote.amountOutUsd)) return null;
  const usdc = new Prisma.Decimal(quote.amountOut).div(1_000_000);
  const usd = new Prisma.Decimal(quote.amountOutUsd);
  const out = usdc.lt(usd) ? usdc : usd;
  return out.mul(10_000 - FEE_SWEEP_SLIPPAGE_BPS).div(10_000);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** Records (or refreshes) the account+token's one open plan; returns its id and status. */
async function upsertOpenPlan(p: Omit<SweepPlan, 'id' | 'status'>): Promise<{
  id: string;
  status: FeeSweepStatus;
}> {
  const where = {
    livemode: true,
    chain: p.chain,
    accountAddress: p.account,
    assetId: p.token.assetId,
    status: { in: OPEN },
  };
  const data = {
    symbol: p.token.symbol,
    amount: new Prisma.Decimal(p.amount.toString()),
    amountUsd: new Prisma.Decimal(p.amountUsd),
    reason: p.reason,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const open = await prisma.feeSweep.findFirst({ where, select: { id: true, status: true } });
    if (open) {
      await prisma.feeSweep.update({ where: { id: open.id }, data });
      return open;
    }
    try {
      const row = await prisma.feeSweep.create({
        data: {
          id: newId('fsw'),
          livemode: true,
          family: p.family,
          chain: p.chain,
          accountAddress: p.account,
          assetId: p.token.assetId,
          ...data,
        },
        select: { id: true, status: true },
      });
      return row;
    } catch (err) {
      // Another planner created it first (one open plan per account and token): use theirs.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }
  throw new Error('fee sweep: could not record the plan');
}

/**
 * The sweeps due now (see the file header), each recorded as its account+token's open plan. Test
 * mode plans nothing (ruling R12-a). A chain or token that cannot be read is logged and skipped.
 */
export async function planFeeSweeps(livemode: boolean, now: Date): Promise<SweepPlan[]> {
  if (!livemode) return [];
  const threshold = new Prisma.Decimal(env().FEE_SWEEP_THRESHOLD_USD);
  const list = await deps.tokens(true);
  const kv = deps.kv();
  const plans: SweepPlan[] = [];
  for (const chainImpl of deps.chains()) {
    let account: string;
    try {
      account = await sweepKeyAddress(kv, chainImpl.family);
    } catch (err) {
      log('error', 'fee sweep: gas-fee key unavailable', {
        family: chainImpl.family,
        err: errText(err),
      });
      continue;
    }
    for (const chain of chainImpl.chains()) {
      for (const token of chainImpl.tokens(chain, list)) {
        try {
          let amount = await chainImpl.balance(chain, account, token);
          if (amount <= 0n) continue;
          if (token.contract === null) {
            // A native-coin sweep sends only the excess above the gas reserve: future token
            // sweeps plus its own transfer (R12-d, R12-k).
            amount -= chainImpl.nativeReserve
              ? await chainImpl.nativeReserve(chain)
              : await chainImpl.transferFee(chain, account, token);
            if (amount <= 0n) continue;
          }
          const price = list.get(token.assetId)?.priceUsd;
          if (!price || new Prisma.Decimal(price).lte(0)) {
            log('warn', 'fee sweep: token unpriced, skipped', { chain, asset: token.assetId });
            continue;
          }
          const amountUsd = usdValue(amount, token.decimals, price);
          const where = { livemode: true, chain, accountAddress: account, assetId: token.assetId };
          // A failed attempt backs off before the account and token are planned again.
          const recentFailure = await prisma.feeSweep.findFirst({
            where: {
              ...where,
              status: 'failed',
              failedAt: { gt: new Date(now.getTime() - FEE_SWEEP_RETRY_AFTER_MS) },
            },
            select: { id: true },
          });
          if (recentFailure) continue;
          // A sent transfer whose outcome is not known yet: never planned twice (final review m2).
          const inFlight = await prisma.feeSweep.findFirst({
            where: { ...where, status: 'broadcast' },
            select: { id: true },
          });
          if (inFlight) continue;
          const last = await prisma.feeSweep.findFirst({
            where: {
              livemode: true,
              chain,
              accountAddress: account,
              assetId: token.assetId,
              status: 'executed',
            },
            orderBy: { executedAt: 'desc' },
            select: { executedAt: true },
          });
          // The weekly rule never applies to a native coin (its balance is also the sweep gas,
          // R12-k), nor to dust below FEE_SWEEP_WEEKLY_MIN_USD.
          const weeklyDue =
            token.contract !== null &&
            new Prisma.Decimal(amountUsd).gte(FEE_SWEEP_WEEKLY_MIN_USD) &&
            (!last?.executedAt || now.getTime() - last.executedAt.getTime() >= FEE_SWEEP_WEEKLY_MS);
          const reason = threshold.lte(amountUsd) ? 'threshold' : weeklyDue ? 'weekly' : null;
          if (!reason) continue;
          const p = {
            family: chainImpl.family,
            chain,
            account,
            token,
            amount,
            amountUsd,
            reason,
          } as const;
          const row = await upsertOpenPlan(p);
          plans.push({ ...p, id: row.id, status: row.status });
        } catch (err) {
          log('warn', 'fee sweep: balance unavailable', {
            chain,
            asset: token.assetId,
            err: errText(err),
          });
        }
      }
    }
  }
  return plans;
}

const planSummary = (p: SweepPlan) => ({
  id: p.id,
  chain: p.chain,
  account: p.account,
  asset: p.token.assetId,
  symbol: p.token.symbol,
  amount: p.amount.toString(),
  amount_usd: p.amountUsd,
  reason: p.reason,
});

export interface SweepRunResult {
  planned: number;
  /** Confirmed on chain in this run (its own sweeps, or earlier broadcasts reconciled). */
  executed: number;
  /** Sent in this run, outcome not known yet. */
  broadcast: number;
  failed: number;
  needsGas: number;
  /** Why nothing was executed (`disabled`, `no_recipient`), or null. */
  held: 'disabled' | 'no_recipient' | null;
}

/** The worker job: plan (live mode), then execute when the operator gate allows it. */
export async function runFeeSweep(now: Date = new Date()): Promise<SweepRunResult> {
  const reconciled = await reconcileBroadcastSweeps(now);
  const plans = await planFeeSweeps(true, now);
  const result: SweepRunResult = {
    planned: plans.length,
    executed: reconciled.executed,
    broadcast: 0,
    failed: reconciled.failed,
    needsGas: 0,
    held: null,
  };
  if (plans.length === 0) return result;
  const e = env();
  const held = !e.FEE_SWEEP_ENABLED
    ? 'disabled'
    : !e.TENDR_FEE_ACCOUNT_NEAR
      ? 'no_recipient'
      : null;
  if (held) {
    result.held = held;
    await opsNotice({
      type: FEE_SWEEP_WAITING,
      key: 'fee_sweep:waiting',
      now,
      payload: {
        reason:
          held === 'disabled'
            ? 'FEE_SWEEP_ENABLED is not true: no gas-fee key signs until an operator enables it'
            : 'TENDR_FEE_ACCOUNT_NEAR is not set: there is no account to receive the USDC',
        plans: plans.map(planSummary),
      },
    });
    return result;
  }
  for (const plan of plans) {
    const outcome = await executeSweep(plan, now);
    if (outcome === 'executed') result.executed++;
    else if (outcome === 'broadcast') result.broadcast++;
    else if (outcome === 'failed') result.failed++;
    else if (outcome === 'needs_gas') result.needsGas++;
  }
  return result;
}

/**
 * Executes one plan (FEE_SWEEP_ENABLED and TENDR_FEE_ACCOUNT_NEAR are checked again here).
 * Returns the row's new status, or `skipped` when another executor holds it or it is not open.
 */
export async function executeSweep(
  plan: SweepPlan,
  now: Date,
): Promise<'executed' | 'broadcast' | 'failed' | 'needs_gas' | 'skipped'> {
  const e = env();
  const recipient = e.TENDR_FEE_ACCOUNT_NEAR;
  if (!e.FEE_SWEEP_ENABLED || !recipient) return 'skipped';
  const lease = new Date(now.getTime() + FEE_SWEEP_LEASE_MS);
  const claimed = await prisma.feeSweep.updateMany({
    where: {
      id: plan.id,
      status: { in: OPEN },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: lease },
  });
  if (claimed.count !== 1) return 'skipped';
  const started = Date.now();
  /** A step bounded by the execution budget (FEE_SWEEP_EXECUTE_MS < the lease). */
  const bounded = <T>(p: Promise<T>): Promise<T> => {
    const left = deps.executeMs - (Date.now() - started);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('fee sweep: execution exceeded its time budget')),
        Math.max(0, left),
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  const chainImpl = deps.chains().find((c) => c.family === plan.family);
  /** The lease this executor holds (renewed before the broadcast). */
  let held = lease;
  /**
   * Moves the row on only while this executor still holds it (Task 12: a takeover by another
   * executor is never overwritten). Returns whether it did.
   */
  const finish = async (
    status: FeeSweepStatus,
    data: Prisma.FeeSweepUpdateManyMutationInput = {},
  ): Promise<boolean> => {
    const { count } = await prisma.feeSweep.updateMany({
      where: { id: plan.id, leaseUntil: held },
      data: { status, leaseUntil: null, ...data },
    });
    return count === 1;
  };
  if (!chainImpl) {
    await finish('failed', { lastError: `no transport for ${plan.family}`, failedAt: now });
    return 'failed';
  }
  let depositAddress: string | null = null;
  let txHash: string | null = null;
  try {
    // Gas: a receive-only account may hold tokens but no native coin (R12-d).
    if (plan.token.contract !== null) {
      const [native, fee] = await bounded(
        Promise.all([
          chainImpl.nativeBalance(plan.chain, plan.account),
          chainImpl.transferFee(plan.chain, plan.account, plan.token),
        ]),
      );
      if (native < fee) {
        await finish('needs_gas', {
          lastError: `needs ${fee} native units for the transfer, has ${native}`,
        });
        await opsNotice({
          type: FEE_SWEEP_NEEDS_GAS,
          key: `fee_sweep_needs_gas:${plan.family}:${plan.chain}:${plan.account}`,
          now,
          payload: {
            chain: plan.chain,
            account: plan.account,
            needed: fee.toString(),
            balance: native.toString(),
            waiting: planSummary(plan),
          },
        });
        return 'needs_gas';
      }
    }
    const { quote, correlationId } = (await bounded(
      deps.oneclick().quote({
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: FEE_SWEEP_SLIPPAGE_BPS,
        originAsset: plan.token.assetId,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: FEE_SWEEP_DESTINATION_ASSET,
        amount: plan.amount.toString(),
        refundTo: plan.account,
        refundType: 'ORIGIN_CHAIN',
        recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(now.getTime() + FEE_SWEEP_QUOTE_TTL_MS).toISOString(),
      }),
    )) as Awaited<ReturnType<OneClickProvider['quote']>>;
    if (!quote.depositAddress || !isValidAddress(plan.chain, quote.depositAddress)) {
      throw new Error('1Click quote has no valid deposit address');
    }
    if (quote.amountIn !== plan.amount.toString()) {
      throw new Error('1Click quote is for another amount');
    }
    const minOutUsd = quoteMinOutUsd(quote);
    const floor = new Prisma.Decimal(plan.amountUsd)
      .mul(FEE_SWEEP_MIN_OUT_BPS.toString())
      .div(10_000);
    if (minOutUsd === null || minOutUsd.lt(floor)) {
      throw new Error(
        `1Click quote pays too little: at least ${minOutUsd?.toFixed() ?? '?'} USD out for ` +
          `${plan.amountUsd} USD in (floor ${floor.toFixed()})`,
      );
    }
    depositAddress = quote.depositAddress;
    await prisma.feeSweep.update({
      where: { id: plan.id },
      data: {
        quoteId: correlationId,
        depositAddress,
        destinationAsset: FEE_SWEEP_DESTINATION_ASSET,
        recipient,
      },
    });
    await bounded(chainImpl.prepare?.(plan.chain, plan.token, depositAddress) ?? Promise.resolve());
    const intent: SweepIntent = {
      family: plan.family,
      chain: plan.chain,
      from: plan.account,
      token: plan.token.contract,
      decimals: plan.token.decimals,
      amount: plan.amount,
      depositAddress,
    };
    const tx = await bounded(
      chainImpl.build(plan.chain, plan.account, plan.token, depositAddress, plan.amount),
    );
    const signed = await bounded(signSweep(deps.kv(), intent, tx));
    if (Date.now() - started >= deps.executeMs) {
      throw new Error('fee sweep: execution exceeded its time budget');
    }
    // Still ours? Renew the lease for the broadcast and record the hash first, in one statement:
    // a lost answer still leaves the hash to look up, and no second executor can claim it.
    const renewed = new Date(now.getTime() + (Date.now() - started) + FEE_SWEEP_LEASE_MS);
    const kept = await prisma.feeSweep.updateMany({
      where: { id: plan.id, leaseUntil: lease, status: { in: OPEN } },
      data: { leaseUntil: renewed, txHash: signed.txHash },
    });
    if (kept.count !== 1) throw new Error('fee sweep: lost the plan lease before broadcast');
    held = renewed;
    txHash = signed.txHash;
    await bounded(chainImpl.broadcast(plan.chain, signed));
    // Sent: `executed` only once the chain confirms it (final review m2).
    await finish('broadcast', { broadcastAt: now, lastError: null });
    try {
      await deps.oneclick().submitDeposit(txHash, depositAddress);
    } catch (err) {
      log('warn', 'fee sweep: 1Click deposit notice failed', { id: plan.id, err: errText(err) });
    }
    log('info', 'fee sweep broadcast', { ...planSummary(plan), txHash, depositAddress });
    const settled = await reconcileOne(chainImpl, plan.id, now);
    return settled === 'executed' ? 'executed' : settled === 'failed' ? 'failed' : 'broadcast';
  } catch (err) {
    if (txHash !== null) {
      // The hash is recorded and the transfer may be out (a broadcast timeout, a lost answer):
      // its outcome is looked up on chain, never assumed failed (Task 12).
      const moved = await finish('broadcast', { broadcastAt: now, lastError: errText(err) });
      if (!moved) return 'skipped';
      const settled = await reconcileOne(chainImpl, plan.id, now);
      return settled === 'executed' ? 'executed' : settled === 'failed' ? 'failed' : 'broadcast';
    }
    // Another executor took the plan over: its state is theirs.
    if (!(await finish('failed', { lastError: errText(err), failedAt: now }))) return 'skipped';
    await opsNotice({
      type: FEE_SWEEP_FAILED,
      key: `fee_sweep_failed:${plan.family}:${plan.chain}:${plan.account}:${plan.token.assetId}`,
      now,
      payload: {
        ...planSummary(plan),
        deposit_address: depositAddress,
        tx_hash: txHash,
        error: errText(err),
      },
    });
    return 'failed';
  }
}

/**
 * Looks up one `broadcast` sweep's transfer by its hash and settles the row: `executed` when
 * confirmed, `failed` when it reverted or the node still does not know it
 * FEE_SWEEP_UNKNOWN_FAIL_MS after it was sent; otherwise it stays `broadcast`. A lookup that
 * fails leaves it as it is. Returns the row's status afterwards.
 */
async function reconcileOne(
  chainImpl: SweepChain,
  id: string,
  now: Date,
): Promise<'executed' | 'failed' | 'broadcast'> {
  const row = await prisma.feeSweep.findUnique({ where: { id } });
  if (!row || row.status !== 'broadcast' || !row.txHash) return 'broadcast';
  let outcome: SweepOutcome;
  try {
    outcome = await chainImpl.outcome(row.chain, row.txHash, row.accountAddress);
  } catch (err) {
    log('warn', 'fee sweep: outcome unavailable', { id, err: errText(err) });
    return 'broadcast';
  }
  const sentAt = row.broadcastAt ?? row.updatedAt;
  const lost =
    outcome === 'unknown' && now.getTime() - sentAt.getTime() >= FEE_SWEEP_UNKNOWN_FAIL_MS;
  if (outcome === 'confirmed') {
    const { count } = await prisma.feeSweep.updateMany({
      where: { id, status: 'broadcast' },
      data: { status: 'executed', executedAt: now },
    });
    if (count === 1) log('info', 'fee sweep executed', { id, txHash: row.txHash });
    return 'executed';
  }
  if (outcome === 'failed' || lost) {
    const lastError =
      outcome === 'failed'
        ? 'the transfer failed on chain'
        : 'the transfer never landed (unknown to the node)';
    const { count } = await prisma.feeSweep.updateMany({
      where: { id, status: 'broadcast' },
      data: { status: 'failed', failedAt: now, lastError },
    });
    if (count === 1) {
      await opsNotice({
        type: FEE_SWEEP_FAILED,
        key: `fee_sweep_failed:${row.family}:${row.chain}:${row.accountAddress}:${row.assetId}`,
        now,
        payload: {
          id,
          chain: row.chain,
          account: row.accountAddress,
          asset: row.assetId,
          deposit_address: row.depositAddress,
          tx_hash: row.txHash,
          error: lastError,
        },
      });
    }
    return 'failed';
  }
  return 'broadcast';
}

/** Every `broadcast` sweep (live mode), settled by its transfer's outcome on chain. */
export async function reconcileBroadcastSweeps(
  now: Date,
): Promise<{ executed: number; failed: number; pending: number }> {
  const rows = await prisma.feeSweep.findMany({
    where: { livemode: true, status: 'broadcast' },
    select: { id: true, family: true },
  });
  const out = { executed: 0, failed: 0, pending: 0 };
  const chains = deps.chains();
  for (const r of rows) {
    const chainImpl = chains.find((c) => c.family === r.family);
    if (!chainImpl) {
      out.pending++;
      continue;
    }
    const s = await reconcileOne(chainImpl, r.id, now);
    if (s === 'executed') out.executed++;
    else if (s === 'failed') out.failed++;
    else out.pending++;
  }
  return out;
}
