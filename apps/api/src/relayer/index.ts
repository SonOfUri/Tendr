// Gasless relayer entry points (project 5a, spec §2.3, §3): `relayerFor(family, livemode)` picks
// the family's relayer (the simulated one in test mode), and `pollEvmRelays` sees the live EVM
// relayer's transactions through to an outcome (a worker job).
import { GaslessMethodSchema, TENDR_FORWARDER_ABI } from '@tendr/contracts';
import { Interface } from 'ethers';
import { z } from 'zod';
import { chainFamily, isValidAddress } from '../checkout/address-format.js';
import type { ShopperCtx } from '../checkout/quotes.js';
import { tokenInfo, tokenList } from '../checkout/tokens.js';
import { env } from '../env.js';
import { isNativeToken, nativeUsd } from '../gas/fees.js';
import { AppError, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import {
  EvmGasless,
  EvmGaslessRelayer,
  GASLESS_PAYMENT_PURPOSE,
  evmForwarderAddress,
  evmGasFeeAddress,
  liveEvmSender,
} from './evm/index.js';
import { recordUnrecovered } from './evm/pimlico.js';
import { evmTokenAddress } from './evm/tokens.js';
import { prisma } from '../lib/prisma.js';
import type { EvmSender } from './evm/sender.js';
import { NearMetaGasless, nearGasFeeAccount } from './near-meta.js';
import { SimulatedRelayer } from './simulated.js';
import { SolanaGasless, solanaGasFeeAddress } from './solana.js';
import { TronGasless } from './tron.js';
import { tronGasFeeAddress } from './tron-energy.js';
import { applyRelayOutcome } from './submissions.js';
import { applyEvmHookOutcome } from '../hooks/deliver.js';
import { INTEGRATOR_HOOK_PURPOSE } from '../hooks/guard.js';
import type {
  ChainFamily,
  GaslessContext,
  GaslessOptions,
  GaslessRelayer,
  QuoteContext,
} from './types.js';

export type * from './types.js';
export { onQuotePaymentDetected } from './submissions.js';

/** The relayer family of a 1Click chain, or null for chains with nothing to relay (Bitcoin…). */
export function familyOf(chain: string): ChainFamily | null {
  const f = chainFamily(chain);
  return f === 'evm' || f === 'solana' || f === 'tron' || f === 'near' ? f : null;
}

const relayers = new Map<string, GaslessRelayer>();

/**
 * The gasless relayer for a chain family and mode. Test mode always gets the simulated relayer
 * (Solana's, NEAR's and Tron's simulate inside `SolanaGasless` / `NearMetaGasless` /
 * `TronGasless`: no Pimlico, no RPC). Live mode gets none (null) unless `GASLESS_LIVE_ENABLED`.
 */
export function relayerFor(family: ChainFamily, livemode: boolean): GaslessRelayer | null {
  // Checked before the cache, so a cached live relayer is never handed out while the switch is off.
  if (livemode && !env().GASLESS_LIVE_ENABLED) return null;
  const key = `${family}:${livemode}`;
  const hit = relayers.get(key);
  if (hit) return hit;
  let r: GaslessRelayer | null = null;
  if (family === 'evm') {
    r = livemode
      ? new EvmGaslessRelayer(new EvmGasless(true))
      : new SimulatedRelayer('evm', new EvmGasless(false));
  }
  if (family === 'solana') r = new SolanaGasless(livemode);
  if (family === 'near') r = new NearMetaGasless(livemode);
  if (family === 'tron') r = new TronGasless(livemode);
  if (r) relayers.set(key, r);
  return r;
}

/**
 * One pass of the live EVM relayer: receipts, replacements, give-ups; then every final outcome
 * is applied to its gasless submission (`applyRelayOutcome`) or integrator hook call
 * (`applyEvmHookOutcome`) and marked handled. Returns how many outcomes were applied.
 */
export async function pollEvmRelays(sender: EvmSender = liveEvmSender()): Promise<number> {
  const outcomes = await sender.tick();
  let applied = 0;
  for (const o of outcomes) {
    try {
      if (o.purpose === GASLESS_PAYMENT_PURPOSE) {
        let costUsd: string | null = null;
        if (o.gasUsed !== null && o.effectiveGasPrice !== null) {
          try {
            // OP-stack chains charge the L1 data fee on top of L2 gas: part of the actual cost
            // (and of any loss the daily cap counts).
            const wei = o.gasUsed * o.effectiveGasPrice + (o.l1Fee ?? 0n);
            costUsd = await nativeUsd(o.chain, wei, true);
          } catch (err) {
            log('warn', 'evm relayer: cost unpriced', { txId: o.txId, err: String(err) });
          }
        }
        let feeMoved: bigint | null = null;
        if (o.status === 'confirmed') {
          const sp = await prisma.gasSponsorship.findUnique({
            where: { id: o.refId },
            select: { feeAsset: true, feeAmount: true },
          });
          const token = sp?.feeAsset ? evmTokenAddress(sp.feeAsset) : null;
          feeMoved = feeMovedFrom(o.logs, {
            forwarder: evmForwarderAddress(),
            ...(token ? { token, feeTo: await evmGasFeeAddress() } : {}),
            ...(sp?.feeAmount ? { cap: BigInt(sp.feeAmount.toFixed(0)) } : {}),
          });
        }
        const did = await applyRelayOutcome(o.refId, {
          status: o.status,
          txHash: o.txHash,
          gasUsed: o.gasUsed,
          costUsd,
          reason: o.reason,
          feeMoved,
          relayerTxId: o.txId,
        });
        // Partial loss (as the other families): the actual cost above what is recovered (the
        // merchant's estimate, or the collected fee) counts toward the daily loss cap.
        if (did) await recordUnrecovered(o.refId, new Date());
        applied++;
      } else if (o.purpose === INTEGRATOR_HOOK_PURPOSE) {
        // An integrator hook call (`onTendrDeposit`): success, or a failed attempt to retry.
        await applyEvmHookOutcome(o);
        applied++;
      }
      await sender.markHandled(o.txId);
    } catch (err) {
      log('error', 'evm relayer: applying an outcome failed', { txId: o.txId, err: String(err) });
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------------------------
// Shopper route inputs and contexts
// ---------------------------------------------------------------------------------------------

const QUOTE_ID = z.string().regex(/^quo_[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a quote id');

export const GaslessOptionsInputSchema = z
  .object({
    origin_asset: z.string().min(1).max(200),
    wallet_address: z.string().trim().min(1).max(128),
  })
  .strict();

export const GaslessPrepareInputSchema = z
  .object({
    quote_id: QUOTE_ID,
    method: GaslessMethodSchema.optional(),
    fee_mode: z.enum(['token', 'native']).optional(),
  })
  .strict();

const SignedPartSchema = z
  .object({
    message: z
      .record(z.string().max(64), z.union([z.string().max(200), z.number().int()]))
      .refine((m) => Object.keys(m).length <= 16, 'too many fields'),
    signature: z.string().regex(/^0x[0-9a-fA-F]{2,260}$/, 'must be a 0x hex signature'),
  })
  .strict();

export const GaslessSubmitInputSchema = z
  .object({
    quote_id: QUOTE_ID,
    /** EVM: keyed by `to_sign[].kind` from prepare. */
    signatures: z
      .record(z.string().regex(/^[a-z_]{1,32}$/), SignedPartSchema)
      .refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 4, {
        message: 'between 1 and 4 signatures',
      })
      .optional(),
    /** Solana: the prepared transaction as the wallet signed it (base64 wire bytes). */
    transaction: z
      .string()
      .max(1700)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be a base64 transaction')
      .optional(),
    /** NEAR: the prepared delegate action as the wallet signed it (base64 borsh SignedDelegate). */
    signed_delegate: z
      .string()
      .max(1700)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be a base64 signed delegate action')
      .optional(),
    /**
     * Tron step 1: the prepared approve transaction as the wallet signed it (`raw_data_hex` exactly
     * as prepared, and its one 65-byte signature, hex). Tendr broadcasts it.
     */
    tron_approve: z
      .object({
        raw_data_hex: z
          .string()
          .max(1000)
          .regex(/^([0-9a-fA-F]{2})+$/, 'must be hex'),
        signature: z.string().regex(/^(0x)?[0-9a-fA-F]{130}$/, 'must be a 65-byte hex signature'),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.signatures, v.transaction, v.signed_delegate, v.tron_approve].filter(
        (x) => x !== undefined,
      ).length === 1,
    { message: 'send exactly one of signatures, transaction, signed_delegate or tron_approve' },
  );

async function loadSession(shopper: ShopperCtx) {
  const s = await shopper.db.session.findFirst({ where: { id: shopper.sessionId } });
  if (!s) throw notFound('Session not found');
  return s;
}

/**
 * The gasless options for a wallet + token on the shopper's session (an empty list when the
 * family has no relayer, the token is not allow-listed, or the fee cannot be quoted gasless).
 */
export async function gaslessOptions(
  shopper: ShopperCtx,
  input: z.infer<typeof GaslessOptionsInputSchema>,
): Promise<GaslessOptions> {
  const session = await loadSession(shopper);
  if (session.status !== 'PENDING_DEPOSIT' || session.expiresAt.getTime() <= Date.now()) {
    throw new AppError('SESSION_EXPIRED', 'This checkout is no longer taking payments', 409);
  }
  const origin = await tokenInfo(shopper.livemode, input.origin_asset);
  if (!isValidAddress(origin.blockchain, input.wallet_address)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `wallet_address is not a valid ${origin.blockchain} address`,
      400,
      { field: 'wallet_address' },
    );
  }
  const family = familyOf(origin.blockchain);
  const relayer = family ? relayerFor(family, shopper.livemode) : null;
  const c: GaslessContext = { shopper, session, origin, walletAddress: input.wallet_address };
  let native: string | null = null;
  for (const t of (await tokenList(shopper.livemode)).values()) {
    if (t.blockchain === origin.blockchain && isNativeToken(t)) {
      native = t.symbol;
      break;
    }
  }
  const options = relayer && !isNativeToken(origin) ? await relayer.options(c) : [];
  return {
    chain: origin.blockchain,
    family,
    native_symbol: native,
    fee_recipient: family && options.length > 0 ? await gasFeeRecipient(family) : null,
    options,
  };
}

/** Tendr's gas-fee account for a family (the address every shopper-paid fee leg goes to). */
export function gasFeeRecipient(family: ChainFamily): Promise<string> {
  switch (family) {
    case 'evm':
      return evmGasFeeAddress();
    case 'solana':
      return solanaGasFeeAddress();
    case 'tron':
      return tronGasFeeAddress();
    case 'near':
      return nearGasFeeAccount();
  }
}

/**
 * The session's quote `quoteId` with its relayer. A quote of another session (or unknown) is
 * 409 GASLESS_PAYLOAD_MISMATCH: a payload is only ever relayed for the session it was signed in.
 */
export async function gaslessQuote(
  shopper: ShopperCtx,
  quoteId: string,
): Promise<{ q: QuoteContext; relayer: GaslessRelayer }> {
  const [session, quote] = await Promise.all([
    loadSession(shopper),
    shopper.db.quote.findFirst({ where: { id: quoteId, sessionId: shopper.sessionId } }),
  ]);
  if (!quote) {
    throw new AppError(
      'GASLESS_PAYLOAD_MISMATCH',
      'The signed payment does not match this checkout',
      409,
      { field: 'quote_id' },
    );
  }
  const origin = await tokenInfo(shopper.livemode, quote.originAssetId);
  const family = familyOf(origin.blockchain);
  const relayer = family ? relayerFor(family, shopper.livemode) : null;
  if (!relayer || !quote.walletAddress) {
    throw new AppError(
      'GASLESS_NOT_AVAILABLE',
      'This quote is not for a gasless payment; request a gasless quote',
      409,
    );
  }
  return {
    q: { shopper, session, origin, quote, walletAddress: quote.walletAddress },
    relayer,
  };
}

/** A submission of this session (status and hash), or 404. Tron approvals (`tap_`) included. */
export async function gaslessSubmission(shopper: ShopperCtx, id: string) {
  if (id.startsWith('tap_')) {
    const a = await prisma.tronApproval.findFirst({
      where: {
        id,
        sessionId: shopper.sessionId,
        merchantId: shopper.merchantId,
        livemode: shopper.livemode,
      },
      select: { id: true, status: true, txId: true, quoteId: true },
    });
    if (!a) throw notFound('Submission not found');
    return { id: a.id, quote_id: a.quoteId, status: a.status, tx_hash: a.txId, step: 'approve' };
  }
  const row = await shopper.db.gasSponsorship.findFirst({
    where: { id, sessionId: shopper.sessionId, quoteId: { not: null } },
    select: { id: true, status: true, txHash: true, quoteId: true },
  });
  if (!row) throw notFound('Submission not found');
  return { id: row.id, quote_id: row.quoteId, status: row.status, tx_hash: row.txHash };
}

const FORWARDER_EVENTS = new Interface(TENDR_FORWARDER_ABI as unknown as string);

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * The fee a mined forwarder call moved to the gas-fee address: the sum of `TendrPaid.fee` emitted
 * by the forwarder. When that is 0 (the forwarder skipped a fee authorization already used), the
 * receipt's own `Transfer`s of the fee token to the gas-fee address count instead. Never assumed
 * from the quote. `TendrPaid` measures only Tendr's own fee here; payment detection never reads it.
 */
export function feeMovedFrom(
  logs: { address?: string; topics: string[]; data: string }[],
  where: { forwarder: string; token?: string; feeTo?: string; cap?: bigint },
): bigint {
  let fee = 0n;
  for (const l of logs) {
    if (l.address && l.address.toLowerCase() !== where.forwarder.toLowerCase()) continue;
    let parsed: ReturnType<Interface['parseLog']>;
    try {
      parsed = FORWARDER_EVENTS.parseLog(l);
    } catch {
      continue;
    }
    if (parsed?.name === 'TendrPaid') fee += parsed.args.fee as bigint;
  }
  if (fee > 0n || !where.token || !where.feeTo) return fee;
  const feeTo = where.feeTo.toLowerCase();
  for (const l of logs) {
    if (l.address?.toLowerCase() !== where.token.toLowerCase()) continue;
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0 || l.topics.length < 3) continue;
    if (`0x${l.topics[2]!.slice(26)}`.toLowerCase() !== feeTo) continue;
    try {
      fee += BigInt(l.data);
    } catch {
      continue;
    }
  }
  // Never more than the fee the shopper signed.
  return where.cap !== undefined && fee > where.cap ? where.cap : fee;
}

/** Drops the cached relayers (tests). */
export function resetRelayers(): void {
  relayers.clear();
}
