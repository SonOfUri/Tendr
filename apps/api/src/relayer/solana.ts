// Gasless Solana token payments through Pimlico's Solana paymaster (project 5a, spec §2.3 Solana,
// §2.5, §9.1; rulings T7-a … T7-d). Pimlico runs Kora (`https://solana.pimlico.io/v1/{mainnet|
// devnet}/rpc?apikey=…`, network PIMLICO_SOLANA_NETWORK, key = the stored `pimlico` secret, never
// sent to the browser or logged).
//
//   prepare   the paymaster's fee payer (`getPayerSigner`) and a fresh blockhash (`getBlockhash`),
//             then the v0 transaction of relayer/solana-tx.ts: the payment `transferChecked` of
//             `amount_in` to the deposit address's token account (created, paymaster as rent
//             payer, when it does not exist yet), plus, when the shopper pays the fee, a
//             `transferChecked` of `fee_amount` to the `gas-fees-solana` token account. Always
//             sponsored by Pimlico (no Kora payment instruction, ruling T7-a): the SOL fee and
//             rent come from Tendr's Pimlico balance. The blockhash is recorded (Redis) as issued
//             for the quote at that time.
//   submit    the shared pipeline (relayer/submissions.ts) with the Solana check: the partially
//             signed transaction is decoded and must be EXACTLY the quote's payment (ruling T7-b),
//             signed by the quote's wallet, fee payer = the paymaster; its blockhash must have
//             been issued for this quote at most 60 s ago (else 409 GASLESS_EXPIRED: the pay page
//             prepares again). Tendr's daily loss cap refuses in both modes (Tendr's Pimlico
//             balance pays either way). Then Kora `signAndSendTransaction`: the paymaster signs
//             and broadcasts. Its signature is the transaction id.
//   outcome   `pollSolanaRelays` (worker): `getSignatureStatuses` / `getTransaction` on
//             SOLANA_RPC_URL. The actual cost is what the fee payer's balance lost (fee + rent);
//             a shopper fee leg's revenue is the gas-fee token account's balance change (capped
//             at the fee signed). Never landed once the blockhash expired → failed, no gas. A
//             submit whose Kora call got no answer stays `pending` (never a second payment): the
//             poller finds it on chain by the shopper's signature, or undoes the claim once the
//             blockhash can no longer land. Settlement, release and loss follow the shared
//             lifecycle; cost above what is recovered counts toward the daily loss cap.
//
// Native SOL is never routed here (its sender pays its own fee). Test mode never calls Pimlico or
// a Solana RPC: a simulated fee payer and blockhash, the same checks, and the transaction is
// "landed" at once.
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import bs58 from 'bs58';
import { z } from 'zod';
import { isValidAddress } from '../checkout/address-format.js';
import { providerFor, simulatedOneClick } from '../checkout/oneclick/index.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { SIMULATED_FEE_USD, nativeUsd, solanaComputeUnitPrice } from '../gas/fees.js';
import { lossCapReached } from '../gas/loss-cap.js';
import { planNetworkFee, shopperReason } from '../gas/quote-fee.js';
import { getKeyVault } from '../keyvault/index.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { pimlicoApiKey, recordUnrecovered } from './evm/pimlico.js';
import {
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
  isSolanaAddress,
  solanaGaslessToken,
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

/** A blockhash older than this at submit is refused (it expires on chain after ~60–90 s). */
export const SOLANA_BLOCKHASH_MAX_AGE_MS = 60_000;
/** How long the paymaster's fee payer address is reused. */
const PAYER_CACHE_MS = 10 * 60_000;
/** Test mode: the compute-unit price the simulated transaction sets. */
const SIMULATED_CU_PRICE = 1_000n;
/** A submit whose Kora call got no answer is reconciled only after this long. */
const PENDING_GRACE_MS = 60_000;
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
// Kora (Pimlico's Solana paymaster)
// ---------------------------------------------------------------------------------------------

/**
 * A Kora call failed; the message never contains the API key. `refused`: Kora answered with an
 * error (nothing was sent). `unavailable`: no usable answer, but nothing can have been sent (HTTP
 * 4xx). `unknown`: no answer (network, timeout, 5xx): the transaction may have been sent.
 */
export class KoraError extends Error {
  constructor(
    message: string,
    readonly kind: 'refused' | 'unavailable' | 'unknown',
  ) {
    super(message);
    this.name = 'KoraError';
  }
}

function redact(s: string, key: string): string {
  if (!key) return s;
  let out = s;
  for (const form of new Set([key, encodeURIComponent(key)])) {
    out = out.split(form).join('[redacted]');
  }
  return out;
}

/** Kora's JSON-RPC on Pimlico: `https://solana.pimlico.io/v1/{network}/rpc?apikey=…`. */
export class KoraClient {
  constructor(
    private readonly deps: {
      fetch?: typeof fetch;
      apiKey?: () => Promise<string>;
      network?: () => 'mainnet' | 'devnet';
      timeoutMs?: number;
    } = {},
  ) {}

  private async request(method: string, params?: unknown): Promise<unknown> {
    const key = await (this.deps.apiKey ?? pimlicoApiKey)();
    const network = (this.deps.network ?? (() => env().PIMLICO_SOLANA_NETWORK))();
    const url = `https://solana.pimlico.io/v1/${network}/rpc?apikey=${encodeURIComponent(key)}`;
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new KoraError(`unreachable: ${redact(String(err), key).slice(0, 200)}`, 'unknown');
    }
    if (!res.ok) {
      throw new KoraError(`HTTP ${res.status}`, res.status >= 500 ? 'unknown' : 'unavailable');
    }
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new KoraError('invalid JSON response', 'unknown');
    }
    if (body?.error) {
      const msg = typeof body.error.message === 'string' ? body.error.message : 'error';
      throw new KoraError(
        `${String(body.error.code)} ${redact(msg, key).slice(0, 300)}`,
        'refused',
      );
    }
    return body?.result ?? null;
  }

  async payerSigner(): Promise<string> {
    const r = z
      .object({ signer_address: z.string() })
      .safeParse(await this.request('getPayerSigner'));
    if (!r.success || !isSolanaAddress(r.data.signer_address)) {
      throw new KoraError('unexpected getPayerSigner result', 'unavailable');
    }
    return r.data.signer_address;
  }

  async blockhash(): Promise<string> {
    const r = z.object({ blockhash: z.string() }).safeParse(await this.request('getBlockhash'));
    if (!r.success || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.data.blockhash)) {
      throw new KoraError('unexpected getBlockhash result', 'unavailable');
    }
    return r.data.blockhash;
  }

  /** Signs as fee payer and broadcasts; returns the transaction signature (its id). */
  async signAndSendTransaction(transaction: string): Promise<string> {
    const raw = await this.request('signAndSendTransaction', { transaction });
    const r = z.object({ signature: z.string() }).safeParse(raw);
    if (!r.success || !isSignature(r.data.signature)) {
      // Kora answered success: the transaction was sent, but its id is unreadable.
      throw new KoraError('unexpected signAndSendTransaction result', 'unknown');
    }
    return r.data.signature;
  }
}

function isSignature(s: string): boolean {
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Solana JSON-RPC (SOLANA_RPC_URL)
// ---------------------------------------------------------------------------------------------

const TokenBalanceSchema = z.object({
  accountIndex: z.number().int(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
});

const TransactionSchema = z.object({
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({ accountKeys: z.array(z.string()) }).optional(),
  }),
  meta: z
    .object({
      err: z.unknown(),
      fee: z.number().int().nonnegative(),
      preBalances: z.array(z.number()),
      postBalances: z.array(z.number()),
      computeUnitsConsumed: z.number().int().optional(),
      preTokenBalances: z.array(TokenBalanceSchema).nullish(),
      postTokenBalances: z.array(TokenBalanceSchema).nullish(),
    })
    .nullable(),
});
export type SolanaTransaction = z.infer<typeof TransactionSchema>;

const StatusSchema = z
  .object({ err: z.unknown(), confirmationStatus: z.string().nullish() })
  .nullable();

export class SolanaRpc {
  constructor(
    private readonly url: string = env().SOLANA_RPC_URL,
    private readonly fetchImpl: typeof fetch = (u, i) => fetch(u, i),
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } };
    if (body?.error)
      throw new Error(`Solana RPC error: ${String(body.error.message).slice(0, 200)}`);
    return body?.result ?? null;
  }

  /** Whether each account exists. */
  async accountsExist(addresses: string[]): Promise<boolean[]> {
    const r = (await this.call('getMultipleAccounts', [
      addresses,
      { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
    ])) as { value?: unknown[] } | null;
    const value = r?.value;
    if (!Array.isArray(value) || value.length !== addresses.length) {
      throw new Error('unexpected getMultipleAccounts result');
    }
    return value.map((v) => v !== null);
  }

  async signatureStatus(signature: string): Promise<z.infer<typeof StatusSchema>> {
    const r = (await this.call('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ])) as { value?: unknown[] } | null;
    return StatusSchema.parse(r?.value?.[0] ?? null);
  }

  async transaction(signature: string): Promise<SolanaTransaction | null> {
    const raw = await this.call('getTransaction', [
      signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    return raw === null ? null : TransactionSchema.parse(raw);
  }

  /** Whether the blockhash can still land a transaction (the most recent view). */
  async isBlockhashValid(blockhash: string): Promise<boolean> {
    const r = (await this.call('isBlockhashValid', [blockhash, { commitment: 'processed' }])) as {
      value?: unknown;
    } | null;
    if (typeof r?.value !== 'boolean') throw new Error('unexpected isBlockhashValid result');
    return r.value;
  }

  async signaturesForAddress(address: string, limit: number): Promise<string[]> {
    const r = await this.call('getSignaturesForAddress', [address, { limit }]);
    if (!Array.isArray(r)) throw new Error('unexpected getSignaturesForAddress result');
    return r
      .map((x) => (x as { signature?: unknown }).signature)
      .filter((x): x is string => typeof x === 'string');
  }
}

// ---------------------------------------------------------------------------------------------
// Issued blockhashes
// ---------------------------------------------------------------------------------------------

const blockhashKey = (quoteId: string, blockhash: string) =>
  `tendr:gasless:sol-bh:${quoteId}:${blockhash}`;

async function recordBlockhash(quoteId: string, blockhash: string, at: Date): Promise<void> {
  try {
    await getRedis().set(blockhashKey(quoteId, blockhash), String(at.getTime()), 'EX', 300);
  } catch (err) {
    log('warn', 'solana gasless: blockhash store unavailable', { err: String(err) });
    throw unavailable();
  }
}

/** When Tendr issued `blockhash` for the quote; null if it never did (or long ago). */
async function blockhashIssuedAt(quoteId: string, blockhash: string): Promise<number | null> {
  let v: string | null;
  try {
    v = await getRedis().get(blockhashKey(quoteId, blockhash));
  } catch (err) {
    log('warn', 'solana gasless: blockhash store unavailable', { err: String(err) });
    throw unavailable();
  }
  const at = v === null ? NaN : Number(v);
  return Number.isFinite(at) ? at : null;
}

// ---------------------------------------------------------------------------------------------
// The relayer
// ---------------------------------------------------------------------------------------------

/** What a Kora submission keeps (`gas_sponsorships.paymaster_data`). */
interface StoredKora {
  kind: 'kora';
  blockhash: string;
  feePayer: string;
  /** The shopper's signature: finds the transaction on chain when Kora's answer was lost. */
  shopperSignature: string;
}

function storedKora(v: Prisma.JsonValue | null): StoredKora | null {
  const r = z
    .object({
      kind: z.literal('kora'),
      blockhash: z.string(),
      feePayer: z.string(),
      shopperSignature: z.string(),
    })
    .safeParse(v);
  return r.success ? r.data : null;
}

/** The checked transaction `submit` relays. */
interface SolanaRelayCall {
  transaction: string;
  blockhash: string;
  feePayer: string;
  shopperSignature: string;
}

export interface SolanaGaslessDeps {
  kora?: KoraClient;
  rpc?: SolanaRpc;
  /** Live compute-unit price (micro-lamports); default the median recent priority fee. */
  priorityFee?: () => Promise<bigint>;
  now?: () => Date;
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
  private async payment(q: QuoteContext): Promise<SolanaPayment> {
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
      feePayer: await this.feePayer(),
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
    const p = await this.payment(q);
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
      blockhash = bs58.encode(randomBytes(32));
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
    await recordBlockhash(q.quote.id, blockhash, now);
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

  /** Checks the signed transaction (ruling T7-b) and its blockhash's age (ruling T7-d). */
  private async verify(q: QuoteContext, signed: SignedPayload): Promise<SolanaRelayCall> {
    if (!signed.transaction || Object.keys(signed.signatures).length > 0) {
      throw mismatch('transaction');
    }
    await this.assertUnderLossCap(q);
    const p = await this.payment(q);
    let checked;
    try {
      checked = await checkPaymentTransaction(p, signed.transaction);
    } catch (err) {
      if (err instanceof SolanaTxMismatch) throw mismatch(err.field);
      throw err;
    }
    const issued = await blockhashIssuedAt(q.quote.id, checked.blockhash);
    if (issued === null || this.now().getTime() - issued > SOLANA_BLOCKHASH_MAX_AGE_MS) {
      throw expired();
    }
    return { ...checked, feePayer: p.feePayer };
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

  private async broadcast(
    q: QuoteContext,
    call: SolanaRelayCall,
    id: string,
  ): Promise<{ txHash: string }> {
    if (!this.live) return { txHash: simulatedSignature(id) };
    const stored: StoredKora = {
      kind: 'kora',
      blockhash: call.blockhash,
      feePayer: call.feePayer,
      shopperSignature: call.shopperSignature,
    };
    // Before Kora sends anything: enough to find the transaction on chain if the answer is lost.
    const scope = scopeOf(q);
    await tenantTransaction(scope, (tx) =>
      tx.gasSponsorship.updateMany({
        where: { ...scope, id, status: 'pending' },
        data: { paymasterData: stored as unknown as Prisma.InputJsonValue },
      }),
    );
    try {
      return { txHash: await this.kora.signAndSendTransaction(call.transaction) };
    } catch (err) {
      const reason = err instanceof KoraError ? err.message : 'request failed';
      if (err instanceof KoraError && err.kind === 'refused') {
        log('warn', 'solana gasless: Kora refused the transaction', { submissionId: id, reason });
        throw new RelayNotBroadcast(reason, 'simulation_reverted');
      }
      if (err instanceof KoraError && err.kind === 'unavailable') {
        log('warn', 'solana gasless: Kora unavailable', { submissionId: id, reason });
        throw new RelayNotBroadcast(reason, 'unavailable');
      }
      // The transaction may have been sent: the submission stays pending (a retry returns it,
      // never a second payment) and the poller reconciles it on chain.
      log('warn', 'solana gasless: no answer from Kora; outcome unknown', {
        submissionId: id,
        reason,
      });
      throw unavailable();
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
  const amountAt = (list: z.infer<typeof TokenBalanceSchema>[] | null | undefined) => {
    const b = (list ?? []).find((x) => x.accountIndex === index && x.mint === where.mint);
    return b ? BigInt(b.uiTokenAmount.amount) : 0n;
  };
  const moved = amountAt(tx.meta.postTokenBalances) - amountAt(tx.meta.preTokenBalances);
  if (moved <= 0n) return 0n;
  return moved > where.cap ? where.cap : moved;
}

/**
 * One pass over Kora submissions awaiting their outcome (see the file header). Returns how many
 * outcomes were applied.
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
    const stored = storedKora(row.paymasterData);
    if (!row.quote || !stored) continue;
    const scope = { merchantId: row.merchantId, livemode: row.livemode };
    try {
      if (row.status === 'pending') {
        await reconcileUnanswered(rpc, row, stored, now);
        continue;
      }
      const signature = row.txHash!;
      let status = await rpc.signatureStatus(signature);
      if (!status) {
        if (await rpc.isBlockhashValid(stored.blockhash)) {
          await touch(row.id, now);
          continue;
        }
        // Expired: anything that could still land is visible by now.
        status = await rpc.signatureStatus(signature);
        if (!status) {
          if (
            await applyRelayOutcome(
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
            )
          ) {
            applied++;
          }
          continue;
        }
      }
      if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') {
        await touch(row.id, now);
        continue;
      }
      const tx = await rpc.transaction(signature);
      if (!tx?.meta) {
        await touch(row.id, now);
        continue;
      }
      const ok = tx.meta.err === null || tx.meta.err === undefined;
      // What the fee payer's balance lost: the fee and the rent of any account it created.
      const payerIndex = tx.transaction.message?.accountKeys.indexOf(stored.feePayer) ?? 0;
      const pre = tx.meta.preBalances[payerIndex < 0 ? 0 : payerIndex] ?? 0;
      const post = tx.meta.postBalances[payerIndex < 0 ? 0 : payerIndex] ?? 0;
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
      if (did) {
        applied++;
        await recordUnrecovered(row.id, now);
      }
    } catch (err) {
      log('warn', 'solana gasless: outcome lookup failed', {
        sponsorshipId: row.id,
        scope: scope.livemode ? 'live' : 'test',
        err: String(err),
      });
    }
  }
  return applied;
}

/** Marks a row checked (the next pass visits rows not checked for longest first). */
async function touch(id: string, now: Date): Promise<void> {
  await prisma.gasSponsorship.updateMany({
    where: { id, status: { in: ['pending', 'submitted'] } },
    data: { updatedAt: now },
  });
}

/**
 * A submit whose Kora call got no answer: once its blockhash can no longer land, look for the
 * shopper's signed transaction among the wallet's recent transactions. Found → `submitted` with
 * its signature (the next pass applies the outcome). Not found → nothing can land any more: the
 * claim is undone (a sponsored hold stays held; a shopper row fails) so the shopper can retry.
 */
async function reconcileUnanswered(
  rpc: SolanaRpc,
  row: {
    id: string;
    merchantId: string;
    livemode: boolean;
    signerAddress: string | null;
    updatedAt: Date;
    quote: { id: string; depositAddress: string; walletAddress: string | null } | null;
  },
  stored: StoredKora,
  now: Date,
): Promise<void> {
  if (now.getTime() - row.updatedAt.getTime() < PENDING_GRACE_MS) return;
  if (await rpc.isBlockhashValid(stored.blockhash)) return;
  const wallet = row.signerAddress ?? row.quote?.walletAddress;
  if (!wallet || !row.quote) return;
  const scope = { merchantId: row.merchantId, livemode: row.livemode };
  for (const sig of await rpc.signaturesForAddress(wallet, 25)) {
    const tx = await rpc.transaction(sig);
    if (!tx?.transaction.signatures.includes(stored.shopperSignature)) continue;
    const quote = row.quote;
    await tenantTransaction(scope, async (t) => {
      await t.gasSponsorship.updateMany({
        where: { ...scope, id: row.id, status: 'pending' },
        data: { status: 'submitted', txHash: sig },
      });
      await t.quote.updateMany({
        where: { ...scope, id: quote.id, depositTxHash: null },
        data: { depositTxHash: sig, depositTxSubmittedAt: now },
      });
    });
    try {
      await providerFor(row.livemode).submitDeposit(sig, quote.depositAddress);
    } catch (err) {
      log('warn', 'solana gasless: 1Click deposit notice failed', {
        sponsorshipId: row.id,
        err: String(err),
      });
    }
    return;
  }
  await undoClaim(scope, row.id, 'no answer from the paymaster and the transaction never landed');
}

/** Drops cached state (tests). */
export function resetSolanaRelayer(): void {
  sharedKora = null;
  feeOwner = null;
}
