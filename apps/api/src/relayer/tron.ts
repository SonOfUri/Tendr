// Gasless Tron USDT through the TendrForwarder (project 5a, spec §2.3 Tron, §2.5; rulings T9-a …
// T9-e). USDT-TRC20 has no permit, so the shopper signs twice: an exact-amount `approve`, then a
// TIP-712 `TendrPayment`. `gas-tron` lends just enough energy for the approve and pays for
// `payWithApproval`; collected fees go to the `gas-fees-tron` address. Neither the forwarder
// (`TRON_FORWARDER_ADDRESS`, no default) nor the fee address is ever taken from a request.
//
//   options   USDT (TRC-20) only, with the forwarder configured, under the daily loss cap. Live:
//             an account that does not exist on chain (never activated) cannot sign a
//             transaction → `unavailable_reason: tron_account_not_activated`.
//   prepare   a state machine on the quote's approvals (`tron_approvals`):
//               none (or only failed) → step `approve`: the unsigned TRC-20 transaction
//                 `approve(forwarder, amount_in + fee_amount)` from the quote's wallet, built by
//                 Tendr (its ref block is recorded as issued for the quote), fee_limit
//                 TRON_APPROVE_FEE_LIMIT_SUN, expiration = the quote deadline. Spends nothing.
//               one in flight → 409 CONFLICT (`step: approve`): wait for its outcome.
//               one confirmed → step `payment`: the TIP-712 `TendrPayment{token, from, to =
//                 deposit, amount, fee, feeTo = gas-fees-tron, deadline = quote deadline, nonce}`
//                 (the nonce is the quote's: at most one payment per quote can ever execute). The
//                 issue is recorded on the approval (`payment_deadline`).
//             Refused (409 CONFLICT, reason `tron_approval_in_progress`) while another quote's
//             approval of the same wallet could still pay (ruling T9-c, `approvalCanStillPay`):
//             a new approve would overwrite an allowance a signed TendrPayment could still spend.
//   submit    step 1 (`tronApprove`): the shopper's signed approve comes back to Tendr, not to
//             the chain. Session open, quote current, hold claimable, the session limit; then the
//             exact check (contract = USDT, `approve`, spender = forwarder, value = amount + fee,
//             owner = the quote's wallet, nothing else in the transaction, fee_limit bounded,
//             expiration ≤ the quote deadline and not too close, the ref block issued for this
//             quote, signed by the wallet); then the wallet's limit; then the claim (session lock,
//             wallet lock: no other approval of this quote in flight, none of the wallet's that
//             can still pay, no live delegation for the session). Only then `gas-tron` delegates
//             just enough energy (relayer/tron-energy.ts), and once it is in effect Tendr
//             broadcasts the approve exactly as signed (its txid is stored first). Delegations
//             are reclaimed by the energy job.
//             step 2 (`signatures.tendr_payment`): the shared pipeline (relayer/submissions.ts):
//             the signed message must equal the issued one and recover to the wallet; live, the
//             allowance and balance must cover amount + fee and the nonce be unused. Then
//             `gas-tron` signs `payWithApproval` (signing guard: only that call, to the
//             forwarder), the txid and bytes are stored on the submission, and it is broadcast.
//   outcome   `pollTronRelays` (worker): the energy job, then each payment's outcome from
//             `walletsolidity/gettransactioninfobyid` (ruling T9-e): success needs receipt
//             SUCCESS. Cost = the transaction's fee + its energy at the burn price + the approve's
//             cost booked to it. A shopper fee leg's revenue is the forwarder's `TendrPaid.fee`
//             (else a USDT Transfer to gas-fees-tron), capped at the fee signed. Not found while
//             the solidified head is before its expiration → the same bytes are re-sent; past it
//             on two looks ≥ 15 s apart → failed, no gas. Lifecycle as Tasks 5–8.
//
// Test mode never calls the Tron API: a simulated ref block, the same checks (bar the chain
// reads), the approve "lands" at once (its delegation recorded and reclaimed), and so does the
// payment (the simulated 1Click receives the deposit).
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  FORWARDER_DOMAIN_NAME,
  FORWARDER_DOMAIN_VERSION,
  TENDR_PAYMENT_TYPES,
} from '@tendr/contracts';
import { Signature, verifyTypedData } from 'ethers';
import { z } from 'zod';
import { providerFor, simulatedOneClick } from '../checkout/oneclick/index.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { SIMULATED_FEE_USD, nativeUsd } from '../gas/fees.js';
import { lossCapReached } from '../gas/loss-cap.js';
import { planNetworkFee, shopperReason } from '../gas/quote-fee.js';
import { getKeyVault } from '../keyvault/index.js';
import type { KeyVault } from '../keyvault/types.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { recordUnrecovered } from './evm/pimlico.js';
import { deadlineSeconds, gaslessNonce } from './evm/payment.js';
import { feeMovedFrom } from './index.js';
import {
  ACTIVE,
  MIN_RELAY_WINDOW_MS,
  RelayNotBroadcast,
  applyRelayOutcome,
  assertRelayable,
  countAddressAttempt,
  countSessionAttempt,
  gaslessNotAvailable,
  lockOpenSession,
  quoteExpired,
  sponsorshipReleased,
  submissionStatus,
  submitRelayed,
  undoClaim,
} from './submissions.js';
import {
  TRON_APPROVE_FEE_LIMIT_SUN,
  TRON_PAYMENT_FEE_LIMIT_SUN,
  TRON_TX_TTL_MS,
  allowanceOf,
  delegate,
  delegationsFor,
  delegationsReady,
  failApproval,
  gasTronAddress,
  gasTronTx,
  landing,
  lockWallet,
  ownTxCostSun,
  pollTronEnergy,
  resetTronEnergy,
  sendApprove,
  tronApi,
  tronForwarderAddress,
  tronGasFeeAddress,
  walletBlockedBy,
  type EnergyDeps,
} from './tron-energy.js';
import { TRON_REJECTED_CODES, type TronApi } from './tron-rpc.js';
import {
  FORWARDER,
  approveData,
  balanceOfParameter,
  decodeApprove,
  decodeRaw,
  encodeRaw,
  encodeSignedTx,
  isTronAddress,
  nonceUsedParameter,
  rawDataJson,
  recoverSigner,
  refBlockOf,
  tronToEvm,
  txIdOf,
  type RefBlock,
  type TronRaw,
} from './tron-tx.js';
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

export { TRON_EXPIRY_CONFIRM_MS, TRON_RECLAIM_AFTER_MS } from './tron-energy.js';

/**
 * The tokens gasless Tron payments accept (ruling T9-a): Tether's USDT-TRC20 only, as the 1Click
 * token list names it (the bridge's `supported_tokens`; the web pay page's KNOWN_TOKENS).
 */
export const TRON_GASLESS_TOKENS = [
  {
    assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    symbol: 'USDT',
    decimals: 6,
  },
] as const;

export function tronGaslessToken(assetId: string) {
  return TRON_GASLESS_TOKENS.find((t) => t.assetId === assetId) ?? null;
}

/** `to_sign[].kind` of the two steps. */
export const TRON_APPROVE_KIND = 'tron_approve';
export const TRON_PAYMENT_KIND = 'tendr_payment';
/** TIP-712 chain ids (`block.chainid` on the TVM): mainnet live, Nile in test mode. */
export const TRON_CHAIN_IDS = { live: 728126428, test: 3448148188 } as const;
/** Why the Tron option cannot be used now (the pay page explains it). */
export const TRON_NOT_ACTIVATED = 'tron_account_not_activated';
/** An approve whose expiration is closer than this is not funded. */
export const TRON_MIN_APPROVE_WINDOW_MS = MIN_RELAY_WINDOW_MS;
/** How long submit waits for the delegation to take effect before answering `pending`. */
const DELEGATION_WAIT_TRIES = 8;
const DELEGATION_WAIT_MS = 1_000;
/** A claimed payment still `pending` with nothing recorded this long is undone by the poller. */
export const TRON_STALE_PENDING_MS = 3 * 60_000;
/** A recorded but still `pending` payment is taken over by the poller after this long. */
export const TRON_RECORDED_PENDING_MS = 30_000;
const MAX_APPROVE_HEX = 1_000;

const DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const mismatch = (field: string) =>
  new AppError('GASLESS_PAYLOAD_MISMATCH', 'The signed payment does not match this quote', 409, {
    field,
  });
const unavailable = () =>
  new AppError('PROVIDER_UNAVAILABLE', 'Gasless payments are unavailable; try again', 503);
const expired = () =>
  new AppError(
    'GASLESS_EXPIRED',
    'The signed approval has expired; prepare the payment again and sign it',
    409,
  );
const notActivated = () =>
  new AppError(
    'GASLESS_NOT_AVAILABLE',
    'Your Tron account is not activated yet: it needs to receive some TRX once',
    409,
    { reason: TRON_NOT_ACTIVATED },
  );
const inProgress = (details: Record<string, unknown>) =>
  new AppError(
    'CONFLICT',
    'A payment approval from this wallet is still in progress; wait for its outcome',
    409,
    details,
  );
const submitFailed = (reason: string, message: string) =>
  new AppError('GASLESS_SUBMIT_FAILED', message, 409, { reason });

// ---------------------------------------------------------------------------------------------
// Issued ref blocks (the approve's TaPoS reference must be one Tendr handed out for the quote)
// ---------------------------------------------------------------------------------------------

const refKey = (quoteId: string) => `tendr:gasless:tron-ref:${quoteId}`;
const refMember = (r: RefBlock) =>
  `${Buffer.from(r.bytes).toString('hex')}${Buffer.from(r.hash).toString('hex')}`;

async function recordIssuedRef(quoteId: string, ref: RefBlock, ttlS: number) {
  try {
    await getRedis()
      .multi()
      .sadd(refKey(quoteId), refMember(ref))
      .expire(refKey(quoteId), ttlS)
      .exec();
  } catch (err) {
    log('warn', 'tron gasless: store unavailable', { err: String(err) });
    throw unavailable();
  }
}

async function wasIssued(quoteId: string, ref: RefBlock): Promise<boolean> {
  try {
    return (await getRedis().sismember(refKey(quoteId), refMember(ref))) === 1;
  } catch (err) {
    log('warn', 'tron gasless: store unavailable', { err: String(err) });
    throw unavailable();
  }
}

/** Test mode's head block: one per 3 s, a deterministic id (no RPC). */
function simulatedBlockId(now: Date): string {
  const n = BigInt(Math.floor(now.getTime() / 3000));
  const h = createHash('sha256').update(`tendr:simulated-tron-block:${n}`).digest('hex');
  return n.toString(16).padStart(16, '0') + h.slice(16);
}

// ---------------------------------------------------------------------------------------------
// The payment
// ---------------------------------------------------------------------------------------------

/** Everything the two signatures bind: from the quote, the forwarder setting and the fee key. */
interface TronPayment {
  wallet: string;
  token: string;
  deposit: string;
  amount: bigint;
  fee: bigint;
  feeTo: string;
  forwarder: string;
}

/** The step-2 call `submit` relays. */
interface TronPayCall {
  payment: TronPayment;
  message: Record<string, string>;
  signature: string;
}

/** What a payWithApproval submission keeps (`gas_sponsorships.paymaster_data`). */
const StoredSchema = z.object({
  kind: z.literal('tron_forwarder'),
  txId: z.string().regex(/^[0-9a-f]{64}$/),
  signedTx: z.string().min(1),
  /** ms. */
  expiration: z.number().int(),
  /** The approve's cost (sun) this payment carries. */
  approveSun: z.string().regex(/^\d+$/),
  expiredSeenAt: z.number().int().optional(),
});
type StoredTron = z.infer<typeof StoredSchema>;

function storedTron(v: Prisma.JsonValue | null): StoredTron | null {
  const r = StoredSchema.safeParse(v);
  return r.success ? r.data : null;
}

class ClaimLost extends Error {
  constructor() {
    super('the submission is no longer claimed for this quote');
    this.name = 'ClaimLost';
  }
}

const scopeOf = (q: QuoteContext) => ({
  merchantId: q.shopper.merchantId,
  livemode: q.shopper.livemode,
});

/** Field values as the chain sees them: addresses case-insensitively, numbers by value. */
function normalise(type: string, v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== 'string') return null;
  if (type === 'address') return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
  if (type === 'bytes32') return /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null;
  if (type.startsWith('uint')) {
    try {
      return /^(0x[0-9a-fA-F]+|\d+)$/.test(v) ? BigInt(v).toString() : null;
    } catch {
      return null;
    }
  }
  return v;
}

export interface TronDeps {
  api?: TronApi;
  kv?: KeyVault;
  now?: () => Date;
  /** Waits between looks for the delegation (tests: no wait). */
  sleep?: (ms: number) => Promise<void>;
}

export class TronGasless implements GaslessRelayer {
  readonly family = 'tron' as const;

  constructor(
    /** Live: `gas-tron` and TRON_RPC_URL. Test mode: simulated, no Tron API. */
    private readonly live: boolean,
    private readonly deps: TronDeps = {},
  ) {}

  private get api(): TronApi {
    return this.deps.api ?? tronApi();
  }
  private get kv(): KeyVault {
    return this.deps.kv ?? getKeyVault();
  }
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  private energyDeps(): EnergyDeps {
    return { api: this.api, kv: this.kv, now: this.now() };
  }

  /** A Tron API read; any failure is 503 (logged, never the raw error). */
  private async read<T>(what: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (err) {
      if (err instanceof AppError) throw err;
      log('warn', 'tron gasless: Tron API unavailable', { what, err: String(err) });
      throw unavailable();
    }
  }

  async options(c: GaslessContext): Promise<GaslessOption[]> {
    const token = tronGaslessToken(c.origin.assetId);
    if (
      !token ||
      c.origin.blockchain !== 'tron' ||
      !isTronAddress(c.walletAddress) ||
      !tronForwarderAddress()
    ) {
      return [];
    }
    // `gas-tron` pays in every mode: none once the day's loss cap is reached.
    if (await lossCapReached(c.shopper.livemode, this.now())) return [];
    const plan = await planNetworkFee({
      livemode: c.shopper.livemode,
      merchantId: c.shopper.merchantId,
      session: c.session,
      origin: c.origin,
      walletAddress: c.walletAddress,
      method: 'forwarder',
      feeMode: 'token',
    });
    let option: GaslessOption | null = null;
    if (plan.paidBy === 'merchant') {
      option = {
        method: 'forwarder',
        paid_by: 'merchant',
        reason: null,
        fee_modes: [],
        token_fee: null,
      };
    } else if (plan.feeMode === 'token' && plan.tokenAmount) {
      option = {
        method: 'forwarder',
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
    let activated: boolean;
    try {
      activated = await this.api.accountExists(c.walletAddress);
    } catch {
      // Prepare checks again; an API hiccup here should not hide the option.
      activated = true;
    }
    if (activated) return [option];
    return [
      {
        method: 'forwarder',
        paid_by: 'shopper',
        reason: null,
        fee_modes: [],
        token_fee: null,
        unavailable_reason: TRON_NOT_ACTIVATED,
      },
    ];
  }

  /** Everything both signatures bind. */
  private async payment(q: QuoteContext): Promise<TronPayment> {
    const token = tronGaslessToken(q.quote.originAssetId);
    const forwarder = tronForwarderAddress();
    const wallet = q.quote.walletAddress ?? '';
    if (
      !token ||
      !forwarder ||
      q.origin.blockchain !== 'tron' ||
      q.quote.networkFeeMethod !== 'forwarder' ||
      !isTronAddress(wallet) ||
      !isTronAddress(q.quote.depositAddress)
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
      token: token.contract,
      deposit: q.quote.depositAddress,
      amount: BigInt(q.quote.amountIn.toFixed(0)),
      fee: shopperFee ? BigInt(q.quote.networkFeeAmount!.toFixed(0)) : 0n,
      feeTo: await tronGasFeeAddress(this.kv),
      forwarder,
    };
  }

  private async assertUnderLossCap(q: QuoteContext): Promise<void> {
    if (await lossCapReached(q.shopper.livemode, this.now())) throw gaslessNotAvailable();
  }

  /**
   * A merchant-sponsored quote whose hold can no longer be claimed (released, or used by a relay
   * that failed) is refused before the shopper signs or Tendr spends: the page re-quotes first.
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

  private async assertNoActivePayment(q: QuoteContext): Promise<void> {
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
    const p = await this.payment(q);
    await this.assertUnderLossCap(q);
    await this.assertNoActivePayment(q);
    const approvals = await prisma.tronApproval.findMany({
      where: { ...scopeOf(q), quoteId: q.quote.id },
      orderBy: { createdAt: 'desc' },
    });
    const inFlight = approvals.find((a) => a.status === 'pending' || a.status === 'submitted');
    if (inFlight) {
      throw inProgress({ step: 'approve', submission_id: inFlight.id, tx_hash: inFlight.txId });
    }
    const confirmed = approvals.find((a) => a.status === 'confirmed');
    if (confirmed) {
      await this.assertHoldClaimable(q);
      return this.paymentPayload(q, p, confirmed.id);
    }
    await this.assertHoldClaimable(q);
    const blocker = await walletBlockedBy(prisma, p.wallet, q.quote.id, now);
    if (blocker) throw inProgress({ reason: 'tron_approval_in_progress' });
    // Prepare never spends: reads only.
    let blockId: string;
    if (this.live) {
      if (!(await this.read('getaccount', () => this.api.accountExists(p.wallet)))) {
        throw notActivated();
      }
      blockId = (await this.read('getnowblock', () => this.api.nowBlock(false))).id;
    } else {
      blockId = simulatedBlockId(now);
    }
    const ref = refBlockOf(blockId);
    const untilDeadline = q.quote.deadline.getTime() - now.getTime();
    await recordIssuedRef(q.quote.id, ref, Math.ceil(untilDeadline / 1000) + 3600);
    const raw: TronRaw = {
      ref,
      // The approve can never land after the quote deadline.
      expiration: BigInt(q.quote.deadline.getTime()),
      timestamp: BigInt(now.getTime()),
      feeLimit: TRON_APPROVE_FEE_LIMIT_SUN,
      contract: {
        type: 'trigger',
        owner: p.wallet,
        contract: p.token,
        data: approveData(p.forwarder, p.amount + p.fee),
      },
    };
    const bytes = encodeRaw(raw);
    return {
      quote_id: q.quote.id,
      method: 'forwarder',
      chain: q.origin.blockchain,
      chain_id: this.chainId(),
      signer: p.wallet,
      deadline: q.quote.deadline.toISOString(),
      amount: p.amount.toString(),
      fee_amount: p.fee.toString(),
      step: 'approve',
      to_sign: [
        {
          kind: TRON_APPROVE_KIND,
          typed_data: {
            /** Sign as is (TronLink `trx.sign`) and send it back: Tendr broadcasts it. */
            transaction: {
              txID: txIdOf(bytes),
              raw_data: rawDataJson(raw),
              raw_data_hex: Buffer.from(bytes).toString('hex'),
              visible: false,
            },
            owner: p.wallet,
            token: p.token,
            spender: p.forwarder,
            value: (p.amount + p.fee).toString(),
            fee_limit: TRON_APPROVE_FEE_LIMIT_SUN.toString(),
            expiration: q.quote.deadline.toISOString(),
            /** Pays the energy (shown to the shopper). */
            relayer: await gasTronAddress(this.kv),
          },
        },
      ],
    };
  }

  private chainId(): number {
    return this.live ? TRON_CHAIN_IDS.live : TRON_CHAIN_IDS.test;
  }

  /** The TendrPayment message for the quote (deadline recorded on the approval at issue). */
  private expectedMessage(q: QuoteContext, p: TronPayment, deadline: Date) {
    return {
      token: tronToEvm(p.token),
      from: tronToEvm(p.wallet),
      to: tronToEvm(p.deposit),
      amount: p.amount.toString(),
      fee: p.fee.toString(),
      feeTo: tronToEvm(p.feeTo),
      deadline: deadlineSeconds(deadline).toString(),
      nonce: gaslessNonce(q.quote.id, 'tendr_payment'),
    };
  }

  private domain(p: TronPayment) {
    return {
      name: FORWARDER_DOMAIN_NAME,
      version: FORWARDER_DOMAIN_VERSION,
      chainId: this.chainId(),
      verifyingContract: tronToEvm(p.forwarder),
    };
  }

  /** Step 2: issues (once) and returns the TendrPayment to sign for the confirmed approval. */
  private async paymentPayload(
    q: QuoteContext,
    p: TronPayment,
    approvalId: string,
  ): Promise<PreparePayload> {
    await prisma.$transaction(async (tx) => {
      await lockWallet(tx, p.wallet);
      await tx.tronApproval.updateMany({
        where: { id: approvalId, status: 'confirmed', paymentDeadline: null },
        data: { paymentDeadline: q.quote.deadline },
      });
    });
    return {
      quote_id: q.quote.id,
      method: 'forwarder',
      chain: q.origin.blockchain,
      chain_id: this.chainId(),
      signer: p.wallet,
      deadline: q.quote.deadline.toISOString(),
      amount: p.amount.toString(),
      fee_amount: p.fee.toString(),
      step: 'payment',
      to_sign: [
        {
          kind: TRON_PAYMENT_KIND,
          typed_data: {
            domain: this.domain(p),
            types: { EIP712Domain: DOMAIN_TYPE, ...TENDR_PAYMENT_TYPES },
            primaryType: 'TendrPayment',
            message: this.expectedMessage(q, p, q.quote.deadline),
          },
        },
      ],
    };
  }

  async submit(q: QuoteContext, signed: SignedPayload): Promise<SubmitResult> {
    if (signed.tronApprove) return this.submitApprove(q, signed);
    const res = await submitRelayed<TronPayCall>(
      q,
      signed,
      (qq, s) => this.verifyPayment(qq, s),
      (call, submission) => this.broadcastPayment(q, call, submission.id),
    );
    if (this.live || res.status !== 'submitted') return { ...res, step: 'payment' };
    await this.simulateLanded(q, res.submissionId, res.txHash!);
    return { ...res, status: 'confirmed', step: 'payment' };
  }

  // -------------------------------------------------------------------------------------------
  // Step 1: the approve
  // -------------------------------------------------------------------------------------------

  /** Checks the signed approve against the quote (ruling T9-b); nothing is spent. */
  private async verifyApprove(q: QuoteContext, p: TronPayment, signed: SignedPayload) {
    const a = signed.tronApprove!;
    if (
      signed.transaction !== undefined ||
      signed.signedDelegate !== undefined ||
      Object.keys(signed.signatures).length > 0
    ) {
      throw mismatch('tron_approve');
    }
    const hex = a.rawDataHex.toLowerCase();
    const sigHex = a.signature.replace(/^0x/i, '').toLowerCase();
    if (!/^([0-9a-f]{2})+$/.test(hex) || hex.length > MAX_APPROVE_HEX)
      throw mismatch('tron_approve');
    if (!/^[0-9a-f]{130}$/.test(sigHex)) throw mismatch('tron_approve.signature');
    const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
    let raw: TronRaw;
    try {
      raw = decodeRaw(bytes);
    } catch {
      throw mismatch('tron_approve');
    }
    const c = raw.contract;
    if (c.type !== 'trigger' || c.contract !== p.token) throw mismatch('tron_approve.contract');
    if (c.owner !== p.wallet) throw mismatch('tron_approve.owner');
    const call = decodeApprove(c.data);
    if (!call) throw mismatch('tron_approve.data');
    if (call.spender !== p.forwarder) throw mismatch('tron_approve.spender');
    if (call.value !== p.amount + p.fee) throw mismatch('tron_approve.value');
    if (raw.feeLimit <= 0n || raw.feeLimit > TRON_APPROVE_FEE_LIMIT_SUN) {
      throw mismatch('tron_approve.fee_limit');
    }
    if (raw.expiration > BigInt(q.quote.deadline.getTime())) {
      throw mismatch('tron_approve.expiration');
    }
    if (raw.expiration < BigInt(this.now().getTime() + TRON_MIN_APPROVE_WINDOW_MS)) throw expired();
    if (!(await wasIssued(q.quote.id, raw.ref))) throw mismatch('tron_approve.ref_block');
    const txId = txIdOf(bytes);
    const signature = Uint8Array.from(Buffer.from(sigHex, 'hex'));
    if (recoverSigner(txId, signature) !== p.wallet) throw mismatch('tron_approve.signature');
    return {
      raw,
      txId,
      rawBytes: bytes.length,
      signedHex: encodeSignedTx(bytes, signature),
    };
  }

  private async submitApprove(q: QuoteContext, signed: SignedPayload): Promise<SubmitResult> {
    const now = this.now();
    const scope = scopeOf(q);
    assertRelayable(q, now);
    const p = await this.payment(q);
    await this.assertUnderLossCap(q);
    await this.assertNoActivePayment(q);
    await this.assertHoldClaimable(q);
    const mine = await prisma.tronApproval.findMany({
      where: {
        ...scope,
        quoteId: q.quote.id,
        status: { in: ['pending', 'submitted', 'confirmed'] },
      },
    });
    if (mine.length) {
      throw inProgress({ step: 'approve', submission_id: mine[0]!.id, tx_hash: mine[0]!.txId });
    }
    await countSessionAttempt(q);
    const v = await this.verifyApprove(q, p, signed);
    let needs: Awaited<ReturnType<typeof delegationsFor>> = [];
    if (this.live) {
      if (!(await this.read('getaccount', () => this.api.accountExists(p.wallet)))) {
        throw notActivated();
      }
      const gasTron = await gasTronAddress(this.kv);
      needs = await this.read('resources', () =>
        delegationsFor(
          this.api,
          {
            wallet: p.wallet,
            token: p.token,
            spender: p.forwarder,
            value: p.amount + p.fee,
            rawBytes: v.rawBytes,
          },
          gasTron,
        ),
      );
    }
    await countAddressAttempt(q, now);

    // The claim: the session lock and the wallet lock, every rule checked again inside them.
    const id = newId('tap');
    await tenantTransaction(scope, async (tx) => {
      await lockOpenSession(tx, scope, q.session.id, now);
      const quote = await tx.quote.findFirst({
        where: { ...scope, id: q.quote.id, sessionId: q.session.id },
      });
      if (!quote || quote.supersededAt) throw quoteExpired('was replaced by a newer one');
      if (quote.deadline.getTime() - MIN_RELAY_WINDOW_MS <= now.getTime()) {
        throw quoteExpired('has expired');
      }
      await lockWallet(tx, p.wallet);
      const again = await tx.tronApproval.findFirst({
        where: {
          ...scope,
          quoteId: q.quote.id,
          status: { in: ['pending', 'submitted', 'confirmed'] },
        },
      });
      if (again)
        throw inProgress({ step: 'approve', submission_id: again.id, tx_hash: again.txId });
      if (await walletBlockedBy(tx, p.wallet, q.quote.id, now)) {
        throw inProgress({ reason: 'tron_approval_in_progress' });
      }
      // One live delegation at a time: per session, and per receiving address.
      const live = await tx.tronDelegation.findFirst({
        where: {
          status: { in: ['delegating', 'delegated', 'reclaiming'] },
          OR: [{ receiver: p.wallet }, { approval: { sessionId: q.session.id } }],
        },
        select: { id: true },
      });
      if (live) throw inProgress({ reason: 'tron_delegation_active' });
      await tx.tronApproval.create({
        data: {
          id,
          ...scope,
          sessionId: q.session.id,
          quoteId: q.quote.id,
          wallet: p.wallet,
          txId: v.txId,
          signedTx: v.signedHex,
          expiration: new Date(Number(v.raw.expiration)),
          status: this.live ? 'pending' : 'confirmed',
          ...(this.live ? {} : { broadcastAt: now, costSun: 0n }),
        },
      });
    });
    if (!this.live) return this.simulateApprove(id, p, v.txId, now);

    // Spend: just enough energy, then (once it is in effect) the approve itself.
    const d = this.energyDeps();
    let ok: boolean;
    try {
      ok = await delegate(d, { id, livemode: scope.livemode, wallet: p.wallet }, needs);
    } catch (err) {
      log('warn', 'tron gasless: delegation not sent', { approvalId: id, err: String(err) });
      ok = false;
    }
    if (!ok) {
      await failApproval(d, id, 'the energy delegation could not be made', null);
      throw unavailable();
    }
    for (let i = 0; i < DELEGATION_WAIT_TRIES; i++) {
      let ready: 'ready' | 'failed' | 'pending';
      try {
        ready = await delegationsReady(this.energyDeps(), id);
      } catch (err) {
        log('warn', 'tron gasless: delegation lookup failed', { approvalId: id, err: String(err) });
        ready = 'pending';
      }
      if (ready === 'failed') {
        await failApproval(d, id, 'the energy delegation failed', null);
        throw unavailable();
      }
      if (ready === 'ready') {
        const sent = await sendApprove(this.energyDeps(), { id, signedTx: v.signedHex });
        if (sent === 'refused') {
          throw submitFailed(
            'approve_refused',
            'The approval could not be submitted: the chain refused it. Request a new quote',
          );
        }
        return { submissionId: id, txHash: v.txId, status: 'submitted', step: 'approve' };
      }
      await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
        DELEGATION_WAIT_MS,
      );
    }
    // The energy job sends the approve once the delegation is in effect.
    return { submissionId: id, txHash: v.txId, status: 'pending', step: 'approve' };
  }

  /** Test mode: the delegation and the approve "land" at once; the delegation is reclaimed. */
  private async simulateApprove(
    id: string,
    p: TronPayment,
    txId: string,
    now: Date,
  ): Promise<SubmitResult> {
    const sim = (what: string) =>
      createHash('sha256').update(`tendr:simulated-tron:${what}:${id}`).digest('hex');
    await prisma.tronDelegation.create({
      data: {
        id: newId('tdl'),
        approvalId: id,
        livemode: false,
        resource: 'energy',
        receiver: p.wallet,
        balanceSun: 0n,
        units: 0n,
        status: 'reclaimed',
        delegateTxId: sim('delegate'),
        delegateTx: '',
        delegateExpiration: now,
        delegatedAt: now,
        undelegateTxId: sim('undelegate'),
        reclaimedAt: now,
      },
    });
    return { submissionId: id, txHash: txId, status: 'confirmed', step: 'approve' };
  }

  // -------------------------------------------------------------------------------------------
  // Step 2: the TendrPayment and payWithApproval
  // -------------------------------------------------------------------------------------------

  private async verifyPayment(q: QuoteContext, signed: SignedPayload): Promise<TronPayCall> {
    if (signed.transaction !== undefined || signed.signedDelegate !== undefined) {
      throw mismatch(TRON_PAYMENT_KIND);
    }
    const extra = Object.keys(signed.signatures).find((k) => k !== TRON_PAYMENT_KIND);
    if (extra) throw mismatch(extra);
    const given = signed.signatures[TRON_PAYMENT_KIND];
    if (!given) throw mismatch(TRON_PAYMENT_KIND);
    await this.assertUnderLossCap(q);
    const p = await this.payment(q);
    const approval = await prisma.tronApproval.findFirst({
      where: {
        ...scopeOf(q),
        quoteId: q.quote.id,
        status: 'confirmed',
        paymentDeadline: { not: null },
      },
    });
    if (!approval) {
      throw new AppError('CONFLICT', 'Approve the payment first, then prepare and sign it', 409, {
        step: 'approve',
      });
    }
    const expected = this.expectedMessage(q, p, approval.paymentDeadline!);
    const fields = TENDR_PAYMENT_TYPES.TendrPayment;
    const keys = Object.keys(given.message ?? {});
    if (keys.length !== fields.length || keys.some((k) => !fields.some((f) => f.name === k))) {
      throw mismatch(`${TRON_PAYMENT_KIND}.message`);
    }
    for (const f of fields) {
      const want = expected[f.name as keyof typeof expected];
      if (normalise(f.type, given.message[f.name]) !== normalise(f.type, want)) {
        throw mismatch(`${TRON_PAYMENT_KIND}.${f.name}`);
      }
    }
    let sig: Signature;
    let signer: string;
    try {
      sig = Signature.from(given.signature);
      signer = verifyTypedData(this.domain(p), TENDR_PAYMENT_TYPES, expected, sig);
    } catch {
      throw mismatch(`${TRON_PAYMENT_KIND}.signature`);
    }
    if (signer.toLowerCase() !== tronToEvm(p.wallet)) throw mismatch(`${TRON_PAYMENT_KIND}.signer`);
    if (this.live) {
      // Spend only on a payment the chain will execute.
      const need = p.amount + p.fee;
      const allowance = await this.read('allowance', () =>
        allowanceOf(this.api, p.token, p.wallet, p.forwarder),
      );
      if (allowance < need) {
        throw submitFailed('allowance', 'The approved amount does not cover this payment');
      }
      const balance = await this.read('balanceOf', () =>
        this.api.constantCall(
          p.wallet,
          p.token,
          'balanceOf(address)',
          balanceOfParameter(p.wallet),
        ),
      );
      if (BigInt(`0x${balance.result || '0'}`) < need) {
        throw submitFailed(
          'insufficient_token_balance',
          'Your token balance does not cover this payment',
        );
      }
      const used = await this.read('nonceUsed', () =>
        this.api.constantCall(
          p.wallet,
          p.forwarder,
          'nonceUsed(address,bytes32)',
          nonceUsedParameter(p.wallet, expected.nonce),
        ),
      );
      if (BigInt(`0x${used.result || '0'}`) !== 0n) {
        throw submitFailed('nonce_used', 'This payment was already made');
      }
    }
    return { payment: p, message: expected, signature: sig.serialized };
  }

  /**
   * Sign (gas-tron, guarded) → store the txid, the bytes and the approve's cost on the submission
   * → broadcast. A node refusal → not broadcast (the claim is undone, the approve's cost is
   * unbooked). Anything else → `submitted` with its known txid (the poller re-sends).
   */
  private async broadcastPayment(
    q: QuoteContext,
    call: TronPayCall,
    id: string,
  ): Promise<{ txHash: string }> {
    if (!this.live) return { txHash: simulatedTronTxId(id) };
    const scope = scopeOf(q);
    const p = call.payment;
    const m = call.message;
    const d = this.energyDeps();
    let tx: Awaited<ReturnType<typeof gasTronTx>>;
    try {
      const data = FORWARDER.encodeFunctionData('payWithApproval', [
        {
          token: m.token,
          from: m.from,
          to: m.to,
          amount: BigInt(m.amount!),
          fee: BigInt(m.fee!),
          feeTo: m.feeTo,
          deadline: BigInt(m.deadline!),
          nonce: m.nonce,
        },
        call.signature,
      ]);
      const deadlineMs = Number(m.deadline!) * 1000;
      tx = await gasTronTx(
        d,
        {
          type: 'trigger',
          owner: await gasTronAddress(this.kv),
          contract: p.forwarder,
          data: Uint8Array.from(Buffer.from(data.slice(2), 'hex')),
        },
        {
          expiration: new Date(Math.min(d.now.getTime() + TRON_TX_TTL_MS, deadlineMs)),
          feeLimit: TRON_PAYMENT_FEE_LIMIT_SUN,
        },
      );
    } catch (err) {
      log('warn', 'tron gasless: payment transaction not signed', {
        submissionId: id,
        err: String(err),
      });
      throw new RelayNotBroadcast('the payment transaction could not be signed', 'unavailable');
    }
    try {
      await prisma.$transaction(async (t) => {
        const approvals = await t.tronApproval.findMany({
          where: { ...scope, quoteId: q.quote.id, status: 'confirmed', costBookedTo: null },
          select: { id: true, costSun: true },
        });
        const approveSun = approvals.reduce((s, a) => s + (a.costSun ?? 0n), 0n);
        const stored: StoredTron = {
          kind: 'tron_forwarder',
          txId: tx.txId,
          signedTx: tx.signedHex,
          expiration: tx.expiration.getTime(),
          approveSun: approveSun.toString(),
        };
        const { count } = await t.gasSponsorship.updateMany({
          where: { ...scope, id, quoteId: q.quote.id, status: 'pending' },
          data: { txHash: tx.txId, paymasterData: stored as unknown as Prisma.InputJsonValue },
        });
        if (count !== 1) throw new ClaimLost();
        if (approvals.length) {
          await t.tronApproval.updateMany({
            where: { id: { in: approvals.map((a) => a.id) }, costBookedTo: null },
            data: { costBookedTo: id },
          });
        }
      });
    } catch (err) {
      if (err instanceof ClaimLost) {
        throw new AppError(
          'QUOTE_EXPIRED',
          'This payment attempt was abandoned; request a new quote',
          409,
        );
      }
      log('warn', 'tron gasless: could not record the transaction', {
        submissionId: id,
        err: String(err),
      });
      throw new RelayNotBroadcast('the transaction could not be recorded', 'unavailable');
    }
    let res;
    try {
      res = await this.api.broadcastHex(tx.signedHex);
    } catch (err) {
      log('warn', 'tron gasless: broadcast outcome unknown; the poller re-sends', {
        submissionId: id,
        err: String(err),
      });
      return { txHash: tx.txId };
    }
    if (!res.ok && TRON_REJECTED_CODES.has(res.code)) {
      await unbookApprovals(id);
      log('warn', 'tron gasless: the node refused the payment', {
        submissionId: id,
        code: res.code,
      });
      throw new RelayNotBroadcast(`${res.code} ${res.message}`, 'simulation_reverted');
    }
    return { txHash: tx.txId };
  }

  /** Test mode: the payment "lands" at once and the deposit reaches the simulated 1Click. */
  private async simulateLanded(q: QuoteContext, id: string, txHash: string): Promise<void> {
    const applied = await applyRelayOutcome(id, {
      status: 'confirmed',
      txHash,
      gasUsed: 160_000n,
      costUsd: SIMULATED_FEE_USD[q.origin.blockchain] ?? null,
      reason: null,
      // The simulated forwarder moves exactly the signed fee.
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
      log('warn', 'simulated tron: deposit simulation failed', {
        submissionId: id,
        err: String(err),
      });
    }
  }

  async status(submissionId: string): Promise<SubmissionStatus> {
    if (submissionId.startsWith('tap_')) {
      const a = await prisma.tronApproval.findUnique({
        where: { id: submissionId },
        select: { status: true },
      });
      if (a) return a.status;
    }
    return submissionStatus(submissionId);
  }
}

/** The approve's cost no longer rides on this submission (it was not broadcast, or never ran). */
async function unbookApprovals(submissionId: string): Promise<void> {
  try {
    await prisma.tronApproval.updateMany({
      where: { costBookedTo: submissionId },
      data: { costBookedTo: null },
    });
  } catch (err) {
    log('error', 'tron gasless: approval cost not unbooked', { submissionId, err: String(err) });
  }
}

/** Test mode: a deterministic, obviously simulated Tron transaction id (hex, 32 bytes). */
export function simulatedTronTxId(submissionId: string): string {
  return createHash('sha256').update(`tendr:simulated-tron-payment:${submissionId}`).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/**
 * One pass of the Tron relayer (worker): the energy job (relayer/tron-energy.ts), then each
 * payWithApproval submission awaiting its outcome (see the file header). Returns how many rows
 * changed state.
 */
export async function pollTronRelays(
  deps: { api?: TronApi; kv?: KeyVault; now?: () => Date; livemode?: boolean } = {},
): Promise<number> {
  const livemode = deps.livemode ?? true;
  const api = deps.api ?? tronApi();
  const kv = deps.kv ?? getKeyVault();
  const now = deps.now?.() ?? new Date();
  let changed = await pollTronEnergy({ api, kv, now: () => now, livemode });
  const rows = await prisma.gasSponsorship.findMany({
    where: {
      livemode,
      method: 'forwarder',
      provider: 'gas-tron',
      quoteId: { not: null },
      status: { in: ['pending', 'submitted'] },
    },
    include: { quote: true },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  for (const row of rows) {
    const scope = { merchantId: row.merchantId, livemode: row.livemode };
    try {
      if (!row.quote) continue;
      const stored = storedTron(row.paymasterData);
      if (!stored) {
        // Claimed, but nothing was ever signed and stored: nothing can have been sent.
        if (row.status === 'pending') {
          if (now.getTime() - row.updatedAt.getTime() >= TRON_STALE_PENDING_MS) {
            await undoClaim(scope, row.id, 'the transaction was never recorded or sent');
            changed++;
          }
          continue;
        }
        log('error', 'tron gasless: submitted row without its transaction', {
          sponsorshipId: row.id,
        });
        await touch(row.id, now);
        continue;
      }
      if (row.status === 'pending') {
        // Recorded, not marked: a submit still sending, or one that stopped (it may have sent).
        if (now.getTime() - row.updatedAt.getTime() < TRON_RECORDED_PENDING_MS) continue;
        await markSent(scope, row.id, row.quote, stored.txId, now);
      }
      if (await applyOutcome(api, { ...row, quote: row.quote }, stored, now)) changed++;
    } catch (err) {
      log('warn', 'tron gasless: outcome lookup failed', {
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
  return changed;
}

async function markSent(
  scope: { merchantId: string; livemode: boolean },
  id: string,
  quote: { id: string; depositAddress: string },
  txId: string,
  now: Date,
): Promise<void> {
  await tenantTransaction(scope, async (t) => {
    await t.gasSponsorship.updateMany({
      where: { ...scope, id, status: 'pending' },
      data: { status: 'submitted', txHash: txId },
    });
    await t.quote.updateMany({
      where: { ...scope, id: quote.id, depositTxHash: null },
      data: { depositTxHash: txId, depositTxSubmittedAt: now },
    });
  });
  try {
    await providerFor(scope.livemode).submitDeposit(txId, quote.depositAddress);
  } catch (err) {
    log('warn', 'tron gasless: 1Click deposit notice failed', {
      sponsorshipId: id,
      err: String(err),
    });
  }
}

async function applyOutcome(
  api: TronApi,
  row: {
    id: string;
    livemode: boolean;
    sponsor: string;
    feeAmount: Prisma.Decimal | null;
    quote: { originAssetId: string };
  },
  stored: StoredTron,
  now: Date,
): Promise<boolean> {
  const l = await landing(
    api,
    stored.txId,
    new Date(stored.expiration),
    stored.expiredSeenAt !== undefined ? new Date(stored.expiredSeenAt) : null,
    now,
    true,
  );
  if (!('info' in l)) {
    if (l.state === 'pending') {
      try {
        await api.broadcastHex(stored.signedTx);
      } catch (err) {
        log('warn', 'tron gasless: re-send failed', { sponsorshipId: row.id, err: String(err) });
      }
      const { expiredSeenAt: _cleared, ...rest } = stored;
      await touch(row.id, now, stored.expiredSeenAt !== undefined ? rest : undefined);
      return false;
    }
    if (l.state === 'first-expired') {
      await touch(
        row.id,
        now,
        stored.expiredSeenAt === undefined
          ? { ...stored, expiredSeenAt: now.getTime() }
          : undefined,
      );
      return false;
    }
    // It can never land: failed, no gas spent; the approve's cost goes back to the approval.
    const did = await applyRelayOutcome(
      row.id,
      {
        status: 'failed',
        txHash: null,
        gasUsed: null,
        costUsd: null,
        reason: 'payWithApproval never landed (expired)',
        feeMoved: null,
      },
      now,
    );
    if (did) await unbookApprovals(row.id);
    return did;
  }
  const info = l.info;
  const ok = info.result !== 'FAILED' && info.receiptResult === 'SUCCESS';
  let costUsd: string | null = null;
  let energy = info.energyUsage;
  try {
    const price = await api.energyPrice();
    // Energy from stake plus energy bought by burning TRX.
    energy += info.energyFee / price;
    const sun = ownTxCostSun(info, price) + BigInt(stored.approveSun);
    costUsd = await nativeUsd('tron', sun, row.livemode);
  } catch (err) {
    log('warn', 'tron gasless: cost unpriced', { sponsorshipId: row.id, err: String(err) });
  }
  let feeMoved: bigint | null = null;
  const forwarder = tronForwarderAddress();
  const token = tronGaslessToken(row.quote.originAssetId);
  if (ok && row.sponsor === 'shopper' && forwarder && token && row.feeAmount) {
    feeMoved = feeMovedFrom(
      info.logs.map((x) => ({
        address: `0x${x.address.slice(-40)}`,
        topics: x.topics.map((t) => `0x${t}`),
        data: `0x${x.data}`,
      })),
      {
        forwarder: tronToEvm(forwarder),
        token: tronToEvm(token.contract),
        feeTo: tronToEvm(await tronGasFeeAddress()),
        cap: BigInt(row.feeAmount.toFixed(0)),
      },
    );
  }
  const did = await applyRelayOutcome(
    row.id,
    {
      status: ok ? 'confirmed' : 'failed',
      txHash: stored.txId,
      gasUsed: energy,
      costUsd,
      reason: ok ? null : `payWithApproval failed (${info.receiptResult ?? 'FAILED'})`,
      feeMoved,
    },
    now,
  );
  if (did) await recordUnrecovered(row.id, now);
  return did;
}

async function touch(id: string, now: Date, stored?: StoredTron): Promise<void> {
  await prisma.gasSponsorship.updateMany({
    where: { id, status: { in: ['pending', 'submitted'] } },
    data: {
      updatedAt: now,
      ...(stored ? { paymasterData: stored as unknown as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Drops cached state (tests). */
export function resetTronRelayer(): void {
  resetTronEnergy();
}
