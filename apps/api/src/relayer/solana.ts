// Gasless Solana token payments through Pimlico's Solana paymaster (project 5a, spec §2.3 Solana,
// §2.5, §9.1; rulings T7-a … T7-d, fix-round rulings I1–I3). Pimlico runs Kora
// (`https://solana.pimlico.io/v1/{mainnet|devnet}/rpc?apikey=…`, network PIMLICO_SOLANA_NETWORK,
// key = the stored `pimlico` secret, never sent to the browser or logged).
//
//   prepare   refused (409 CONFLICT) while a submission of the quote may still land. Then the
//             paymaster's fee payer (`getPayerSigner`) and a fresh blockhash (`getBlockhash`),
//             and the v0 transaction of relayer/solana-tx.ts: the payment `transferChecked` of
//             `amount_in` to the deposit address's token account (created, paymaster as rent
//             payer, when it does not exist yet), plus, when the shopper pays the fee, a
//             `transferChecked` of `fee_amount` to the `gas-fees-solana` token account. Always
//             sponsored by Pimlico (no Kora payment instruction, ruling T7-a). The blockhash is
//             recorded (Redis) as issued for the quote, with the time and that fee payer.
//   submit    the shared pipeline (relayer/submissions.ts) with the Solana check: the blockhash
//             must have been issued for this quote at most 60 s ago (else 409 GASLESS_EXPIRED),
//             and the partially signed transaction must be EXACTLY the quote's payment (ruling
//             T7-b), signed by the quote's wallet, fee payer = the recorded paymaster. Tendr's
//             daily loss cap refuses in both modes. Then:
//               1. Kora `signTransaction`: the paymaster co-signs; nothing is sent. Any failure
//                  → not broadcast (claim undone, the shopper may retry).
//               2. The returned bytes must be ours plus a valid fee-payer signature: that
//                  signature is the transaction id.
//               3. The id and the signed bytes are stored on the submission (a failure → not
//                  broadcast).
//               4. Tendr broadcasts through SOLANA_RPC_URL `sendTransaction`. A preflight
//                  refusal → not broadcast (claim undone). Any other failure → `submitted`
//                  anyway: the poller re-sends the same bytes.
//   outcome   `pollSolanaRelays` (worker), on the known id: `getSignatureStatuses` (confirmed)
//             then `getTransaction`. The actual cost is what the fee payer's balance lost (fee +
//             rent); a shopper fee leg's revenue is the gas-fee token account's balance change
//             (capped at the fee signed). Not seen while the blockhash is valid → the same bytes
//             are sent again; never landed once it expired → failed, no gas. Settlement, release
//             and loss follow the shared lifecycle; cost above what is recovered counts toward
//             the daily loss cap.
//
// Native SOL is never routed here (its sender pays its own fee). Test mode never calls Pimlico or
// a Solana RPC: a simulated fee payer and blockhash, the same checks, and the transaction is
// "landed" at once.
import { TEST_SOLANA_BLOCKHASH } from '@tendr/contracts';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import bs58 from 'bs58';
import { z } from 'zod';
import { isValidAddress } from '../checkout/address-format.js';
import { providerFor, simulatedOneClick } from '../checkout/oneclick/index.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { SIMULATED_FEE_USD, nativeUsd, solanaComputeUnitPrice } from '../gas/fees.js';
import { lossCapReached } from '../gas/loss-cap.js';
import { planNetworkFee, shopperReason } from '../gas/quote-fee.js';
import { getKeyVault } from '../keyvault/index.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { recordUnrecovered } from './evm/pimlico.js';
import {
  KoraClient,
  KoraError,
  SolanaRpc,
  SolanaRpcError,
  isSignature,
  type SolanaTransaction,
  type TokenBalance,
} from './solana-clients.js';
import {
  ACTIVE,
  RelayNotBroadcast,
  applyRelayOutcome,
  assertRelayable,
  gaslessNotAvailable,
  submissionStatus,
  submitRelayed,
  undoClaim,
} from './submissions.js';
import {
  SOLANA_GASLESS_CU_LIMIT,
  SOLANA_MAX_CU_PRICE,
  SolanaTxMismatch,
  associatedTokenAccount,
  buildPaymentTransaction,
  checkPaymentTransaction,
  feePayerSignature,
  isSolanaAddress,
  solanaGaslessToken,
  transactionBlockhash,
  type SolanaPayment,
} from './solana-tx.js';
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

export { KoraClient, KoraError, SolanaRpc } from './solana-clients.js';

/** A blockhash older than this at submit is refused (it expires on chain after ~60–90 s). */
export const SOLANA_BLOCKHASH_MAX_AGE_MS = 60_000;
/**
 * A claimed submission still `pending` with no signed transaction stored this long after its last
 * change is undone by the poller: nothing can have been sent for it (the transaction is stored
 * before any broadcast) and its blockhash is past use.
 */
export const SOLANA_STALE_PENDING_MS = 3 * 60_000;
/**
 * A recorded but still `pending` submission (its submit stopped after recording) is taken over by
 * the poller only this long after its last change, so it never races a submit still sending.
 */
export const SOLANA_RECORDED_PENDING_MS = 30_000;
/**
 * "Never landed" needs two looks at least this far apart (one poll interval), both finding the
 * blockhash invalid at the finalized root and the signature unknown.
 */
export const SOLANA_EXPIRY_CONFIRM_MS = 15_000;
/** How long the paymaster's fee payer address is reused at prepare. */
const PAYER_CACHE_MS = 10 * 60_000;
/** Test mode: the compute-unit price the simulated transaction sets. */
const SIMULATED_CU_PRICE = 1_000n;
/** The `to_sign[].kind` of a Solana payment. */
export const SOLANA_TO_SIGN_KIND = 'solana_transaction';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Test mode's paymaster fee payer (no key behind it). */
export const SIMULATED_KORA_PAYER = bs58.encode(sha256('tendr:simulated-kora-payer'));

const mismatch = (field: string) =>
  new AppError('GASLESS_PAYLOAD_MISMATCH', 'The signed payment does not match this quote', 409, {
    field,
  });
const unavailable = () =>
  new AppError('PROVIDER_UNAVAILABLE', 'Gasless payments are unavailable; try again', 503);
const expired = () =>
  new AppError(
    'GASLESS_EXPIRED',
    'The signed transaction has expired; prepare the payment again and sign it',
    409,
  );

let feeOwner: string | null = null;

/** Tendr's Solana gas-fee owner (the `gas-fees-solana` key, receive-only). */
export async function solanaGasFeeAddress(): Promise<string> {
  if (feeOwner) return feeOwner;
  const { curve, raw } = await getKeyVault().publicKey('gas-fees-solana');
  if (curve !== 'ed25519' || raw.length !== 32) {
    throw new Error('gas-fees-solana is not an ed25519 key');
  }
  feeOwner = bs58.encode(raw);
  return feeOwner;
}

// ---------------------------------------------------------------------------------------------
// Issued blockhashes
// ---------------------------------------------------------------------------------------------

const blockhashKey = (quoteId: string, blockhash: string) =>
  `tendr:gasless:sol-bh:${quoteId}:${blockhash}`;

interface IssuedBlockhash {
  at: number;
  /** The paymaster fee payer the transaction was built for. */
  feePayer: string;
}

async function recordBlockhash(quoteId: string, blockhash: string, v: IssuedBlockhash) {
  try {
    await getRedis().set(blockhashKey(quoteId, blockhash), JSON.stringify(v), 'EX', 300);
  } catch (err) {
    log('warn', 'solana gasless: blockhash store unavailable', { err: String(err) });
    throw unavailable();
  }
}

/** When (and for which fee payer) Tendr issued `blockhash` for the quote; null if it never did. */
async function blockhashIssued(
  quoteId: string,
  blockhash: string,
): Promise<IssuedBlockhash | null> {
  let v: string | null;
  try {
    v = await getRedis().get(blockhashKey(quoteId, blockhash));
  } catch (err) {
    log('warn', 'solana gasless: blockhash store unavailable', { err: String(err) });
    throw unavailable();
  }
  if (v === null) return null;
  const r = z
    .object({ at: z.number().finite(), feePayer: z.string() })
    .safeParse(JSON.parse(v) as unknown);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------------------------
// The relayer
// ---------------------------------------------------------------------------------------------

/** What a Kora submission keeps (`gas_sponsorships.paymaster_data`), stored before broadcast. */
interface StoredKora {
  kind: 'kora';
  blockhash: string;
  feePayer: string;
  /** The fee payer's signature: the transaction id. */
  signature: string;
  /** The fully signed transaction (base64): re-sent as is until it lands or expires. */
  transaction: string;
  /** When the poller first found the blockhash expired and the signature unknown (ms). */
  expiredSeenAt?: number;
}

const StoredKoraSchema = z.object({
  kind: z.literal('kora'),
  blockhash: z.string(),
  feePayer: z.string(),
  signature: z.string(),
  transaction: z.string(),
  expiredSeenAt: z.number().finite().optional(),
});

function storedKora(v: Prisma.JsonValue | null): StoredKora | null {
  const r = StoredKoraSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** The checked transaction `submit` relays. */
interface SolanaRelayCall {
  transaction: string;
  blockhash: string;
  feePayer: string;
}

export interface SolanaGaslessDeps {
  kora?: KoraClient;
  rpc?: SolanaRpc;
  /** Live compute-unit price (micro-lamports); default the median recent priority fee. */
  priorityFee?: () => Promise<bigint>;
  now?: () => Date;
  /** Records the signed transaction on the claimed submission (default: the DB; tests fail it). */
  record?: typeof recordSigned;
}

/** The claim was undone meanwhile (e.g. by the poller): this transaction is never sent. */
export class ClaimLost extends Error {
  constructor() {
    super('the submission is no longer claimed for this quote');
    this.name = 'ClaimLost';
  }
}

/**
 * Writes the signed transaction and its id on the submission, only while it is still `pending`
 * and claimed for `quoteId`; throws ClaimLost otherwise.
 */
async function recordSigned(
  scope: { merchantId: string; livemode: boolean },
  id: string,
  quoteId: string,
  stored: StoredKora,
): Promise<void> {
  const { count } = await tenantTransaction(scope, (tx) =>
    tx.gasSponsorship.updateMany({
      where: { ...scope, id, quoteId, status: 'pending' },
      data: { txHash: stored.signature, paymasterData: stored as unknown as Prisma.InputJsonValue },
    }),
  );
  if (count !== 1) throw new ClaimLost();
}

const scopeOf = (q: QuoteContext) => ({
  merchantId: q.shopper.merchantId,
  livemode: q.shopper.livemode,
});

export class SolanaGasless implements GaslessRelayer {
  readonly family = 'solana' as const;
  private payer: { address: string; at: number } | null = null;

  constructor(
    /** Live: Kora on Pimlico and SOLANA_RPC_URL. Test mode: simulated, no HTTP. */
    private readonly live: boolean,
    private readonly deps: SolanaGaslessDeps = {},
  ) {}

  private get kora(): KoraClient {
    return this.deps.kora ?? defaultKora();
  }

  private get rpc(): SolanaRpc {
    return this.deps.rpc ?? new SolanaRpc();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Kora's fee payer (cached); test mode's simulated one. */
  private async feePayer(): Promise<string> {
    if (!this.live) return SIMULATED_KORA_PAYER;
    const t = Date.now();
    if (this.payer && t - this.payer.at < PAYER_CACHE_MS) return this.payer.address;
    try {
      const address = await this.kora.payerSigner();
      this.payer = { address, at: t };
      return address;
    } catch (err) {
      log('warn', 'solana gasless: Kora payer unavailable', {
        err: err instanceof KoraError ? err.message : 'request failed',
      });
      throw unavailable();
    }
  }

  async options(c: GaslessContext): Promise<GaslessOption[]> {
    const token = solanaGaslessToken(c.origin.assetId);
    if (!token || c.origin.blockchain !== 'sol') return [];
    // Tendr's Pimlico balance pays in every mode: none once the day's loss cap is reached.
    if (await lossCapReached(c.shopper.livemode, this.now())) return [];
    const plan = await planNetworkFee({
      livemode: c.shopper.livemode,
      merchantId: c.shopper.merchantId,
      session: c.session,
      origin: c.origin,
      walletAddress: c.walletAddress,
      method: 'kora',
      feeMode: 'token',
    });
    if (plan.paidBy === 'merchant') {
      return [
        { method: 'kora', paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null },
      ];
    }
    if (plan.feeMode === 'token' && plan.tokenAmount) {
      return [
        {
          method: 'kora',
          paid_by: 'shopper',
          reason: shopperReason(plan.reason),
          fee_modes: ['token', 'native'],
          token_fee: {
            amount: plan.tokenAmount,
            symbol: c.origin.symbol,
            decimals: c.origin.decimals,
            usd: plan.usd,
          },
        },
      ];
    }
    return [];
  }

  /** Everything the transaction binds: from the quote, the paymaster and the gas-fee key. */
  private async payment(q: QuoteContext, feePayer: string): Promise<SolanaPayment> {
    const token = solanaGaslessToken(q.quote.originAssetId);
    if (
      !token ||
      q.origin.blockchain !== 'sol' ||
      q.quote.networkFeeMethod !== 'kora' ||
      !isSolanaAddress(q.quote.walletAddress ?? '') ||
      !isValidAddress('sol', q.quote.depositAddress) ||
      !isSolanaAddress(q.quote.depositAddress)
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
      feePayer,
      wallet: q.quote.walletAddress!,
      mint: token.mint,
      decimals: token.decimals,
      depositAddress: q.quote.depositAddress,
      amount: BigInt(q.quote.amountIn.toFixed(0)),
      feeOwner: shopperFee ? await solanaGasFeeAddress() : null,
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
    // Never a second transaction for the quote while an earlier one may still land.
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
    const p = await this.payment(q, await this.feePayer());
    await this.assertUnderLossCap(q);
    const deposit = await associatedTokenAccount(p.depositAddress, p.mint);
    const feeAccount = p.feeOwner ? await associatedTokenAccount(p.feeOwner, p.mint) : null;
    let blockhash: string;
    let exists: boolean[];
    let cuPrice: bigint;
    if (this.live) {
      try {
        blockhash = await this.kora.blockhash();
      } catch (err) {
        log('warn', 'solana gasless: Kora blockhash unavailable', {
          quoteId: q.quote.id,
          err: err instanceof KoraError ? err.message : 'request failed',
        });
        throw unavailable();
      }
      try {
        exists = await this.rpc.accountsExist(feeAccount ? [deposit, feeAccount] : [deposit]);
      } catch (err) {
        log('warn', 'solana gasless: RPC unavailable', { err: String(err) });
        throw unavailable();
      }
      const price = await (this.deps.priorityFee ?? solanaComputeUnitPrice)();
      cuPrice = price > SOLANA_MAX_CU_PRICE ? SOLANA_MAX_CU_PRICE : price;
    } else {
      // Ruling T10-f: a blockhash no cluster ever produced, so a test-mode signature can never
      // land on a real chain.
      blockhash = TEST_SOLANA_BLOCKHASH;
      // No RPC in test mode: a fresh deposit address has no token account; the fee's has one.
      exists = feeAccount ? [false, true] : [false];
      cuPrice = SIMULATED_CU_PRICE;
    }
    const built = await buildPaymentTransaction(p, {
      blockhash,
      createDeposit: !exists[0],
      createFee: feeAccount !== null && !exists[1],
      cuLimit: SOLANA_GASLESS_CU_LIMIT,
      cuPrice,
    });
    await recordBlockhash(q.quote.id, blockhash, { at: now.getTime(), feePayer: p.feePayer });
    const transfers = [
      {
        leg: 'payment',
        mint: p.mint,
        to: p.depositAddress,
        token_account: deposit,
        amount: p.amount.toString(),
      },
      ...(p.feeOwner && feeAccount
        ? [
            {
              leg: 'fee',
              mint: p.mint,
              to: p.feeOwner,
              token_account: feeAccount,
              amount: p.fee.toString(),
            },
          ]
        : []),
    ];
    return {
      quote_id: q.quote.id,
      method: 'kora',
      chain: q.origin.blockchain,
      chain_id: null,
      signer: p.wallet,
      deadline: q.quote.deadline.toISOString(),
      amount: p.amount.toString(),
      fee_amount: p.fee.toString(),
      to_sign: [
        {
          kind: SOLANA_TO_SIGN_KIND,
          typed_data: {
            /** Unsigned (both signature slots empty): the wallet signs it as is. */
            transaction: built.transaction,
            /** The message bytes the wallet's signature covers. */
            message: built.message,
            fee_payer: p.feePayer,
            blockhash,
            /** Submit before this, or prepare again. */
            expires_at: new Date(now.getTime() + SOLANA_BLOCKHASH_MAX_AGE_MS).toISOString(),
            /** Every token movement the transaction makes (the pay page shows and checks them). */
            transfers,
          },
        },
      ],
    };
  }

  /** Checks the blockhash's age (ruling T7-d), then the signed transaction (ruling T7-b). */
  private async verify(q: QuoteContext, signed: SignedPayload): Promise<SolanaRelayCall> {
    if (!signed.transaction || Object.keys(signed.signatures).length > 0) {
      throw mismatch('transaction');
    }
    await this.assertUnderLossCap(q);
    const blockhash = transactionBlockhash(signed.transaction);
    if (!blockhash) throw mismatch('transaction');
    // Test mode signs only the test blockhash; live never accepts it (ruling T10-f).
    if ((blockhash === TEST_SOLANA_BLOCKHASH) === this.live)
      throw mismatch('transaction.blockhash');
    const issued = await blockhashIssued(q.quote.id, blockhash);
    if (!issued || this.now().getTime() - issued.at > SOLANA_BLOCKHASH_MAX_AGE_MS) {
      throw expired();
    }
    // The fee payer the transaction was built for (Kora may rotate its signer meanwhile).
    const p = await this.payment(q, issued.feePayer);
    let checked;
    try {
      checked = await checkPaymentTransaction(p, signed.transaction);
    } catch (err) {
      if (err instanceof SolanaTxMismatch) throw mismatch(err.field);
      throw err;
    }
    return { transaction: checked.transaction, blockhash, feePayer: p.feePayer };
  }

  async submit(q: QuoteContext, signed: SignedPayload): Promise<SubmitResult> {
    const res = await submitRelayed<SolanaRelayCall>(
      q,
      signed,
      (qq, s) => this.verify(qq, s),
      (call, submission) => this.broadcast(q, call, submission.id),
    );
    if (this.live || res.status !== 'submitted') return res;
    await this.simulateLanded(q, res.submissionId, res.txHash!);
    return { ...res, status: 'confirmed' };
  }

  /** Sign (Kora) → store the id and bytes → send (SOLANA_RPC_URL). See the file header. */
  private async broadcast(
    q: QuoteContext,
    call: SolanaRelayCall,
    id: string,
  ): Promise<{ txHash: string }> {
    if (!this.live) return { txHash: simulatedSignature(id) };
    let signedTx: string;
    try {
      signedTx = await this.kora.signTransaction(call.transaction);
    } catch (err) {
      // Kora only signs: nothing was sent, whatever the error.
      const reason = err instanceof KoraError ? err.message : 'request failed';
      log('warn', 'solana gasless: Kora did not sign', { submissionId: id, reason });
      throw new RelayNotBroadcast(
        reason,
        err instanceof KoraError && err.kind === 'refused' ? 'simulation_reverted' : 'unavailable',
      );
    }
    let signature: string;
    try {
      signature = feePayerSignature(call.transaction, signedTx, call.feePayer);
    } catch {
      log('error', 'solana gasless: Kora returned another transaction', { submissionId: id });
      throw new RelayNotBroadcast('the paymaster returned an unexpected transaction', 'rejected');
    }
    const stored: StoredKora = {
      kind: 'kora',
      blockhash: call.blockhash,
      feePayer: call.feePayer,
      signature,
      transaction: signedTx,
    };
    const scope = scopeOf(q);
    try {
      await (this.deps.record ?? recordSigned)(scope, id, q.quote.id, stored);
    } catch (err) {
      if (err instanceof ClaimLost) {
        log('warn', 'solana gasless: claim lost before the broadcast', { submissionId: id });
        throw new AppError(
          'QUOTE_EXPIRED',
          'This payment attempt was abandoned; request a new quote',
          409,
        );
      }
      // Never broadcast a transaction whose id is not recorded.
      log('warn', 'solana gasless: could not record the transaction', {
        submissionId: id,
        err: String(err),
      });
      throw new RelayNotBroadcast('the transaction could not be recorded', 'unavailable');
    }
    try {
      await this.rpc.sendTransaction(signedTx);
    } catch (err) {
      if (
        err instanceof SolanaRpcError &&
        err.preflightRefused &&
        !(await this.signatureSeen(signature))
      ) {
        // The node refused it in preflight and did not forward it; nothing knows its id.
        log('warn', 'solana gasless: preflight refused the transaction', {
          submissionId: id,
          reason: err.message,
        });
        throw new RelayNotBroadcast(err.message, 'simulation_reverted');
      }
      // It may have been forwarded: `submitted` with its known id; the poller re-sends it.
      log('warn', 'solana gasless: broadcast outcome unknown; the poller re-sends', {
        submissionId: id,
        err: String(err),
      });
    }
    return { txHash: signature };
  }

  /** Whether the chain knows `signature` (an unreadable answer counts as known: never undo). */
  private async signatureSeen(signature: string): Promise<boolean> {
    try {
      return (await this.rpc.signatureStatus(signature)) !== null;
    } catch {
      return true;
    }
  }

  /** Test mode: the transaction "lands" at once and the deposit reaches the simulated 1Click. */
  private async simulateLanded(q: QuoteContext, id: string, txHash: string): Promise<void> {
    const applied = await applyRelayOutcome(id, {
      status: 'confirmed',
      txHash,
      gasUsed: BigInt(SOLANA_GASLESS_CU_LIMIT),
      costUsd: SIMULATED_FEE_USD[q.origin.blockchain] ?? null,
      reason: null,
      // The simulated transaction moves exactly the signed fee.
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
      log('warn', 'simulated kora: deposit simulation failed', {
        submissionId: id,
        err: String(err),
      });
    }
  }

  status(submissionId: string): Promise<SubmissionStatus> {
    return submissionStatus(submissionId);
  }
}

/** Test mode: a deterministic, obviously simulated transaction signature (base58, 64 bytes). */
export function simulatedSignature(submissionId: string): string {
  return bs58.encode(createHash('sha512').update(`tendr:simulated-kora:${submissionId}`).digest());
}

let sharedKora: KoraClient | null = null;
const defaultKora = () => (sharedKora ??= new KoraClient());

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/**
 * What the transaction moved into `account` (`mint`): its token balance after minus before (an
 * account created by the transaction has no balance before: 0), capped at `cap`.
 */
export function tokenBalanceIncrease(
  tx: SolanaTransaction,
  where: { account: string; mint: string; cap: bigint },
): bigint {
  const keys = tx.transaction.message?.accountKeys ?? [];
  const index = keys.indexOf(where.account);
  if (index < 0 || !tx.meta) return 0n;
  const amountAt = (list: TokenBalance[] | null | undefined) => {
    const b = (list ?? []).find((x) => x.accountIndex === index && x.mint === where.mint);
    return b ? BigInt(b.uiTokenAmount.amount) : 0n;
  };
  const moved = amountAt(tx.meta.postTokenBalances) - amountAt(tx.meta.preTokenBalances);
  if (moved <= 0n) return 0n;
  return moved > where.cap ? where.cap : moved;
}

/**
 * One pass over Kora submissions awaiting their outcome (see the file header). Every row visited
 * is marked checked (rows rotate, so failing rows cannot starve the rest). Returns how many
 * outcomes were applied (claims undone included).
 */
export async function pollSolanaRelays(
  deps: { rpc?: SolanaRpc; now?: () => Date; livemode?: boolean } = {},
): Promise<number> {
  const rpc = deps.rpc ?? new SolanaRpc();
  const now = deps.now?.() ?? new Date();
  const rows = await prisma.gasSponsorship.findMany({
    where: {
      livemode: deps.livemode ?? true,
      method: 'kora',
      provider: 'pimlico',
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
      const stored = storedKora(row.paymasterData);
      if (!stored || !isSignature(stored.signature)) {
        // Claimed, but nothing was ever signed and stored: nothing can have been sent.
        if (row.status === 'pending') {
          if (now.getTime() - row.updatedAt.getTime() >= SOLANA_STALE_PENDING_MS) {
            await undoClaim(scope, row.id, 'the transaction was never recorded or sent');
            applied++;
          }
          continue;
        }
        log('error', 'solana gasless: submitted row without its transaction', {
          sponsorshipId: row.id,
        });
        await touch(row.id, now);
        continue;
      }
      if (row.status === 'pending') {
        // Recorded, not marked: a submit still sending, or one that stopped (it may have sent).
        if (now.getTime() - row.updatedAt.getTime() < SOLANA_RECORDED_PENDING_MS) continue;
        await markSent(scope, row.id, row.quote, stored.signature, now);
      }
      if (await applyOutcome(rpc, row, stored, now)) applied++;
    } catch (err) {
      log('warn', 'solana gasless: outcome lookup failed', {
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

/** The submission is `submitted` with its id; the quote records the deposit tx; 1Click is told. */
async function markSent(
  scope: { merchantId: string; livemode: boolean },
  id: string,
  quote: { id: string; depositAddress: string },
  signature: string,
  now: Date,
): Promise<void> {
  await tenantTransaction(scope, async (t) => {
    await t.gasSponsorship.updateMany({
      where: { ...scope, id, status: 'pending' },
      data: { status: 'submitted', txHash: signature },
    });
    await t.quote.updateMany({
      where: { ...scope, id: quote.id, depositTxHash: null },
      data: { depositTxHash: signature, depositTxSubmittedAt: now },
    });
  });
  try {
    await providerFor(scope.livemode).submitDeposit(signature, quote.depositAddress);
  } catch (err) {
    log('warn', 'solana gasless: 1Click deposit notice failed', {
      sponsorshipId: id,
      err: String(err),
    });
  }
}

/** One submitted transaction: wait / re-send / apply its outcome. True when an outcome applied. */
async function applyOutcome(
  rpc: SolanaRpc,
  row: {
    id: string;
    livemode: boolean;
    sponsor: string;
    feeAsset: string | null;
    feeAmount: Prisma.Decimal | null;
  },
  stored: StoredKora,
  now: Date,
): Promise<boolean> {
  const signature = stored.signature;
  let status = await rpc.signatureStatus(signature);
  if (!status) {
    if (await rpc.isBlockhashValid(stored.blockhash)) {
      // Not seen yet and it can still land: send the same bytes again (same id, lands once).
      try {
        await rpc.sendTransaction(stored.transaction);
      } catch (err) {
        log('warn', 'solana gasless: re-send failed', { sponsorshipId: row.id, err: String(err) });
      }
      const { expiredSeenAt: _cleared, ...rest } = stored;
      await touch(row.id, now, stored.expiredSeenAt !== undefined ? rest : undefined);
      return false;
    }
    // Expired at the finalized root: anything that could still land is visible by now.
    status = await rpc.signatureStatus(signature);
    if (!status) {
      // Only on a second look, a poll interval later (load-balanced nodes may disagree).
      const first = stored.expiredSeenAt;
      if (first === undefined || now.getTime() - first < SOLANA_EXPIRY_CONFIRM_MS) {
        await touch(
          row.id,
          now,
          first === undefined ? { ...stored, expiredSeenAt: now.getTime() } : undefined,
        );
        return false;
      }
      return applyRelayOutcome(
        row.id,
        {
          status: 'failed',
          txHash: null,
          gasUsed: null,
          costUsd: null,
          reason: 'the transaction never landed (blockhash expired)',
          feeMoved: null,
        },
        now,
      );
    }
  }
  if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') {
    await touch(row.id, now);
    return false;
  }
  const tx = await rpc.transaction(signature);
  if (!tx?.meta) {
    await touch(row.id, now);
    return false;
  }
  const ok = tx.meta.err === null || tx.meta.err === undefined;
  // What the fee payer's balance lost: the fee and the rent of any account it created.
  const found = tx.transaction.message?.accountKeys.indexOf(stored.feePayer) ?? 0;
  const payerIndex = found < 0 ? 0 : found;
  const pre = tx.meta.preBalances[payerIndex] ?? 0;
  const post = tx.meta.postBalances[payerIndex] ?? 0;
  const lamports = BigInt(Math.max(pre - post, tx.meta.fee));
  let costUsd: string | null = null;
  try {
    costUsd = await nativeUsd('sol', lamports, row.livemode);
  } catch (err) {
    log('warn', 'solana gasless: cost unpriced', { sponsorshipId: row.id, err: String(err) });
  }
  let feeMoved: bigint | null = null;
  if (ok && row.sponsor === 'shopper' && row.feeAsset && row.feeAmount) {
    const token = solanaGaslessToken(row.feeAsset);
    feeMoved = token
      ? tokenBalanceIncrease(tx, {
          account: await associatedTokenAccount(await solanaGasFeeAddress(), token.mint),
          mint: token.mint,
          cap: BigInt(row.feeAmount.toFixed(0)),
        })
      : 0n;
  }
  const did = await applyRelayOutcome(
    row.id,
    {
      status: ok ? 'confirmed' : 'failed',
      txHash: signature,
      gasUsed: BigInt(tx.meta.computeUnitsConsumed ?? tx.meta.fee),
      costUsd,
      reason: ok ? null : `failed on chain: ${JSON.stringify(tx.meta.err).slice(0, 200)}`,
      feeMoved,
    },
    now,
  );
  if (did) await recordUnrecovered(row.id, now);
  return did;
}

/**
 * Marks a row checked (the next pass visits rows not checked for longest first), optionally with
 * its updated Kora record.
 */
async function touch(id: string, now: Date, stored?: StoredKora): Promise<void> {
  await prisma.gasSponsorship.updateMany({
    where: { id, status: { in: ['pending', 'submitted'] } },
    data: {
      updatedAt: now,
      ...(stored ? { paymasterData: stored as unknown as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Drops cached state (tests). */
export function resetSolanaRelayer(): void {
  sharedKora = null;
  feeOwner = null;
}
