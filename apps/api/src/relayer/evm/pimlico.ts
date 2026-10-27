// The Pimlico paymaster proxy (project 5a, spec §2.3 EVM item 3, §2.5, §8.3): an ERC-7677
// endpoint the pay page passes to a smart wallet as EIP-5792 `wallet_sendCalls`'
// `paymasterService` capability. It answers `pm_getPaymasterStubData` and `pm_getPaymasterData`,
// forwarding to Pimlico (API key: stored secret, purpose `pimlico`) ONLY for a user operation whose
// calls are exactly the current quote's payment:
//
//   token.transfer(depositAddress, amount_in)
//   token.transfer(gas-fees-evm address, fee_amount)      only when the shopper pays in the token
//
// with no native value and no other call, from the quote's wallet, on the quote's chain, through
// EntryPoint v0.7 / v0.8. Anything else is a JSON-RPC error: nothing is sponsored and the pay page
// falls back. The deposit address and amounts come from the quote, the fee recipient from the
// `gas-fees-evm` key; nothing the shopper's money can reach is taken from the request.
//
// `pm_getPaymasterData` is the commitment point: the submission is recorded (`gas_sponsorships`,
// method `paymaster`, provider `pimlico`, `user_op_hash` of the final operation) on the quote's
// reservation (merchant sponsors; it must still be `reserved`) or as a `sponsor = shopper` row.
// The same user operation asked again gets the same paymaster data; another one for the quote is
// refused while one is in flight. The outcome comes from Pimlico's `eth_getUserOperationReceipt`
// (`pollPaymasterOps`, in the EVM relayer's poll job); settlement and loss then follow the shared
// lifecycle (relayer/submissions.ts). Test mode never calls Pimlico: simulated paymaster data,
// and the operation is "mined" at once, as the simulated relayer does.
//
// Never asks for EIP-7702 delegation (spec §8.3): an operation carrying an authorization is refused.
import { Prisma, type Quote } from '@prisma/client';
import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';
import { providerFor, simulatedOneClick } from '../../checkout/oneclick/index.js';
import type { ShopperCtx } from '../../checkout/quotes.js';
import { tenantTransaction } from '../../db/tenant-transaction.js';
import { env } from '../../env.js';
import { SIMULATED_FEE_USD, nativeUsd } from '../../gas/fees.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { log } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { getSecret } from '../../secrets/secrets.js';
import { SIMULATED_GAS_USED } from '../simulated.js';
import {
  ACTIVE,
  applyRelayOutcome,
  assertRelayable,
  countAddressAttempt,
  countAttempt,
  countSessionAttempt,
  gaslessNotAvailable,
  lockOpenSession,
  quoteExpired,
  MIN_RELAY_WINDOW_MS,
  simulatedRelayTxHash,
  sponsorshipReleased,
} from '../submissions.js';
import { gaslessQuote } from '../index.js';
import type { QuoteContext } from '../types.js';
import { evmGasFeeAddress } from './index.js';
import { EVM_CHAIN_IDS, gaslessToken, type GaslessToken } from './tokens.js';
import {
  SUPPORTED_ENTRY_POINTS,
  UserOpRefused,
  decodeAccountCalls,
  maxUserOpCostWei,
  parseUserOp,
  userOpHash,
  type AccountCall,
  type UserOp,
} from './user-op.js';

/** `secrets.purpose` of the Pimlico API key. */
export const PIMLICO_SECRET_PURPOSE = 'pimlico';
/** The ERC-7677 methods served; anything else is JSON-RPC method-not-found. */
export const PAYMASTER_METHODS = ['pm_getPaymasterStubData', 'pm_getPaymasterData'] as const;
type PaymasterMethod = (typeof PAYMASTER_METHODS)[number];

/** `pm_getPaymasterStubData` per session (lifetime) and per wallet per hour (after validation). */
export const STUB_CALLS_PER_SESSION = 20;
export const STUB_CALLS_PER_ADDRESS_PER_HOUR = 60;
/** A recorded operation with no receipt this long past its quote's deadline is given up. */
export const PAYMASTER_GIVE_UP_MS = 60 * 60_000;
/**
 * The most an operation may cost Tendr at its own limits (every gas limit × maxFeePerGas): this
 * multiple of the quote's network fee, and never less than PAYMASTER_MAX_COST_FLOOR_USD. Bounds
 * what a shopper's wallet can make Tendr's Pimlico balance pay (e.g. an inflated priority fee).
 */
export const PAYMASTER_MAX_COST_MULTIPLIER = 10;
export const PAYMASTER_MAX_COST_FLOOR_USD = '0.25';

/** JSON-RPC error codes used by the proxy. */
export const RPC_ERRORS = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Refused: the operation does not match the quote, or the quote/session cannot be paid. */
  refused: -32001,
  /** EIP-1474 "limit exceeded". */
  limit: -32005,
} as const;

type RpcId = string | number | null;
export interface JsonRpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: JsonRpcError };

const HEX = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const QTY = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const ADDR = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const EnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(128), z.number().int(), z.null()]),
  method: z.string().max(64),
  params: z.array(z.unknown()).max(4).optional(),
});

/** ERC-7677 params: `[userOp, entryPoint, chainId, context?]` (the caller's context is ignored). */
const ParamsSchema = z.tuple([z.unknown(), ADDR, QTY]).rest(z.unknown());

/** The paymaster fields of an ERC-7677 result (anything else Pimlico sends is dropped). */
const PaymasterResultSchema = z.object({
  paymaster: ADDR,
  paymasterData: HEX,
  paymasterVerificationGasLimit: QTY.optional(),
  paymasterPostOpGasLimit: QTY.optional(),
  sponsor: z
    .object({ name: z.string().max(100), icon: z.string().max(4096).optional() })
    .optional(),
  isFinal: z.boolean().optional(),
});
export type PaymasterResult = z.infer<typeof PaymasterResultSchema>;

/** What a recorded submission keeps (`gas_sponsorships.paymaster_data`). */
interface StoredPaymaster {
  entryPoint: string;
  chainId: number;
  result: PaymasterResult;
}

// ---------------------------------------------------------------------------------------------
// Pimlico
// ---------------------------------------------------------------------------------------------

/** Pimlico refused or could not be reached; the message never contains the API key. */
export class PimlicoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PimlicoError';
  }
}

/** The newest stored Pimlico API key (`putSecret(key, 'pimlico')`). */
export async function pimlicoApiKey(): Promise<string> {
  const row = await prisma.secret.findFirst({
    where: { purpose: PIMLICO_SECRET_PURPOSE },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!row) throw new PimlicoError('Pimlico is not configured (no stored API key)');
  return getSecret(row.id);
}

const redact = (s: string, key: string) => (key ? s.split(key).join('[redacted]') : s);

/** Pimlico's bundler/paymaster JSON-RPC: `https://api.pimlico.io/v2/{chainId}/rpc?apikey=…`. */
export class PimlicoClient {
  constructor(
    private readonly deps: {
      fetch?: typeof fetch;
      apiKey?: () => Promise<string>;
      timeoutMs?: number;
    } = {},
  ) {}

  async request(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    const key = await (this.deps.apiKey ?? pimlicoApiKey)();
    const url = `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(key)}`;
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new PimlicoError(`unreachable: ${redact(String(err), key).slice(0, 200)}`);
    }
    if (!res.ok) throw new PimlicoError(`HTTP ${res.status}`);
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new PimlicoError('invalid JSON response');
    }
    if (body?.error) {
      const msg = typeof body.error.message === 'string' ? body.error.message : 'error';
      throw new PimlicoError(`${String(body.error.code)} ${redact(msg, key).slice(0, 300)}`);
    }
    return body?.result ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// Validation against the quote
// ---------------------------------------------------------------------------------------------

const ERC20 = new Interface(['function transfer(address to, uint256 amount)']);

const refused = (message: string, field: string) =>
  new AppError('GASLESS_PAYLOAD_MISMATCH', message, 409, { field });

interface Checked {
  q: QuoteContext;
  op: UserOp;
  entryPoint: string;
  chainId: number;
  token: GaslessToken;
}

/** The calls the quote allows, in order: the payment, then (shopper pays in the token) the fee. */
async function expectedCalls(q: QuoteContext, token: GaslessToken): Promise<AccountCall[]> {
  const out: AccountCall[] = [
    {
      to: token.address,
      value: 0n,
      data: ERC20.encodeFunctionData('transfer', [
        q.quote.depositAddress,
        BigInt(q.quote.amountIn.toFixed(0)),
      ]).toLowerCase(),
    },
  ];
  if (q.quote.networkFeePaidBy === 'buyer') {
    const fee = q.quote.networkFeeAmount;
    if (q.quote.networkFeeMode !== 'token' || !fee || fee.lte(0)) throw gaslessNotAvailable();
    out.push({
      to: token.address,
      value: 0n,
      data: ERC20.encodeFunctionData('transfer', [
        await evmGasFeeAddress(),
        BigInt(fee.toFixed(0)),
      ]).toLowerCase(),
    });
  }
  return out;
}

/** The session's current quote, made for a `paymaster` payment, still payable. */
async function currentPaymasterQuote(shopper: ShopperCtx, now: Date): Promise<QuoteContext> {
  const current = await shopper.db.quote.findFirst({
    where: { sessionId: shopper.sessionId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!current) throw new AppError('CONFLICT', 'Request a quote first', 409);
  const { q } = await gaslessQuote(shopper, current.id);
  assertRelayable(q, now);
  if (q.quote.networkFeeMethod !== 'paymaster') throw gaslessNotAvailable();
  return q;
}

/** Every check that does not need Pimlico: quote, chain, entry point, sender, the exact calls. */
async function check(shopper: ShopperCtx, params: unknown[], now: Date): Promise<Checked> {
  const p = ParamsSchema.safeParse(params);
  if (!p.success) {
    throw new UserOpRefused('params must be [userOp, entryPoint, chainId, context?]');
  }
  const [rawOp, entryPointRaw, chainIdRaw] = p.data;
  const q = await currentPaymasterQuote(shopper, now);
  const chain = q.origin.blockchain;
  const chainId = EVM_CHAIN_IDS[chain];
  const token = gaslessToken(chain, q.quote.originAssetId);
  if (!chainId || !token || !token.methods.includes('paymaster')) throw gaslessNotAvailable();
  if (BigInt(chainIdRaw) !== BigInt(chainId)) {
    throw refused('The user operation is for another chain', 'chainId');
  }
  const entryPoint = entryPointRaw.toLowerCase();
  if (!SUPPORTED_ENTRY_POINTS.includes(entryPoint)) {
    throw new UserOpRefused('unsupported entry point (EntryPoint v0.7 or v0.8 only)');
  }
  const op = parseUserOp(rawOp);
  if (op.sender.toLowerCase() !== q.quote.walletAddress!.toLowerCase()) {
    throw refused('The user operation is not from the quoted wallet', 'sender');
  }
  const { calls } = decodeAccountCalls(op.callData);
  const expected = await expectedCalls(q, token);
  if (calls.length !== expected.length) {
    throw refused('The user operation makes other calls than the quoted payment', 'calls');
  }
  for (let i = 0; i < calls.length; i++) {
    const got = calls[i]!;
    const want = expected[i]!;
    if (got.to !== want.to || got.value !== 0n || got.data !== want.data) {
      throw refused('The user operation does not match the quoted payment', `calls.${i}`);
    }
  }
  return { q, op, entryPoint, chainId, token };
}

/** The operation as the wallet will sign it: the paymaster fields of `result` filled in. */
function withPaymaster(op: UserOp, result: PaymasterResult): UserOp {
  return {
    ...op,
    paymaster: result.paymaster,
    paymasterData: result.paymasterData,
    paymasterVerificationGasLimit:
      result.paymasterVerificationGasLimit ?? op.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: result.paymasterPostOpGasLimit ?? op.paymasterPostOpGasLimit,
  };
}

/** Refuses an operation whose own limits let it cost more than the quote can justify. */
async function assertCostBounded(q: QuoteContext, op: UserOp): Promise<void> {
  if (!op.maxFeePerGas || !op.callGasLimit || !op.verificationGasLimit || !op.preVerificationGas) {
    throw new UserOpRefused('pm_getPaymasterData needs the gas limits and fees set');
  }
  let usd: string;
  try {
    usd = await nativeUsd(q.origin.blockchain, maxUserOpCostWei(op), q.shopper.livemode);
  } catch {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Gasless payments are unavailable; try again', 503);
  }
  const quoted = (q.quote.networkFeeUsd ?? new Prisma.Decimal(0)).mul(
    PAYMASTER_MAX_COST_MULTIPLIER,
  );
  const limit = Prisma.Decimal.max(quoted, PAYMASTER_MAX_COST_FLOOR_USD);
  if (new Prisma.Decimal(usd).gt(limit)) {
    throw refused('The user operation’s gas limits or fees are too high to sponsor', 'gas');
  }
}

// ---------------------------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------------------------

const inFlight = () =>
  new AppError(
    'CONFLICT',
    'Another payment for this quote is in progress; wait for it or request a new quote',
    409,
  );

const scopeOf = (q: QuoteContext) => ({
  merchantId: q.shopper.merchantId,
  livemode: q.shopper.livemode,
});

function storedOf(row: { paymasterData: Prisma.JsonValue | null }): StoredPaymaster | null {
  const v = row.paymasterData as Partial<StoredPaymaster> | null;
  if (!v || typeof v.entryPoint !== 'string' || typeof v.chainId !== 'number') return null;
  const r = PaymasterResultSchema.safeParse(v.result);
  return r.success ? { entryPoint: v.entryPoint, chainId: v.chainId, result: r.data } : null;
}

/** The stored result when `op` is the operation already recorded for the quote. */
function sameOperation(
  row: { userOpHash: string | null; paymasterData: Prisma.JsonValue | null },
  op: UserOp,
  entryPoint: string,
  chainId: number,
): PaymasterResult | null {
  const stored = storedOf(row);
  if (
    !stored ||
    !row.userOpHash ||
    stored.entryPoint !== entryPoint ||
    stored.chainId !== chainId
  ) {
    return null;
  }
  return userOpHash(withPaymaster(op, stored.result), entryPoint, chainId) === row.userOpHash
    ? stored.result
    : null;
}

export interface PaymasterDeps {
  pimlico?: PimlicoClient;
  /** Pimlico sponsorship policy (default: PIMLICO_SPONSORSHIP_POLICY_ID). */
  policyId?: () => string | undefined;
  now?: () => Date;
}

export class PaymasterProxy {
  constructor(
    /** Live: forward to Pimlico. Test mode: simulated data, never Pimlico. */
    private readonly live: boolean,
    private readonly deps: PaymasterDeps = {},
  ) {}

  private get pimlico(): PimlicoClient {
    return this.deps.pimlico ?? defaultPimlico();
  }

  private context(): Record<string, string> {
    const id = (this.deps.policyId ?? (() => env().PIMLICO_SPONSORSHIP_POLICY_ID))();
    return id ? { sponsorshipPolicyId: id } : {};
  }

  /** Answers one JSON-RPC request for the shopper's session. Never throws. */
  async handle(shopper: ShopperCtx, body: unknown): Promise<JsonRpcResponse> {
    const envelope = EnvelopeSchema.safeParse(body);
    const id: RpcId = envelope.success
      ? envelope.data.id
      : body && typeof body === 'object' && 'id' in body
        ? ((body as { id: unknown }).id as RpcId)
        : null;
    const safeId = typeof id === 'string' || typeof id === 'number' ? id : null;
    if (!envelope.success) {
      return rpcError(safeId, { code: RPC_ERRORS.invalidRequest, message: 'Invalid request' });
    }
    const method = envelope.data.method;
    if (!(PAYMASTER_METHODS as readonly string[]).includes(method)) {
      return rpcError(safeId, {
        code: RPC_ERRORS.methodNotFound,
        message: `Method not found: only ${PAYMASTER_METHODS.join(', ')}`,
      });
    }
    try {
      const result = await this.dispatch(
        shopper,
        method as PaymasterMethod,
        envelope.data.params ?? [],
      );
      return { jsonrpc: '2.0', id: safeId, result };
    } catch (err) {
      return rpcError(safeId, toRpcError(err, shopper.sessionId));
    }
  }

  private dispatch(shopper: ShopperCtx, method: PaymasterMethod, params: unknown[]) {
    return method === 'pm_getPaymasterStubData'
      ? this.stubData(shopper, params)
      : this.paymasterData(shopper, params);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async requireHeld(q: QuoteContext): Promise<void> {
    if (q.quote.networkFeePaidBy !== 'merchant') return;
    const held = q.quote.gasSponsorshipId
      ? await prisma.gasSponsorship.findFirst({
          where: { ...scopeOf(q), id: q.quote.gasSponsorshipId },
          select: { reservationState: true },
        })
      : null;
    if (held?.reservationState !== 'reserved') throw sponsorshipReleased();
  }

  /** Gas estimation data: validated like the real thing, records nothing. */
  async stubData(shopper: ShopperCtx, params: unknown[]): Promise<PaymasterResult> {
    const now = this.now();
    const c = await check(shopper, params, now);
    await this.requireHeld(c.q);
    const wallet = c.q.quote.walletAddress!.toLowerCase();
    const limits = {
      max_per_session: STUB_CALLS_PER_SESSION,
      max_per_address_per_hour: STUB_CALLS_PER_ADDRESS_PER_HOUR,
    };
    await countAttempt(
      `tendr:gasless:pm-stub:ses:${c.q.session.id}`,
      3 * 24 * 3600,
      STUB_CALLS_PER_SESSION,
      limits,
    );
    await countAttempt(
      `tendr:gasless:pm-stub:addr:${wallet}:${Math.floor(now.getTime() / 3_600_000)}`,
      3600,
      STUB_CALLS_PER_ADDRESS_PER_HOUR,
      limits,
    );
    if (!this.live) return simulatedResult(c.q.quote.id, true);
    return this.forward('pm_getPaymasterStubData', c);
  }

  /** The commitment point: forwards, records the submission, returns the paymaster data. */
  async paymasterData(shopper: ShopperCtx, params: unknown[]): Promise<PaymasterResult> {
    const now = this.now();
    const c = await check(shopper, params, now);
    const { q, op, entryPoint, chainId } = c;
    const scope = scopeOf(q);
    const active = await prisma.gasSponsorship.findFirst({
      where: { ...scope, quoteId: q.quote.id, status: ACTIVE },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      const same = sameOperation(active, op, entryPoint, chainId);
      if (same) return same;
      throw inFlight();
    }
    await this.requireHeld(q);
    await assertCostBounded(q, op);
    // The limits count only operations that passed validation (ruling T6-e).
    await countSessionAttempt(q);
    await countAddressAttempt(q, now);

    const result = this.live
      ? await this.forward('pm_getPaymasterData', c)
      : simulatedResult(q.quote.id, false);
    const final = withPaymaster(op, result);
    // Again with the paymaster's own gas limits, as the wallet will sign it.
    await assertCostBounded(q, final);
    const hash = userOpHash(final, entryPoint, chainId);
    const recorded = await record(q, now, { entryPoint, chainId, result }, hash, op);
    if (recorded.existing) return recorded.result;
    if (!this.live) await simulateMined(q, recorded.id);
    return result;
  }

  private async forward(method: PaymasterMethod, c: Checked): Promise<PaymasterResult> {
    let raw: unknown;
    try {
      raw = await this.pimlico.request(c.chainId, method, [
        c.op,
        c.entryPoint,
        `0x${c.chainId.toString(16)}`,
        this.context(),
      ]);
    } catch (err) {
      log('warn', 'paymaster proxy: Pimlico refused or unavailable', {
        method,
        quoteId: c.q.quote.id,
        err: err instanceof PimlicoError ? err.message : 'request failed',
      });
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Sponsorship is unavailable for this payment; pay another way',
        503,
      );
    }
    const r = PaymasterResultSchema.safeParse(raw);
    if (!r.success) {
      log('warn', 'paymaster proxy: unexpected Pimlico result', { method, quoteId: c.q.quote.id });
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Sponsorship is unavailable for this payment; pay another way',
        503,
      );
    }
    return r.data;
  }
}

/**
 * Records the submission under the session lock: claims the quote's reservation (merchant
 * sponsors) or creates a `sponsor = shopper` row. A concurrent request that recorded the same
 * operation first is returned as is; another operation is refused.
 */
async function record(
  q: QuoteContext,
  now: Date,
  stored: StoredPaymaster,
  hash: string,
  op: UserOp,
): Promise<{ id: string; existing: boolean; result: PaymasterResult }> {
  const scope = scopeOf(q);
  return tenantTransaction(scope, async (tx) => {
    await lockOpenSession(tx, scope, q.session.id, now);
    const quote = await tx.quote.findFirst({
      where: { ...scope, id: q.quote.id, sessionId: q.session.id },
    });
    if (!quote || quote.supersededAt) throw quoteExpired('was replaced by a newer one');
    if (quote.deadline.getTime() - MIN_RELAY_WINDOW_MS <= now.getTime()) {
      throw quoteExpired('has expired');
    }
    const existing = await tx.gasSponsorship.findFirst({
      where: { ...scope, quoteId: quote.id, status: ACTIVE },
    });
    if (existing) {
      const same = sameOperation(existing, op, stored.entryPoint, stored.chainId);
      if (same) return { id: existing.id, existing: true, result: same };
      throw inFlight();
    }
    const signer = quote.walletAddress!.toLowerCase();
    const json = stored as unknown as Prisma.InputJsonValue;
    if (quote.networkFeePaidBy === 'merchant') {
      const { count } = await tx.gasSponsorship.updateMany({
        where: {
          ...scope,
          id: quote.gasSponsorshipId ?? '',
          reservationState: 'reserved',
          quoteId: null,
          status: 'pending',
        },
        data: {
          quoteId: quote.id,
          signerAddress: signer,
          userOpHash: hash,
          paymasterData: json,
          status: 'submitted',
        },
      });
      if (count !== 1) throw sponsorshipReleased();
      return { id: quote.gasSponsorshipId!, existing: false, result: stored.result };
    }
    const id = newId('gas');
    await tx.gasSponsorship.create({
      data: {
        id,
        ...scope,
        sessionId: q.session.id,
        chain: q.origin.blockchain,
        method: 'paymaster',
        provider: 'pimlico',
        sponsor: 'shopper',
        status: 'submitted',
        feeMode: 'token',
        feeAsset: quote.originAssetId,
        feeAmount: quote.networkFeeAmount,
        estimateUsd: quote.networkFeeUsd,
        quoteId: quote.id,
        signerAddress: signer,
        userOpHash: hash,
        paymasterData: json,
      },
    });
    return { id, existing: false, result: stored.result };
  });
}

/** Test mode: obviously simulated paymaster data, deterministic per quote. */
function simulatedResult(quoteId: string, stub: boolean): PaymasterResult {
  return {
    paymaster: SIMULATED_PAYMASTER,
    paymasterData: keccak256(toUtf8Bytes(`tendr:simulated-paymaster:${quoteId}`)),
    paymasterVerificationGasLimit: '0x186a0',
    paymasterPostOpGasLimit: '0x1',
    ...(stub ? { isFinal: false } : {}),
  };
}

/** Test mode's paymaster address (no contract). */
export const SIMULATED_PAYMASTER = '0x000000000000000000000000000000000000dead';

/** Test mode: the operation is mined at once and the deposit reaches the simulated 1Click. */
async function simulateMined(q: QuoteContext, id: string): Promise<void> {
  const txHash = simulatedRelayTxHash(id);
  await applyRelayOutcome(id, {
    status: 'confirmed',
    txHash,
    gasUsed: SIMULATED_GAS_USED,
    costUsd: SIMULATED_FEE_USD[q.origin.blockchain] ?? null,
    reason: null,
    feeMoved:
      q.quote.networkFeePaidBy === 'buyer' && q.quote.networkFeeAmount
        ? BigInt(q.quote.networkFeeAmount.toFixed(0))
        : null,
  });
  await markDepositTx(q.quote, txHash);
  try {
    await simulatedOneClick().simulate(q.quote.depositAddress, 'exact', {
      senderAddress: q.quote.walletAddress!,
    });
  } catch (err) {
    log('warn', 'simulated paymaster: deposit simulation failed', {
      submissionId: id,
      err: String(err),
    });
  }
}

/** The quote's deposit is on chain: record its hash (blocks re-quoting) and tell 1Click. */
async function markDepositTx(
  quote: Pick<Quote, 'id' | 'merchantId' | 'livemode' | 'depositAddress'>,
  txHash: string,
): Promise<void> {
  const scope = { merchantId: quote.merchantId, livemode: quote.livemode };
  await tenantTransaction(scope, (tx) =>
    tx.quote.updateMany({
      where: { ...scope, id: quote.id, depositTxHash: null },
      data: { depositTxHash: txHash, depositTxSubmittedAt: new Date() },
    }),
  );
  try {
    await providerFor(quote.livemode).submitDeposit(txHash, quote.depositAddress);
  } catch (err) {
    log('warn', 'paymaster: 1Click deposit notice failed', { quoteId: quote.id, err: String(err) });
  }
}

/** JSON-RPC error for anything the proxy throws (never a stack, never a secret). */
function toRpcError(err: unknown, sessionId: string): JsonRpcError {
  if (err instanceof UserOpRefused) {
    return { code: RPC_ERRORS.invalidParams, message: err.message };
  }
  if (err instanceof AppError) {
    const data = {
      code: err.code,
      ...(err.details && typeof err.details === 'object'
        ? (err.details as Record<string, unknown>)
        : {}),
    };
    if (err.code === 'RATE_LIMITED') return { code: RPC_ERRORS.limit, message: err.message, data };
    if (err.status >= 500) return { code: RPC_ERRORS.internal, message: err.message, data };
    return { code: RPC_ERRORS.refused, message: err.message, data };
  }
  log('error', 'paymaster proxy: unexpected error', { sessionId, err: String(err) });
  return { code: RPC_ERRORS.internal, message: 'Internal error' };
}

function rpcError(id: RpcId, error: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error };
}

let sharedPimlico: PimlicoClient | null = null;
const defaultPimlico = () => (sharedPimlico ??= new PimlicoClient());

const proxies = new Map<boolean, PaymasterProxy>();

/** The proxy for a mode: live forwards to Pimlico; test mode never does. */
export function paymasterFor(livemode: boolean): PaymasterProxy {
  let p = proxies.get(livemode);
  if (!p) {
    p = new PaymasterProxy(livemode);
    proxies.set(livemode, p);
  }
  return p;
}

/** Drops the cached proxies and client (tests). */
export function resetPaymasters(): void {
  proxies.clear();
  sharedPimlico = null;
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

const ReceiptSchema = z.object({
  success: z.boolean(),
  actualGasCost: QTY,
  actualGasUsed: QTY,
  logs: z.array(z.object({ address: ADDR, topics: z.array(z.string()), data: HEX })).default([]),
  receipt: z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
});

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddress = (t: string | undefined) => (t ? `0x${t.slice(26)}`.toLowerCase() : '');

/**
 * The fee a mined operation moved to the gas-fee address: its own `Transfer`s of the fee token
 * from the shopper's wallet to that address (the operation's logs, not the whole bundle's), capped
 * at the fee signed. Never assumed from the quote.
 */
export function userOpFeeMoved(
  logs: { address: string; topics: string[]; data: string }[],
  where: { token: string; from: string; feeTo: string; cap: bigint },
): bigint {
  let fee = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== where.token.toLowerCase()) continue;
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0 || l.topics.length < 3) continue;
    if (topicAddress(l.topics[1]) !== where.from.toLowerCase()) continue;
    if (topicAddress(l.topics[2]) !== where.feeTo.toLowerCase()) continue;
    try {
      fee += BigInt(l.data);
    } catch {
      continue;
    }
  }
  return fee > where.cap ? where.cap : fee;
}

/**
 * One pass over live paymaster submissions awaiting their outcome: asks Pimlico for each
 * operation's receipt and applies it (`applyRelayOutcome`: actual gas and cost, a shopper fee leg's
 * revenue from what moved, loss rules). An operation with no receipt PAYMASTER_GIVE_UP_MS past its
 * quote's deadline is failed (the wallet never sent it; no gas spent). Returns how many outcomes
 * were applied.
 */
export async function pollPaymasterOps(
  deps: {
    pimlico?: PimlicoClient;
    now?: () => Date;
    /** Live rows only (default). Test-mode rows are mined at once and never reach Pimlico. */
    livemode?: boolean;
  } = {},
): Promise<number> {
  const pimlico = deps.pimlico ?? defaultPimlico();
  const now = deps.now?.() ?? new Date();
  const rows = await prisma.gasSponsorship.findMany({
    where: {
      livemode: deps.livemode ?? true,
      method: 'paymaster',
      provider: 'pimlico',
      status: 'submitted',
      userOpHash: { not: null },
      quoteId: { not: null },
    },
    include: { quote: true },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  let applied = 0;
  for (const row of rows) {
    const quote = row.quote;
    const chainId = EVM_CHAIN_IDS[row.chain];
    if (!quote || !chainId) continue;
    try {
      const raw = await pimlico.request(chainId, 'eth_getUserOperationReceipt', [row.userOpHash]);
      if (raw === null) {
        if (now.getTime() > quote.deadline.getTime() + PAYMASTER_GIVE_UP_MS) {
          if (
            await applyRelayOutcome(
              row.id,
              {
                status: 'failed',
                txHash: null,
                gasUsed: null,
                costUsd: null,
                reason: 'the user operation was not seen on chain',
                feeMoved: null,
              },
              now,
            )
          ) {
            applied++;
          }
        }
        continue;
      }
      const r = ReceiptSchema.safeParse(raw);
      if (!r.success) {
        log('warn', 'paymaster: unreadable user operation receipt', { sponsorshipId: row.id });
        continue;
      }
      const receipt = r.data;
      let costUsd: string | null = null;
      try {
        costUsd = await nativeUsd(row.chain, BigInt(receipt.actualGasCost), row.livemode);
      } catch (err) {
        log('warn', 'paymaster: cost unpriced', { sponsorshipId: row.id, err: String(err) });
      }
      const txHash = receipt.receipt.transactionHash.toLowerCase();
      let feeMoved: bigint | null = null;
      if (receipt.success && row.sponsor === 'shopper' && row.feeAsset && row.feeAmount) {
        const token = gaslessToken(row.chain, row.feeAsset);
        feeMoved = token
          ? userOpFeeMoved(receipt.logs, {
              token: token.address,
              from: row.signerAddress ?? quote.walletAddress ?? '',
              feeTo: await evmGasFeeAddress(),
              cap: BigInt(row.feeAmount.toFixed(0)),
            })
          : 0n;
      }
      const did = await applyRelayOutcome(
        row.id,
        {
          status: receipt.success ? 'confirmed' : 'failed',
          txHash,
          gasUsed: BigInt(receipt.actualGasUsed),
          costUsd,
          reason: receipt.success ? null : 'the user operation reverted',
          feeMoved,
        },
        now,
      );
      if (did) applied++;
      if (did && receipt.success) await markDepositTx(quote, txHash);
    } catch (err) {
      log('warn', 'paymaster: receipt lookup failed', {
        sponsorshipId: row.id,
        err: err instanceof PimlicoError ? err.message : String(err),
      });
    }
  }
  return applied;
}
