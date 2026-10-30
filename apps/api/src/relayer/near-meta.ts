// Gasless NEAR token payments: NEP-366 meta-transactions (signed delegate actions) relayed by
// `relayer-near`, which pays the gas (project 5a, spec §2.3 NEAR, §2.5; rulings T8-a … T8-e).
//
//   options   allow-listed NEP-141 USDC / USDT only. The shopper's account must exist and have
//             1 yoctoNEAR spare per `ft_transfer` (NEP-141 requires it attached, and in a delegate
//             action it comes from the sender), else the option is unavailable with reason
//             `near_account_needs_balance`.
//   prepare   refused (409 CONFLICT) while a submission of the quote may still execute. Checks the
//             account as above, then registers the deposit address (and, when the shopper pays
//             the fee, Tendr's `gas-fees-near` account) on the token contract: `storage_deposit`
//             `registration_only` from `relayer-near`, only when `storage_balance_of` is null,
//             once (Redis lock). Its cost (deposit + gas) is recorded as Tendr's (a
//             `sponsor = tendr` row; the quote's network-fee estimate includes one registration).
//             Returns the delegate action to sign (`near_delegate_action`): receiver = the token
//             contract; `ft_transfer {receiver_id: deposit, amount: amount_in}` with 1 yoctoNEAR,
//             plus, when the shopper pays, `ft_transfer {receiver_id: gas-fees-near, amount: fee}`
//             with 1 yoctoNEAR; `max_block_height` at most the block height at the quote deadline
//             (recorded in Redis as issued for the quote).
//   submit    the shared pipeline (relayer/submissions.ts) with the NEAR check (ruling T8-a): one
//             canonical borsh SignedDelegate; sender = the quote's wallet; receiver = the token
//             contract; EXACTLY the prepared actions (method, args bytes, 1 yocto, bounded gas; no
//             memo); max_block_height ≤ the issued one and above the final head; an ed25519
//             signature by a FULL ACCESS key of the sender with a nonce above the key's; the
//             account can attach the yocto and holds the tokens. Tendr's daily loss cap refuses in
//             both modes. Then (ruling T8-b):
//               1. `relayer-near` signs the outer transaction (receiver = the shopper's account,
//                  one Delegate action). Its hash is the submission's id.
//               2. The hash and the signed bytes are stored on the submission (a failure → not
//                  broadcast).
//               3. `send_tx`. The node rejecting it as invalid → not broadcast (claim undone; a
//                  stale relayer nonce is re-signed once first). Anything else → `submitted`.
//   outcome   `pollNearMetaRelays` (worker), on the stored hash: `EXPERIMENTAL_tx_status`
//             (ruling T8-e). Success needs every receipt to succeed and one executed by the token
//             contract. The cost is the NEAR the transaction burnt; a shopper fee leg's revenue is
//             the token contract's `ft_transfer` event to `gas-fees-near` (capped at the fee
//             signed). Not seen while the delegate can still execute (final head ≤ its
//             max_block_height) → the same bytes are sent again; never seen once the final head
//             passed it, on two looks ≥ 15 s apart → failed, no gas. Only then can the quote be
//             prepared again. Settlement, release and loss follow the shared lifecycle; cost above
//             what is recovered counts toward the daily loss cap.
//
// Test mode never calls a NEAR RPC: a simulated block height, the same checks (bar the
// account/key lookups), and the payment "lands" at once.
import { TEST_NEAR_RECEIVER } from '@tendr/contracts';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { z } from 'zod';
import { isValidAddress } from '../checkout/address-format.js';
import { providerFor, simulatedOneClick } from '../checkout/oneclick/index.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { SIMULATED_FEE_USD, nativeUsd } from '../gas/fees.js';
import { lossCapReached } from '../gas/loss-cap.js';
import { planNetworkFee, shopperReason } from '../gas/quote-fee.js';
import { getKeyVault, nearPublicKey } from '../keyvault/index.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { relayerNearSender, type RelayerNearSender } from '../near/client.js';
import { creditedAmount } from '../near/events.js';
import { nearGaslessToken } from '../near/tokens.js';
import { NotBroadcastError, isInvalidNonce, type AccountState } from '../near/rpc.js';
import {
  RELAYER_NEAR_MAX_STORAGE_DEPOSIT,
  TGAS,
  decodeSignedDelegate,
  functionCallAction,
  implicitAccountId,
  signedDelegateAction,
  type DecodedSignedDelegate,
  type SignedTx,
} from '../near/tx.js';
import { recordUnrecovered } from './evm/pimlico.js';
import {
  ACTIVE,
  RelayNotBroadcast,
  applyRelayOutcome,
  assertRelayable,
  gaslessNotAvailable,
  quoteExpired,
  sponsorshipReleased,
  submissionStatus,
  submitRelayed,
  undoClaim,
} from './submissions.js';
import type {
  GaslessContext,
  GaslessOption,
  GaslessRelayer,
  PrepareInput,
  PreparePayload,
  QuoteContext,
  SignedPayload,
  SubmissionStatus,
  SubmitResult,
} from './types.js';

export { NEAR_GASLESS_TOKENS, nearGaslessToken, type NearGaslessToken } from '../near/tokens.js';

/** The `to_sign[].kind` of a NEAR payment. */
export const NEAR_DELEGATE_KIND = 'near_delegate_action';
/** Gas each `ft_transfer` is prepared with, and the bounds a signed one must stay within. */
export const NEAR_FT_TRANSFER_GAS = 15n * TGAS;
export const NEAR_FT_TRANSFER_MIN_GAS = 5n * TGAS;
export const NEAR_FT_TRANSFER_MAX_GAS = 30n * TGAS;
/** Gas for a `storage_deposit` registration. */
export const NEAR_STORAGE_GAS = 30n * TGAS;
/**
 * yoctoNEAR per gas unit used to cost a registration whose outcome is unknown (NEAR's minimum gas
 * price; the price only rises under congestion, so with all attached gas burnt this errs high).
 */
export const NEAR_UNKNOWN_GAS_PRICE_YOCTO = 100_000_000n;
/**
 * The block time assumed when turning the quote deadline into a block height. NEAR produces
 * blocks faster than this (~0.6 s), so the height reached at the deadline is higher than the one
 * computed: a delegate action never outlives its quote.
 */
export const NEAR_ASSUMED_BLOCK_MS = 1_000;
/**
 * Blocks between the TTL handed to the wallet and the issued bound (fix-round ruling I1): a
 * wallet sets max_block_height = its own head when it signs (often the optimistic head) + the
 * TTL, so this absorbs approval time and head drift (~90 s of NEAR blocks at ~1.6/s).
 */
export const NEAR_SIGNING_SLACK_BLOCKS = 150n;
/** The shortest TTL handed to a wallet; a quote with less left before its deadline is refused. */
export const NEAR_MIN_TTL_BLOCKS = 60n;
/**
 * "Can no longer execute" needs two looks at least this far apart (one poll interval), both
 * finding the final head past the delegate's max_block_height and the transaction unknown.
 */
export const NEAR_EXPIRY_CONFIRM_MS = 15_000;
/** A claimed submission still `pending` with nothing recorded this long is undone by the poller. */
export const NEAR_STALE_PENDING_MS = 3 * 60_000;
/** A recorded but still `pending` submission is taken over by the poller after this long. */
export const NEAR_RECORDED_PENDING_MS = 30_000;
/** Shopper-signed bytes accepted (two `ft_transfer`s encode to ~400 bytes). */
const MAX_SIGNED_DELEGATE_BYTES = 1_200;
/** NEAR storage staking: yoctoNEAR per byte; accounts up to 770 bytes need none (NEP-448). */
const STORAGE_BYTE_YOCTO = 10_000_000_000_000_000_000n;
const ZERO_BALANCE_ACCOUNT_BYTES = 770n;
const STORAGE_LOCK_TTL_S = 120;

/** Why the NEAR option cannot be used now (the pay page explains it). */
export const NEAR_NEEDS_BALANCE = 'near_account_needs_balance';

const mismatch = (field: string) =>
  new AppError('GASLESS_PAYLOAD_MISMATCH', 'The signed payment does not match this quote', 409, {
    field,
  });
const unavailable = () =>
  new AppError('PROVIDER_UNAVAILABLE', 'Gasless payments are unavailable; try again', 503);
const expired = () =>
  new AppError(
    'GASLESS_EXPIRED',
    'The signed payment has expired; prepare the payment again and sign it',
    409,
  );
const needsBalance = () =>
  new AppError(
    'GASLESS_NOT_AVAILABLE',
    'Your NEAR account needs a little NEAR (1 yoctoNEAR) to pay with this token',
    409,
    { reason: NEAR_NEEDS_BALANCE },
  );

let feeAccount: string | null = null;

/** Tendr's NEAR gas-fee account: the implicit account of the `gas-fees-near` key (ruling T8-c). */
export async function nearGasFeeAccount(): Promise<string> {
  if (feeAccount) return feeAccount;
  const { curve, raw } = await getKeyVault().publicKey('gas-fees-near');
  if (curve !== 'ed25519') throw new Error('gas-fees-near is not an ed25519 key');
  feeAccount = implicitAccountId(raw);
  return feeAccount;
}

/** yoctoNEAR the account can spend: its balance less the storage it must keep staked. */
export function spendableYocto(a: AccountState): bigint {
  const storage =
    a.storageUsageBytes <= ZERO_BALANCE_ACCOUNT_BYTES
      ? 0n
      : a.storageUsageBytes * STORAGE_BYTE_YOCTO;
  const owed = storage > a.lockedYocto ? storage - a.lockedYocto : 0n;
  return a.amountYocto - owed;
}

// ---------------------------------------------------------------------------------------------
// Issued max block heights
// ---------------------------------------------------------------------------------------------

const issuedKey = (quoteId: string) => `tendr:gasless:near-mbh:${quoteId}`;

async function recordIssued(quoteId: string, maxBlockHeight: bigint, ttlS: number) {
  try {
    await getRedis().set(issuedKey(quoteId), maxBlockHeight.toString(), 'EX', ttlS);
  } catch (err) {
    log('warn', 'near gasless: store unavailable', { err: String(err) });
    throw unavailable();
  }
}

/** The highest max_block_height issued for the quote (its deadline), or null if never prepared. */
async function issuedMaxBlockHeight(quoteId: string): Promise<bigint | null> {
  let v: string | null;
  try {
    v = await getRedis().get(issuedKey(quoteId));
  } catch (err) {
    log('warn', 'near gasless: store unavailable', { err: String(err) });
    throw unavailable();
  }
  return v !== null && /^\d+$/.test(v) ? BigInt(v) : null;
}

/** Test mode's block height: one per second (no RPC). */
const simulatedHeight = (now: Date) => BigInt(Math.floor(now.getTime() / NEAR_ASSUMED_BLOCK_MS));

// ---------------------------------------------------------------------------------------------
// The exact payment
// ---------------------------------------------------------------------------------------------

/** Everything the delegate action binds: from the quote and the gas-fee key. */
export interface NearPayment {
  wallet: string;
  contract: string;
  /**
   * The delegate action's receiver: the token contract live; in test mode an account that cannot
   * exist (`TEST_NEAR_RECEIVER`, ruling T10-f), so a test-mode signature never executes.
   */
  receiver?: string;
  depositAddress: string;
  amount: bigint;
  feeAccount: string | null;
  fee: bigint;
}

/** The `ft_transfer`s the delegate action makes, in order. */
function legs(p: NearPayment): { leg: 'payment' | 'fee'; to: string; amount: bigint }[] {
  return [
    { leg: 'payment', to: p.depositAddress, amount: p.amount },
    ...(p.feeAccount ? [{ leg: 'fee' as const, to: p.feeAccount, amount: p.fee }] : []),
  ];
}

/** The canonical `ft_transfer` args: exactly these bytes, with or without `"memo":null`. */
function canonicalArgs(to: string, amount: bigint): string[] {
  const base = JSON.stringify({ receiver_id: to, amount: amount.toString() });
  return [base, `${base.slice(0, -1)},"memo":null}`];
}

/** Throws GASLESS_PAYLOAD_MISMATCH (`details.field`) unless `sd` is exactly the payment. */
export function checkDelegate(p: NearPayment, sd: DecodedSignedDelegate): void {
  if (sd.senderId !== p.wallet) throw mismatch('signed_delegate.sender_id');
  if (sd.receiverId !== (p.receiver ?? p.contract)) throw mismatch('signed_delegate.receiver_id');
  const want = legs(p);
  if (sd.actions.length !== want.length) throw mismatch('signed_delegate.actions');
  want.forEach((leg, i) => {
    const a = sd.actions[i]!;
    const at = `signed_delegate.actions[${i}]`;
    if (a.kind !== 'functionCall' || !('methodName' in a)) throw mismatch(at);
    if (a.methodName !== 'ft_transfer') throw mismatch(`${at}.method`);
    if (a.deposit !== 1n) throw mismatch(`${at}.deposit`);
    if (a.gas < NEAR_FT_TRANSFER_MIN_GAS || a.gas > NEAR_FT_TRANSFER_MAX_GAS) {
      throw mismatch(`${at}.gas`);
    }
    const args = Buffer.from(a.args).toString('utf8');
    if (!canonicalArgs(leg.to, leg.amount).includes(args)) throw mismatch(`${at}.args`);
  });
}

// ---------------------------------------------------------------------------------------------
// The relayer
// ---------------------------------------------------------------------------------------------

/** What a meta-transaction submission keeps (`gas_sponsorships.paymaster_data`), before sending. */
interface StoredNearMeta {
  kind: 'near_meta';
  /** The outer transaction's hash: the submission's id on chain. */
  hash: string;
  /** `relayer-near`'s account (the signer: routes the status lookup). */
  relayer: string;
  /** borsh(SignedTransaction), base64: re-sent as is until it executes or cannot. */
  transaction: string;
  /** The shopper's borsh(SignedDelegate), base64. */
  delegate: string;
  maxBlockHeight: string;
  /**
   * yoctoNEAR this payment's `storage_deposit` registrations spent (deposit + gas), sent just
   * before the relay: part of the payment's cost. Absent when nothing needed registering.
   */
  storageYocto?: string;
  /** When the poller first found the delegate expired and the transaction unknown (ms). */
  expiredSeenAt?: number;
}

const StoredSchema = z.object({
  kind: z.literal('near_meta'),
  hash: z.string().min(1),
  relayer: z.string().min(1),
  transaction: z.string().min(1),
  delegate: z.string(),
  maxBlockHeight: z.string().regex(/^\d+$/),
  storageYocto: z.string().regex(/^\d+$/).optional(),
  expiredSeenAt: z.number().finite().optional(),
});

function storedMeta(v: Prisma.JsonValue | null): StoredNearMeta | null {
  const r = StoredSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** The checked delegate `submit` relays. */
interface NearRelayCall {
  delegate: string;
  sd: DecodedSignedDelegate;
  payment: NearPayment;
}

/** The claim was undone meanwhile (e.g. by the poller): this transaction is never sent. */
class ClaimLost extends Error {
  constructor() {
    super('the submission is no longer claimed for this quote');
    this.name = 'ClaimLost';
  }
}

/**
 * Writes the signed outer transaction on the submission, only while it is still `pending` and
 * claimed for `quoteId`; throws ClaimLost otherwise.
 */
async function recordSigned(
  scope: { merchantId: string; livemode: boolean },
  id: string,
  quoteId: string,
  stored: StoredNearMeta,
): Promise<void> {
  const { count } = await tenantTransaction(scope, (tx) =>
    tx.gasSponsorship.updateMany({
      where: { ...scope, id, quoteId, status: 'pending' },
      data: { txHash: stored.hash, paymasterData: stored as unknown as Prisma.InputJsonValue },
    }),
  );
  if (count !== 1) throw new ClaimLost();
}

export interface NearMetaDeps {
  /** `relayer-near`'s sender (its RPC answers every lookup); default the mode's. */
  sender?: RelayerNearSender;
  now?: () => Date;
  /** Records the signed transaction on the claimed submission (default: the DB; tests fail it). */
  record?: typeof recordSigned;
}

const scopeOf = (q: QuoteContext) => ({
  merchantId: q.shopper.merchantId,
  livemode: q.shopper.livemode,
});

const isNearAccount = (id: string) => isValidAddress('near', id) && !id.startsWith('0x');

export class NearMetaGasless implements GaslessRelayer {
  readonly family = 'near' as const;

  constructor(
    /** Live: `relayer-near` and the mode's NEAR RPC. Test mode: simulated, no RPC. */
    private readonly live: boolean,
    private readonly deps: NearMetaDeps = {},
  ) {}

  private get sender(): RelayerNearSender {
    return this.deps.sender ?? relayerNearSender(true);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** An RPC read; any failure is 503 (logged, never the raw error). */
  private async read<T>(what: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (err) {
      log('warn', 'near gasless: RPC unavailable', { what, err: String(err) });
      throw unavailable();
    }
  }

  /** Whether the shopper's account exists and can attach `yocto` (one per `ft_transfer`). */
  private async canAttach(wallet: string, yocto: bigint): Promise<boolean> {
    const a = await this.read('view_account', () => this.sender.rpc.viewAccountOrNull(wallet));
    return a !== null && spendableYocto(a) >= yocto;
  }

  async options(c: GaslessContext): Promise<GaslessOption[]> {
    const token = nearGaslessToken(c.origin.assetId);
    if (!token || c.origin.blockchain !== 'near' || !isNearAccount(c.walletAddress)) return [];
    // `relayer-near` pays in every mode: none once the day's loss cap is reached.
    if (await lossCapReached(c.shopper.livemode, this.now())) return [];
    const plan = await planNetworkFee({
      livemode: c.shopper.livemode,
      merchantId: c.shopper.merchantId,
      session: c.session,
      origin: c.origin,
      walletAddress: c.walletAddress,
      method: 'meta_tx',
      feeMode: 'token',
    });
    let option: GaslessOption | null = null;
    if (plan.paidBy === 'merchant') {
      option = {
        method: 'meta_tx',
        paid_by: 'merchant',
        reason: null,
        fee_modes: [],
        token_fee: null,
      };
    } else if (plan.feeMode === 'token' && plan.tokenAmount) {
      option = {
        method: 'meta_tx',
        paid_by: 'shopper',
        reason: shopperReason(plan.reason),
        fee_modes: ['token', 'native'],
        token_fee: {
          amount: plan.tokenAmount,
          symbol: c.origin.symbol,
          decimals: c.origin.decimals,
          usd: plan.usd,
        },
      };
    }
    if (!option || !this.live) return option ? [option] : [];
    let ok: boolean;
    try {
      ok = await this.canAttach(c.walletAddress, option.paid_by === 'merchant' ? 1n : 2n);
    } catch {
      // Prepare checks again; an RPC hiccup here should not hide the option.
      ok = true;
    }
    if (ok) return [option];
    return [
      {
        method: 'meta_tx',
        paid_by: 'shopper',
        reason: null,
        fee_modes: [],
        token_fee: null,
        unavailable_reason: NEAR_NEEDS_BALANCE,
      },
    ];
  }

  /** Everything the delegate binds: from the quote and the gas-fee key. */
  private async payment(q: QuoteContext): Promise<NearPayment> {
    const token = nearGaslessToken(q.quote.originAssetId);
    const wallet = q.quote.walletAddress ?? '';
    if (
      !token ||
      q.origin.blockchain !== 'near' ||
      q.quote.networkFeeMethod !== 'meta_tx' ||
      !isNearAccount(wallet) ||
      !isNearAccount(q.quote.depositAddress)
    ) {
      throw gaslessNotAvailable();
    }
    const shopperFee = q.quote.networkFeePaidBy === 'buyer';
    if (
      shopperFee &&
      (q.quote.networkFeeMode !== 'token' ||
        !q.quote.networkFeeAmount ||
        q.quote.networkFeeAmount.lte(0))
    ) {
      throw gaslessNotAvailable();
    }
    return {
      wallet,
      contract: token.contract,
      receiver: this.live ? token.contract : TEST_NEAR_RECEIVER,
      depositAddress: q.quote.depositAddress,
      amount: BigInt(q.quote.amountIn.toFixed(0)),
      feeAccount: shopperFee ? await nearGasFeeAccount() : null,
      fee: shopperFee ? BigInt(q.quote.networkFeeAmount!.toFixed(0)) : 0n,
    };
  }

  private async assertUnderLossCap(q: QuoteContext): Promise<void> {
    if (await lossCapReached(q.shopper.livemode, this.now())) throw gaslessNotAvailable();
  }

  async prepare(q: QuoteContext, input: PrepareInput): Promise<PreparePayload> {
    const now = this.now();
    assertRelayable(q, now);
    if (input.method && input.method !== q.quote.networkFeeMethod) throw mismatch('method');
    if (
      input.fee_mode &&
      q.quote.networkFeePaidBy === 'buyer' &&
      input.fee_mode !== q.quote.networkFeeMode
    ) {
      throw mismatch('fee_mode');
    }
    // Never a second delegate for the quote while an earlier one may still execute (T8-b).
    const active = await prisma.gasSponsorship.findFirst({
      where: { ...scopeOf(q), quoteId: q.quote.id, status: ACTIVE },
      select: { id: true },
    });
    if (active) {
      throw new AppError(
        'CONFLICT',
        'A payment for this quote is already in flight; wait for its outcome',
        409,
        { submission_id: active.id },
      );
    }
    const p = await this.payment(q);
    await this.assertUnderLossCap(q);
    await this.assertHoldClaimable(q);
    const legList = legs(p);
    let height: bigint;
    let relayerId: string;
    // Prepare never spends (fix-round ruling I2): registrations happen at submit.
    if (this.live) {
      height = (await this.read('block', () => this.sender.rpc.finalBlock())).height;
      if (!(await this.canAttach(p.wallet, BigInt(legList.length)))) throw needsBalance();
      relayerId = await this.read('relayer key', () => this.sender.accountId());
    } else {
      height = simulatedHeight(now);
      relayerId = implicitAccountId((await getKeyVault().publicKey('relayer-near')).raw);
    }
    const untilDeadline = q.quote.deadline.getTime() - now.getTime();
    // The bound: the block height at the quote deadline (blocks assumed no faster than 1/s).
    const maxBlockHeight =
      height + BigInt(Math.max(0, Math.floor(untilDeadline / NEAR_ASSUMED_BLOCK_MS)));
    // The wallet adds the TTL to its own head when it signs: leave slack below the bound.
    const ttl = maxBlockHeight - height - NEAR_SIGNING_SLACK_BLOCKS;
    if (ttl < NEAR_MIN_TTL_BLOCKS) throw quoteExpired('is too close to its deadline to sign');
    await recordIssued(q.quote.id, maxBlockHeight, Math.ceil(untilDeadline / 1000) + 3600);
    return {
      quote_id: q.quote.id,
      method: 'meta_tx',
      chain: q.origin.blockchain,
      chain_id: null,
      signer: p.wallet,
      deadline: q.quote.deadline.toISOString(),
      amount: p.amount.toString(),
      fee_amount: p.fee.toString(),
      to_sign: [
        {
          kind: NEAR_DELEGATE_KIND,
          typed_data: {
            /** The delegate action the wallet signs (e.g. wallet-selector `signDelegateActions`). */
            sender_id: p.wallet,
            receiver_id: p.receiver ?? p.contract,
            actions: legList.map((l) => ({
              type: 'FunctionCall',
              params: {
                methodName: 'ft_transfer',
                args: { receiver_id: l.to, amount: l.amount.toString() },
                gas: NEAR_FT_TRANSFER_GAS.toString(),
                deposit: '1',
              },
            })),
            /** The signed delegate's max_block_height must not exceed this (the deadline). */
            max_block_height: maxBlockHeight.toString(),
            /**
             * The TTL to sign with (`blockHeightTtl`): the wallet's head at signing + this stays
             * under max_block_height with NEAR_SIGNING_SLACK_BLOCKS to spare.
             */
            block_height_ttl: Number(ttl),
            /** Pays the gas (shown to the shopper as the relayer). */
            relayer_id: relayerId,
            expires_at: q.quote.deadline.toISOString(),
            /** Every token movement the delegate makes (the pay page shows and checks them). */
            transfers: legList.map((l) => ({
              leg: l.leg,
              token: p.contract,
              to: l.to,
              amount: l.amount.toString(),
            })),
          },
        },
      ],
    };
  }

  /**
   * A merchant-sponsored quote whose hold can no longer be claimed (released, or used by a relay
   * that failed) is refused here, before the shopper signs: the page re-quotes first.
   */
  private async assertHoldClaimable(q: QuoteContext): Promise<void> {
    if (q.quote.networkFeePaidBy !== 'merchant') return;
    const hold = q.quote.gasSponsorshipId
      ? await prisma.gasSponsorship.findFirst({
          where: { ...scopeOf(q), id: q.quote.gasSponsorshipId },
          select: { reservationState: true, status: true, quoteId: true },
        })
      : null;
    if (hold?.reservationState !== 'reserved' || hold.status !== 'pending' || hold.quoteId) {
      throw sponsorshipReleased();
    }
  }

  /**
   * Registers `account` on the token contract (ruling T8-c, at submit per fix-round ruling I2)
   * unless `storage_balance_of` says it is: `relayer-near` sends one registration-only
   * `storage_deposit` of the contract's minimum, under a Redis lock so concurrent submits send it
   * once. Returns what it spent (deposit + gas) for the payment's cost, or null when nothing was
   * needed. A registration that executed but failed records its gas as Tendr's, then throws.
   */
  private async ensureRegistered(
    ctx: StorageCtx,
    contract: string,
    account: string,
  ): Promise<Registration | null> {
    const rpc = this.sender.rpc;
    const registered = async () =>
      (await this.read('storage_balance_of', () =>
        rpc.viewFunction<unknown>(contract, 'storage_balance_of', { account_id: account }),
      )) !== null;
    if (await registered()) return null;
    const key = `tendr:gasless:near-storage:${contract}:${account}`;
    let locked: boolean;
    try {
      locked = (await getRedis().set(key, '1', 'EX', STORAGE_LOCK_TTL_S, 'NX')) === 'OK';
    } catch (err) {
      log('warn', 'near gasless: store unavailable', { err: String(err) });
      throw unavailable();
    }
    if (!locked) {
      // Another submit is registering it right now.
      if (await registered()) return null;
      throw unavailable();
    }
    let keepLock = false;
    try {
      if (await registered()) return null;
      const bounds = await this.read('storage_balance_bounds', () =>
        rpc.viewFunction<{ min?: unknown }>(contract, 'storage_balance_bounds', {}),
      );
      const min =
        typeof bounds?.min === 'string' && /^\d+$/.test(bounds.min) ? BigInt(bounds.min) : null;
      if (min === null || min > RELAYER_NEAR_MAX_STORAGE_DEPOSIT) {
        log('error', 'near gasless: unexpected storage_balance_bounds', { contract });
        throw unavailable();
      }
      const actions = [
        functionCallAction(
          'storage_deposit',
          { account_id: account, registration_only: true },
          NEAR_STORAGE_GAS,
          min,
        ),
      ];
      let res;
      let sentHash: string | null = null;
      try {
        // `signAndSend`, keeping the hash of what was sent (a stale nonce re-signs once).
        for (let attempt = 0; ; attempt++) {
          const signedTx = await this.sender.sign(contract, actions);
          sentHash = signedTx.hash;
          try {
            res = await this.sender.send(signedTx);
            break;
          } catch (err) {
            if (attempt === 0 && err instanceof NotBroadcastError && isInvalidNonce(err.cause)) {
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        const unknown = !(err instanceof NotBroadcastError);
        // It may still execute: hold the lock to its TTL so no second deposit races it.
        keepLock = unknown;
        log('warn', 'near gasless: storage_deposit not confirmed', {
          contract,
          err: err instanceof Error ? err.name : 'error',
        });
        if (unknown) {
          // Its cost is recorded as Tendr's at once (Task 8 N2): the deposit and all its gas,
          // the most it can cost. If it executed, the next attempt finds the account
          // registered and spends nothing more; if it did not, the cost errs high.
          await recordStorageCost(ctx, {
            contract,
            account,
            txHash: sentHash ?? 'unknown',
            yocto: min + NEAR_STORAGE_GAS * NEAR_UNKNOWN_GAS_PRICE_YOCTO,
          });
        }
        throw unavailable();
      }
      if (res.topLevelStatus !== 'success') {
        // The deposit is refunded; the gas is spent and this payment will not be relayed now.
        await recordStorageCost(ctx, {
          contract,
          account,
          txHash: res.txHash,
          yocto: res.tokensBurnt ?? 0n,
        });
        log('error', 'near gasless: storage_deposit failed', { contract, txHash: res.txHash });
        throw unavailable();
      }
      return { contract, account, txHash: res.txHash, yocto: min + (res.tokensBurnt ?? 0n) };
    } finally {
      if (!keepLock) {
        try {
          await getRedis().del(key);
        } catch {
          // Expires on its own.
        }
      }
    }
  }

  /** Checks the signed delegate (ruling T8-a) against the quote and the chain. */
  private async verify(q: QuoteContext, signed: SignedPayload): Promise<NearRelayCall> {
    const b64 = signed.signedDelegate;
    if (!b64 || signed.transaction !== undefined || Object.keys(signed.signatures).length > 0) {
      throw mismatch('signed_delegate');
    }
    await this.assertUnderLossCap(q);
    let sd: DecodedSignedDelegate;
    try {
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > MAX_SIGNED_DELEGATE_BYTES || bytes.toString('base64') !== b64) {
        throw new Error('not canonical base64');
      }
      sd = decodeSignedDelegate(bytes);
    } catch {
      throw mismatch('signed_delegate');
    }
    const p = await this.payment(q);
    checkDelegate(p, sd);
    if (!ed25519.verify(sd.signature, sd.hash, sd.publicKey)) {
      throw mismatch('signed_delegate.signature');
    }
    const issued = await issuedMaxBlockHeight(q.quote.id);
    if (issued === null) throw expired();
    if (sd.maxBlockHeight > issued) throw mismatch('signed_delegate.max_block_height');
    if (!this.live) {
      if (sd.maxBlockHeight <= simulatedHeight(this.now())) throw expired();
      return { delegate: b64, sd, payment: p };
    }
    const rpc = this.sender.rpc;
    const head = await this.read('block', () => rpc.finalBlock());
    if (sd.maxBlockHeight <= head.height) throw expired();
    const key = await this.read('view_access_key', () =>
      rpc.accessKey(p.wallet, nearPublicKey(sd.publicKey)),
    );
    if (!key?.fullAccess) throw mismatch('signed_delegate.public_key');
    if (sd.nonce <= key.nonce) throw mismatch('signed_delegate.nonce');
    // nearcore refuses a delegate nonce ≥ block height × 10^6 (DelegateActionNonceTooLarge).
    if (sd.nonce >= head.height * 1_000_000n) throw mismatch('signed_delegate.nonce');
    if (!(await this.canAttach(p.wallet, BigInt(sd.actions.length)))) throw needsBalance();
    const balance = await this.read('ft_balance_of', () =>
      rpc.viewFunction<unknown>(p.contract, 'ft_balance_of', { account_id: p.wallet }),
    );
    if (
      typeof balance !== 'string' ||
      !/^\d+$/.test(balance) ||
      BigInt(balance) < p.amount + p.fee
    ) {
      throw new AppError(
        'GASLESS_SUBMIT_FAILED',
        'Your token balance does not cover this payment',
        409,
        { reason: 'insufficient_token_balance' },
      );
    }
    return { delegate: b64, sd, payment: p };
  }

  async submit(q: QuoteContext, signed: SignedPayload): Promise<SubmitResult> {
    const res = await submitRelayed<NearRelayCall>(
      q,
      signed,
      (qq, s) => this.verify(qq, s),
      (call, submission) => this.broadcast(q, call, submission.id),
    );
    if (this.live || res.status !== 'submitted') return res;
    await this.simulateLanded(q, res.submissionId, res.txHash!);
    return { ...res, status: 'confirmed' };
  }

  /**
   * Register (only now: the delegate passed every check) → sign (relayer-near) → store the hash
   * and bytes → send. See the file header. Registrations paid for an attempt that is then not
   * broadcast are recorded as Tendr's cost (the payment will not recover them).
   */
  private async broadcast(
    q: QuoteContext,
    call: NearRelayCall,
    id: string,
  ): Promise<{ txHash: string }> {
    if (!this.live) return { txHash: simulatedNearTxHash(id) };
    const ctx: StorageCtx = { scope: scopeOf(q), sessionId: q.session.id, quoteId: q.quote.id };
    const regs: Registration[] = [];
    const accounts = [call.payment.depositAddress];
    if (call.payment.feeAccount) accounts.push(call.payment.feeAccount);
    try {
      for (const account of accounts) {
        const r = await this.ensureRegistered(ctx, call.payment.contract, account);
        if (r) regs.push(r);
      }
      const storageYocto = regs.reduce((t, r) => t + r.yocto, 0n);
      return await this.relay(q, call, id, storageYocto);
    } catch (err) {
      for (const r of regs) await recordStorageCost(ctx, r);
      if (err instanceof AppError && err.code === 'PROVIDER_UNAVAILABLE') {
        // A registration could not be completed: nothing relayed, the claim is undone.
        throw new RelayNotBroadcast('the payment accounts could not be registered', 'unavailable');
      }
      throw err;
    }
  }

  /** Sign → record → send the outer transaction (a stale relayer nonce is re-signed once). */
  private async relay(
    q: QuoteContext,
    call: NearRelayCall,
    id: string,
    storageYocto: bigint,
  ): Promise<{ txHash: string }> {
    const scope = scopeOf(q);
    for (let attempt = 0; ; attempt++) {
      let signed: SignedTx;
      let relayer: string;
      try {
        relayer = await this.sender.accountId();
        signed = await this.sender.sign(call.sd.senderId, [signedDelegateAction(call.sd)]);
      } catch (err) {
        log('warn', 'near gasless: relay transaction not signed', {
          submissionId: id,
          err: String(err),
        });
        throw new RelayNotBroadcast('the relay transaction could not be signed', 'unavailable');
      }
      const stored: StoredNearMeta = {
        kind: 'near_meta',
        hash: signed.hash,
        relayer,
        transaction: Buffer.from(signed.bytes).toString('base64'),
        delegate: call.delegate,
        maxBlockHeight: call.sd.maxBlockHeight.toString(),
        ...(storageYocto > 0n ? { storageYocto: storageYocto.toString() } : {}),
      };
      try {
        await (this.deps.record ?? recordSigned)(scope, id, q.quote.id, stored);
      } catch (err) {
        if (err instanceof ClaimLost) {
          log('warn', 'near gasless: claim lost before the broadcast', { submissionId: id });
          throw new AppError(
            'QUOTE_EXPIRED',
            'This payment attempt was abandoned; request a new quote',
            409,
          );
        }
        // Never broadcast a transaction whose hash is not recorded.
        log('warn', 'near gasless: could not record the transaction', {
          submissionId: id,
          err: String(err),
        });
        throw new RelayNotBroadcast('the transaction could not be recorded', 'unavailable');
      }
      try {
        await this.sender.send(signed);
      } catch (err) {
        if (err instanceof NotBroadcastError) {
          // The node refused it before it entered a chunk: it never executed.
          if (attempt === 0 && isInvalidNonce(err.cause)) continue;
          log('warn', 'near gasless: the node refused the transaction', {
            submissionId: id,
            reason: err.message.slice(0, 200),
          });
          throw new RelayNotBroadcast(err.message, 'simulation_reverted');
        }
        // It may have been accepted: `submitted` with its known hash; the poller re-sends.
        log('warn', 'near gasless: broadcast outcome unknown; the poller re-sends', {
          submissionId: id,
          err: String(err),
        });
      }
      return { txHash: signed.hash };
    }
  }

  /** Test mode: the payment "lands" at once and the deposit reaches the simulated 1Click. */
  private async simulateLanded(q: QuoteContext, id: string, txHash: string): Promise<void> {
    const applied = await applyRelayOutcome(id, {
      status: 'confirmed',
      txHash,
      gasUsed: 2n * NEAR_FT_TRANSFER_GAS,
      costUsd: SIMULATED_FEE_USD[q.origin.blockchain] ?? null,
      reason: null,
      // The simulated delegate moves exactly the signed fee.
      feeMoved:
        q.quote.networkFeePaidBy === 'buyer' && q.quote.networkFeeAmount
          ? BigInt(q.quote.networkFeeAmount.toFixed(0))
          : null,
    });
    if (applied) await recordUnrecovered(id, new Date());
    try {
      await simulatedOneClick().simulate(q.quote.depositAddress, 'exact', {
        senderAddress: q.quote.walletAddress!,
      });
    } catch (err) {
      log('warn', 'simulated near meta: deposit simulation failed', {
        submissionId: id,
        err: String(err),
      });
    }
  }

  status(submissionId: string): Promise<SubmissionStatus> {
    return submissionStatus(submissionId);
  }
}

/** Test mode: a deterministic, obviously simulated NEAR transaction hash (base58, 32 bytes). */
export function simulatedNearTxHash(submissionId: string): string {
  return bs58.encode(
    createHash('sha256').update(`tendr:simulated-near-meta:${submissionId}`).digest(),
  );
}

/** Where a registration's cost is recorded: the session and quote it was made for. */
interface StorageCtx {
  scope: { merchantId: string; livemode: boolean };
  sessionId: string;
  quoteId: string;
}

/** One `storage_deposit` registration that executed: what it spent (deposit + gas). */
interface Registration {
  contract: string;
  account: string;
  txHash: string;
  yocto: bigint;
}

/**
 * Records registration spend the payment will not recover as Tendr's own (`sponsor = tendr`,
 * recognised now: counted by the daily loss cap): a registration that failed, or one paid for an
 * attempt that was then not broadcast or never executed. Never a submission (no quote id). A
 * registration followed by its relay is part of that payment's cost instead (`storageYocto`).
 */
async function recordStorageCost(ctx: StorageCtx, r: Registration): Promise<void> {
  const scope = ctx.scope;
  let costUsd: string | null = null;
  try {
    costUsd = await nativeUsd('near', r.yocto, scope.livemode);
  } catch (err) {
    log('warn', 'near gasless: storage cost unpriced', { err: String(err) });
  }
  const now = new Date();
  try {
    await tenantTransaction(scope, (tx) =>
      tx.gasSponsorship.create({
        data: {
          id: newId('gas'),
          ...scope,
          sessionId: ctx.sessionId,
          chain: 'near',
          method: 'meta_tx',
          provider: 'relayer-near',
          sponsor: 'tendr',
          status: 'confirmed',
          txHash: r.txHash,
          ...(costUsd ? { costUsd } : {}),
          lossRecognizedAt: now,
          paymasterData: {
            kind: 'near_storage',
            quote_id: ctx.quoteId,
            contract: r.contract,
            account_id: r.account,
            yocto: r.yocto.toString(),
          },
        },
      }),
    );
  } catch (err) {
    log('error', 'near gasless: storage cost not recorded', {
      txHash: r.txHash,
      err: String(err),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/**
 * One pass over meta-transaction submissions awaiting their outcome (see the file header). Every
 * row visited is marked checked (rows rotate, so failing rows cannot starve the rest). Returns
 * how many outcomes were applied (claims undone included).
 */
export async function pollNearMetaRelays(
  deps: { sender?: RelayerNearSender; now?: () => Date; livemode?: boolean } = {},
): Promise<number> {
  const livemode = deps.livemode ?? true;
  const sender = deps.sender ?? relayerNearSender(livemode);
  const now = deps.now?.() ?? new Date();
  const rows = await prisma.gasSponsorship.findMany({
    where: {
      livemode,
      method: 'meta_tx',
      provider: 'relayer-near',
      quoteId: { not: null },
      status: { in: ['pending', 'submitted'] },
    },
    include: { quote: true },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  let applied = 0;
  for (const row of rows) {
    const scope = { merchantId: row.merchantId, livemode: row.livemode };
    try {
      if (!row.quote) continue;
      const stored = storedMeta(row.paymasterData);
      if (!stored) {
        // Claimed, but nothing was ever signed and stored: nothing can have been sent.
        if (row.status === 'pending') {
          if (now.getTime() - row.updatedAt.getTime() >= NEAR_STALE_PENDING_MS) {
            await undoClaim(scope, row.id, 'the transaction was never recorded or sent');
            applied++;
          }
          continue;
        }
        log('error', 'near gasless: submitted row without its transaction', {
          sponsorshipId: row.id,
        });
        await touch(row.id, now);
        continue;
      }
      if (row.status === 'pending') {
        // Recorded, not marked: a submit still sending, or one that stopped (it may have sent).
        if (now.getTime() - row.updatedAt.getTime() < NEAR_RECORDED_PENDING_MS) continue;
        await markSent(scope, row.id, row.quote, stored.hash, now);
      }
      if (await applyOutcome(sender, { ...row, quote: row.quote }, stored, now)) applied++;
    } catch (err) {
      log('warn', 'near gasless: outcome lookup failed', {
        sponsorshipId: row.id,
        err: String(err),
      });
      try {
        await touch(row.id, now);
      } catch {
        // The next pass retries.
      }
    }
  }
  return applied;
}

/** The submission is `submitted` with its hash; the quote records the deposit tx; 1Click is told. */
async function markSent(
  scope: { merchantId: string; livemode: boolean },
  id: string,
  quote: { id: string; depositAddress: string },
  hash: string,
  now: Date,
): Promise<void> {
  await tenantTransaction(scope, async (t) => {
    await t.gasSponsorship.updateMany({
      where: { ...scope, id, status: 'pending' },
      data: { status: 'submitted', txHash: hash },
    });
    await t.quote.updateMany({
      where: { ...scope, id: quote.id, depositTxHash: null },
      data: { depositTxHash: hash, depositTxSubmittedAt: now },
    });
  });
  try {
    await providerFor(scope.livemode).submitDeposit(hash, quote.depositAddress);
  } catch (err) {
    log('warn', 'near gasless: 1Click deposit notice failed', {
      sponsorshipId: id,
      err: String(err),
    });
  }
}

/** One submitted transaction: wait / re-send / apply its outcome. True when an outcome applied. */
async function applyOutcome(
  sender: RelayerNearSender,
  row: {
    id: string;
    merchantId: string;
    sessionId: string;
    quoteId: string | null;
    livemode: boolean;
    sponsor: string;
    feeAmount: Prisma.Decimal | null;
    quote: { originAssetId: string };
  },
  stored: StoredNearMeta,
  now: Date,
): Promise<boolean> {
  const rpc = sender.rpc;
  let status = await rpc.txStatus(stored.hash, stored.relayer);
  if (!status) {
    const head = await rpc.finalBlock();
    if (head.height <= BigInt(stored.maxBlockHeight)) {
      // Not seen yet and the delegate can still execute: send the same bytes again (same hash,
      // executes at most once).
      try {
        await rpc.sendTx(Buffer.from(stored.transaction, 'base64'), stored.hash);
      } catch (err) {
        log('warn', 'near gasless: re-send failed', { sponsorshipId: row.id, err: String(err) });
      }
      const { expiredSeenAt: _cleared, ...rest } = stored;
      await touch(row.id, now, stored.expiredSeenAt !== undefined ? rest : undefined);
      return false;
    }
    // Past max_block_height at the final head: anything that could still execute is visible.
    status = await rpc.txStatus(stored.hash, stored.relayer);
    if (!status) {
      // Only on a second look, a poll interval later (load-balanced nodes may disagree).
      const first = stored.expiredSeenAt;
      if (first === undefined || now.getTime() - first < NEAR_EXPIRY_CONFIRM_MS) {
        await touch(
          row.id,
          now,
          first === undefined ? { ...stored, expiredSeenAt: now.getTime() } : undefined,
        );
        return false;
      }
      const did = await applyRelayOutcome(
        row.id,
        {
          status: 'failed',
          txHash: null,
          gasUsed: null,
          costUsd: null,
          reason: 'the meta-transaction never executed (delegate action expired)',
          feeMoved: null,
        },
        now,
      );
      // Its registrations were paid for nothing this payment will recover.
      if (did && stored.storageYocto && BigInt(stored.storageYocto) > 0n && row.quoteId) {
        await recordStorageCost(
          {
            scope: { merchantId: row.merchantId, livemode: row.livemode },
            sessionId: row.sessionId,
            quoteId: row.quoteId,
          },
          {
            contract: nearGaslessToken(row.quote.originAssetId)?.contract ?? '',
            account: 'deposit and fee accounts',
            txHash: stored.hash,
            yocto: BigInt(stored.storageYocto),
          },
        );
      }
      return did;
    }
  }
  const token = nearGaslessToken(row.quote.originAssetId);
  const contract = token?.contract ?? null;
  // Every receipt succeeded (the delegate, the token contract's ft_transfers, refunds), and the
  // token contract ran.
  const ok =
    status.receipts.every((r) => r.ok) &&
    contract !== null &&
    status.receipts.some((r) => r.executorId === contract);
  let costUsd: string | null = null;
  try {
    // The NEAR the relay burnt plus the registrations made for it just before.
    const spent = (status.tokensBurnt ?? 0n) + BigInt(stored.storageYocto ?? '0');
    costUsd = await nativeUsd('near', spent, row.livemode);
  } catch (err) {
    log('warn', 'near gasless: cost unpriced', { sponsorshipId: row.id, err: String(err) });
  }
  let feeMoved: bigint | null = null;
  if (ok && row.sponsor === 'shopper' && token && row.feeAmount) {
    const moved = creditedAmount(status.receipts, {
      assetId: token.assetId,
      receiver: await nearGasFeeAccount(),
    });
    const cap = BigInt(row.feeAmount.toFixed(0));
    feeMoved = moved > cap ? cap : moved;
  }
  const did = await applyRelayOutcome(
    row.id,
    {
      status: ok ? 'confirmed' : 'failed',
      txHash: stored.hash,
      gasUsed: status.gasBurnt ?? null,
      costUsd,
      reason: ok ? null : 'a receipt of the meta-transaction failed',
      feeMoved,
    },
    now,
  );
  if (did) await recordUnrecovered(row.id, now);
  return did;
}

/** Marks a row checked, optionally with its updated record. */
async function touch(id: string, now: Date, stored?: StoredNearMeta): Promise<void> {
  await prisma.gasSponsorship.updateMany({
    where: { id, status: { in: ['pending', 'submitted'] } },
    data: {
      updatedAt: now,
      ...(stored ? { paymasterData: stored as unknown as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Drops cached state (tests). */
export function resetNearMetaRelayer(): void {
  feeAccount = null;
}
