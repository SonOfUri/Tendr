// The EVM gasless relayer (project 5a, spec §2.3): EIP-3009 authorizations and EIP-2612 permits,
// both executed through the TendrForwarder by `relayer-evm`.
//
// `EvmGasless` is the chain logic shared by live and test mode: which methods a wallet + token
// can use (with fee lines), what the shopper signs, and the check of what they signed. The live
// relayer broadcasts through `EvmSender`; the simulated one (relayer/simulated.ts) does not.
// Addresses the shopper's money can go to are never taken from a request: the deposit address
// and amounts come from the quote, the fee recipient from the `gas-fees-evm` key, the forwarder
// from EVM_FORWARDER_ADDRESS.
import { env } from '../../env.js';
import { isValidAddress } from '../../checkout/address-format.js';
import { getKeyVault } from '../../keyvault/index.js';
import { evmAddress } from '../../keyvault/secp256k1.js';
import { AppError } from '../../lib/errors.js';
import { getRedis } from '../../lib/redis.js';
import { lossCapReached } from '../../gas/loss-cap.js';
import { planNetworkFee, shopperReason } from '../../gas/quote-fee.js';
import { log } from '../../lib/logger.js';
import {
  RelayNotBroadcast,
  assertRelayable,
  gaslessNotAvailable,
  submissionStatus,
  submitRelayed,
  type RelayCall,
} from '../submissions.js';
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
} from '../types.js';
import {
  buildToSign,
  decodeBool,
  noncesCalldata,
  usedNonceChecks,
  verifySigned,
  type EvmPaymentContext,
} from './payment.js';
import { EvmRpc } from './rpc.js';
import { EvmNotBroadcastError, EvmSender } from './sender.js';
import { EVM_CHAIN_IDS, EVM_RELAY_METHODS, gaslessToken, type EvmRelayMethod } from './tokens.js';

let feeAddress: string | null = null;

/** Tendr's EVM gas-fee address (the `gas-fees-evm` key; one address on every EVM chain). */
export async function evmGasFeeAddress(): Promise<string> {
  if (feeAddress) return feeAddress;
  const { curve, raw } = await getKeyVault().publicKey('gas-fees-evm');
  if (curve !== 'secp256k1') throw new Error('gas-fees-evm is not a secp256k1 key');
  feeAddress = evmAddress(raw);
  return feeAddress;
}

/** The TendrForwarder (EVM_FORWARDER_ADDRESS), lower-case. */
export function evmForwarderAddress(): string {
  return env().EVM_FORWARDER_ADDRESS.toLowerCase();
}

const mismatch = (field: string) =>
  new AppError('GASLESS_PAYLOAD_MISMATCH', 'The signed payment does not match this quote', 409, {
    field,
  });

export class EvmGasless {
  constructor(
    private readonly livemode: boolean,
    private readonly rpc: (chain: string) => EvmRpc = (chain) => EvmRpc.forChain(chain),
  ) {}

  /**
   * Best first: EIP-3009 (one transfer per leg), the permit forwarder, then a smart wallet's
   * Pimlico-sponsored calls (`paymaster`: offered for any wallet; only a wallet with an EIP-5792
   * paymaster capability can use it).
   */
  async options(c: GaslessContext): Promise<GaslessOption[]> {
    const token = gaslessToken(c.origin.blockchain, c.origin.assetId);
    if (!token) return [];
    // The relayer pays the gas in every mode: none once the day's loss cap is reached (as the
    // Solana, NEAR, Tron and paymaster paths).
    if (await lossCapReached(c.shopper.livemode, new Date())) return [];
    const out: GaslessOption[] = [];
    for (const method of token.methods) {
      // Test mode never offers the paymaster: the smart wallet would send a real operation.
      if (method === 'paymaster' && !this.livemode) continue;
      const plan = await planNetworkFee({
        livemode: c.shopper.livemode,
        merchantId: c.shopper.merchantId,
        session: c.session,
        origin: c.origin,
        walletAddress: c.walletAddress,
        method,
        feeMode: 'token',
      });
      if (plan.paidBy === 'merchant') {
        out.push({ method, paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null });
      } else if (plan.feeMode === 'token' && plan.tokenAmount) {
        out.push({
          method,
          paid_by: 'shopper',
          reason: shopperReason(plan.reason),
          fee_modes: ['token', 'native'],
          token_fee: {
            amount: plan.tokenAmount,
            symbol: c.origin.symbol,
            decimals: c.origin.decimals,
            usd: plan.usd,
          },
        });
      }
      // Otherwise (fee unavailable / token unpriced) this method cannot run gasless now.
    }
    return out;
  }

  /** Everything the signed messages must bind, rebuilt from the quote and Tendr's own config. */
  async context(q: QuoteContext): Promise<EvmPaymentContext> {
    const chain = q.origin.blockchain;
    const token = gaslessToken(chain, q.quote.originAssetId);
    const method = q.quote.networkFeeMethod as EvmRelayMethod | null;
    const chainId = EVM_CHAIN_IDS[chain];
    // A `paymaster` quote is never relayed here: the shopper's smart wallet submits it through
    // Pimlico (relayer/evm/pimlico.ts).
    if (
      !token ||
      !method ||
      !EVM_RELAY_METHODS.includes(method) ||
      !token.methods.includes(method) ||
      !chainId
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
    const wallet = q.quote.walletAddress!.toLowerCase();
    if (!isValidAddress(chain, q.quote.depositAddress)) throw gaslessNotAvailable();
    const ctx: EvmPaymentContext = {
      quoteId: q.quote.id,
      chain,
      chainId,
      token,
      method,
      wallet,
      depositAddress: q.quote.depositAddress.toLowerCase(),
      amount: BigInt(q.quote.amountIn.toFixed(0)),
      fee: shopperFee ? BigInt(q.quote.networkFeeAmount!.toFixed(0)) : 0n,
      feeTo: await evmGasFeeAddress(),
      forwarder: evmForwarderAddress(),
      deadline: q.quote.deadline,
      testMode: !this.livemode,
    };
    if (method === 'permit') ctx.permitNonce = await this.permitNonce(chain, token.address, wallet);
    return ctx;
  }

  /** The token's EIP-2612 nonce for `owner`; test mode never calls an RPC (a fresh wallet: 0). */
  private async permitNonce(chain: string, token: string, owner: string): Promise<bigint> {
    if (!this.livemode) return 0n;
    try {
      return BigInt(await this.rpc(chain).call({ to: token, data: noncesCalldata(owner) }));
    } catch {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Gasless payments are unavailable; try again',
        503,
      );
    }
  }

  /** GASLESS_NOT_AVAILABLE once the mode's daily loss cap is reached. */
  async assertUnderLossCap(q: QuoteContext): Promise<void> {
    if (await lossCapReached(q.shopper.livemode, new Date())) throw gaslessNotAvailable();
  }

  async prepare(q: QuoteContext, input: PrepareInput): Promise<PreparePayload> {
    assertRelayable(q, new Date());
    await this.assertUnderLossCap(q);
    if (input.method && input.method !== q.quote.networkFeeMethod) throw mismatch('method');
    if (
      input.fee_mode &&
      q.quote.networkFeePaidBy === 'buyer' &&
      input.fee_mode !== q.quote.networkFeeMode
    ) {
      throw mismatch('fee_mode');
    }
    const ctx = await this.context(q);
    return {
      quote_id: q.quote.id,
      method: ctx.method,
      chain: ctx.chain,
      chain_id: ctx.chainId,
      signer: ctx.wallet,
      deadline: q.quote.deadline.toISOString(),
      amount: ctx.amount.toString(),
      fee_amount: ctx.fee.toString(),
      to_sign: buildToSign(ctx),
    };
  }

  async verify(q: QuoteContext, signed: SignedPayload): Promise<RelayCall> {
    return (await this.verifyWithContext(q, signed)).call;
  }

  /** `verify`, also returning the context the signatures were checked against. */
  async verifyWithContext(
    q: QuoteContext,
    signed: SignedPayload,
  ): Promise<{ call: RelayCall; ctx: EvmPaymentContext }> {
    await this.assertUnderLossCap(q);
    const ctx = await this.context(q);
    const call = verifySigned(ctx, signed.signatures);
    return { call: { chain: ctx.chain, ...call }, ctx };
  }
}

/**
 * Refuses a relay whose signed authorization was already used or cancelled on chain (final
 * review I1): the forwarder skips such a 3009 leg without reverting, so the dry run passes and
 * the relayer would pay gas for a transaction that moves nothing. QUOTE_EXPIRED (a new quote gets
 * new nonces); PROVIDER_UNAVAILABLE when the node cannot answer (fails closed). A use that lands
 * after this read (a front-run) is still handled on chain as designed.
 */
export async function assertAuthorizationsUnused(
  rpc: EvmRpc,
  ctx: EvmPaymentContext,
): Promise<void> {
  for (const check of usedNonceChecks(ctx)) {
    let used: boolean;
    try {
      used = decodeBool(await rpc.call({ to: check.to, data: check.data }));
    } catch (err) {
      log('warn', 'evm relayer: authorization state unavailable', {
        quoteId: ctx.quoteId,
        leg: check.leg,
        err: err instanceof Error ? err.name : 'error',
      });
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Gasless payments are unavailable; try again',
        503,
      );
    }
    if (used) {
      throw new AppError(
        'QUOTE_EXPIRED',
        'This payment authorization was already used or cancelled; request a new quote',
        409,
        { leg: check.leg },
      );
    }
  }
}

let sharedSender: EvmSender | null = null;

/** The process-wide live sender (`relayer-evm` in the key vault, Redis nonce locks). */
export function liveEvmSender(): EvmSender {
  sharedSender ??= new EvmSender({ kv: getKeyVault(), redis: getRedis() });
  return sharedSender;
}

/** Live mode: relays through `EvmSender`. */
export class EvmGaslessRelayer implements GaslessRelayer {
  readonly family = 'evm' as const;

  constructor(
    private readonly gasless: EvmGasless = new EvmGasless(true),
    private readonly sender: () => EvmSender = liveEvmSender,
  ) {}

  /** Checks the signatures, then that no signed authorization is already used on chain. */
  private async verifyLive(q: QuoteContext, signed: SignedPayload): Promise<RelayCall> {
    const { call, ctx } = await this.gasless.verifyWithContext(q, signed);
    await assertAuthorizationsUnused(this.sender().rpc(ctx.chain), ctx);
    return call;
  }

  options(c: GaslessContext): Promise<GaslessOption[]> {
    return this.gasless.options(c);
  }

  prepare(q: QuoteContext, input: PrepareInput): Promise<PreparePayload> {
    return this.gasless.prepare(q, input);
  }

  submit(q: QuoteContext, signed: SignedPayload): Promise<SubmitResult> {
    return submitRelayed(
      q,
      signed,
      (qq, s) => this.verifyLive(qq, s),
      async (call, submission) => {
        try {
          const res = await this.sender().send({
            chain: call.chain,
            to: call.to,
            data: call.data,
            giveUpAt: submission.giveUpAt,
            purpose: GASLESS_PAYMENT_PURPOSE,
            refId: submission.id,
          });
          return { txHash: res.txHash, relayerTxId: res.txId };
        } catch (err) {
          if (err instanceof EvmNotBroadcastError) {
            // `gas_cap` / `gas_budget` only come from bounds a payment relay never sets (hooks).
            const reason =
              err.reason === 'gas_cap' || err.reason === 'gas_budget' ? 'rejected' : err.reason;
            throw new RelayNotBroadcast(err.message, reason);
          }
          throw err;
        }
      },
    );
  }

  status(submissionId: string): Promise<SubmissionStatus> {
    return submissionStatus(submissionId);
  }
}

/** `relayer_transactions.purpose` of a gasless payment; `ref_id` is the submission id. */
export const GASLESS_PAYMENT_PURPOSE = 'gasless_payment';
