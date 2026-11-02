import type { Prisma, NativePayout } from '@prisma/client';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import {
  HttpOneClick,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
} from '../checkout/oneclick/index.js';
import { isValidAddress } from '../checkout/address-format.js';
import { tokenInfo } from '../checkout/tokens.js';
import { screenPayoutAddress } from '../checkout/screening.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import type { ScopeContext } from '../db/scoped.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertLiveModeOpen } from '../lib/live-mode.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { nearClient } from '../near/client.js';
import { ActionSchema } from './encoding.js';
import { balancesCacheKey } from './accounts.js';
import {
  nativeAuthenticationOptions,
  ownedNativeWallet,
  verifyNativeAssertion,
  type NativeActor,
} from './native-accounts.js';
import { validateTransferPayload, type NativeSignedIntent } from './native-signing.js';

const amount = z
  .string()
  .regex(/^[1-9]\d{0,38}$/)
  .refine((s) => BigInt(s) < 1n << 128n);
const asset = z.string().min(8).max(256).startsWith('nep141:');
export const NativePayoutInput = z.union([
  z
    .object({ asset, amount, destinationAsset: asset, destination: z.string().min(2).max(128) })
    .strict(),
  z.object({ proposalId: z.string().min(1).max(64) }).strict(),
]);
type Input = z.infer<typeof NativePayoutInput>;
type Provider = {
  quote(input: QuoteRequest): Promise<QuoteResponse>;
  generateIntent(signer: string, deposit: string): Promise<string>;
  submitIntent(signed: NativeSignedIntent): Promise<string>;
  status(deposit: string): Promise<StatusResponse>;
};
const defaults = {
  provider: (): Provider =>
    new HttpOneClick({ baseUrl: env().ONECLICK_BASE_URL, apiKey: env().ONECLICK_API_KEY }),
  screen: screenPayoutAddress,
};
let deps = defaults;
/** Dependency seam for offline integration tests. */
export function setNativePayoutDeps(overrides: Partial<typeof defaults> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}
const scope = (ctx: ScopeContext) => ({ merchantId: ctx.merchantId, livemode: ctx.livemode });
const json = (v: unknown) => v as Prisma.InputJsonValue;
const LEASE_MS = 60_000;
const open = ['submitting', 'submitted'] as const;

function payoutView(p: NativePayout) {
  return {
    id: p.id,
    status: p.status === 'awaiting_signature' && p.expiresAt <= new Date() ? 'expired' : p.status,
    asset: p.asset,
    amount: p.amount,
    destinationAsset: p.destinationAsset,
    destinationChain: p.destinationChain,
    destination: p.destination,
    proposalId: p.proposalId,
    quote: p.quote,
    intentHash: p.intentHash,
    providerStatus: p.providerStatus,
    expiresAt: p.expiresAt,
    createdAt: p.createdAt,
  };
}
async function load(ctx: ScopeContext, id: string) {
  const p = await prisma.nativePayout.findFirst({ where: { id, ...scope(ctx) } });
  if (!p) throw notFound('Payout not found');
  return p;
}
export async function getNativePayout(ctx: ScopeContext, id: string) {
  return payoutView(await load(ctx, id));
}
export async function listNativePayouts(ctx: ScopeContext) {
  return (
    await prisma.nativePayout.findMany({
      where: scope(ctx),
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  ).map(payoutView);
}

async function screen(ctx: ScopeContext, address: string, chain: string) {
  const decision = await deps.screen(ctx, address, chain);
  if (decision !== 'allow')
    throw new AppError(
      decision === 'block' ? 'VALIDATION_ERROR' : 'PROVIDER_UNAVAILABLE',
      decision === 'block'
        ? 'This payout address is blocked'
        : 'Address screening is unavailable; try again shortly',
      decision === 'block' ? 400 : 503,
    );
}

/** No arbitrary intent endpoint. The service constructs the quote and checks its one transfer. */
export async function createNativePayout(actor: NativeActor, input: Input) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  let request: { asset: string; amount: string; destinationAsset: string; destination: string };
  let proposalId: string | null = null;
  if ('proposalId' in input) {
    proposalId = input.proposalId;
    const existing = await prisma.nativePayout.findFirst({
      where: { proposalId, ...scope(actor) },
    });
    if (existing) return payoutView(existing);
    const proposal = await prisma.accountProposal.findFirst({
      where: {
        id: proposalId,
        ...scope(actor),
        accountId: wallet.accountId,
        kind: 'refund',
        status: 'draft',
      },
    });
    if (!proposal?.refundId) throw conflict('Choose a pending refund proposal for this wallet');
    const action = ActionSchema.parse(proposal.action);
    if (!('refund' in action)) throw conflict('This proposal is not a refund');
    const refund = await prisma.refund.findFirst({
      where: {
        id: proposal.refundId,
        ...scope(actor),
        proposalId,
        status: 'pending',
        reviewReason: null,
        needsAddress: false,
      },
      include: { payment: true },
    });
    if (
      !refund ||
      refund.amount.toFixed(0) !== action.refund.amount ||
      refund.assetId !== action.refund.asset ||
      refund.destination !== action.refund.destination ||
      refund.destinationChain !== action.refund.destination_chain ||
      ((refund.payment.heldReason === 'sanctions' ||
        refund.payment.status === 'HELD' ||
        refund.reason === 'sanctions') &&
        !refund.acknowledgedLegalAt)
    ) {
      throw conflict('This refund needs review before it can be signed');
    }
    request = {
      asset: action.refund.asset,
      amount: action.refund.amount,
      destinationAsset: action.refund.asset,
      destination: action.refund.destination,
    };
  } else {
    request = input;
  }
  NativePayoutInput.parse(request);
  const [, destination] = await Promise.all([
    tokenInfo(true, request.asset),
    tokenInfo(true, request.destinationAsset),
  ]);
  if (!isValidAddress(destination.blockchain, request.destination))
    throw new AppError('VALIDATION_ERROR', 'Invalid destination address for this token chain', 400);
  // Refunds never reinterpret a NEAR wrapped-token address as an external-chain destination.
  if (proposalId) {
    const p = await prisma.accountProposal.findFirstOrThrow({
      where: { id: proposalId, ...scope(actor) },
    });
    const action = ActionSchema.parse(p.action);
    const aliases: Record<string, string> = {
      arbitrum: 'arb',
      optimism: 'op',
      polygon: 'pol',
      avalanche: 'avax',
    };
    if (
      !('refund' in action) ||
      (aliases[action.refund.destination_chain] ?? action.refund.destination_chain) !==
        destination.blockchain
    ) {
      throw conflict('This refund needs a supported destination token route');
    }
  }
  await screen(actor, request.destination, destination.blockchain);
  const balances = await nearClient(true).view<string[]>(
    env().INTENTS_CONTRACT_LIVE,
    'mt_batch_balance_of',
    { account_id: wallet.account.nearAccountId, token_ids: [request.asset] },
  );
  if (
    !Array.isArray(balances) ||
    !/^\d+$/.test(balances[0] ?? '') ||
    BigInt(balances[0]!) < BigInt(request.amount)
  ) {
    throw conflict('The wallet has insufficient available balance');
  }
  const provider = deps.provider();
  const quote = await provider.quote({
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: env().CHECKOUT_SLIPPAGE_BPS,
    originAsset: request.asset,
    depositType: 'INTENTS',
    destinationAsset: request.destinationAsset,
    amount: request.amount,
    refundTo: wallet.account.nearAccountId,
    refundType: 'INTENTS',
    recipient: request.destination,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  if (
    !quote.quote.depositAddress ||
    quote.quote.depositMemo ||
    quote.quote.amountIn !== request.amount ||
    !amount.safeParse(quote.quote.amountOut).success ||
    !amount.safeParse(quote.quote.minAmountOut).success ||
    BigInt(quote.quote.minAmountOut!) > BigInt(quote.quote.amountOut)
  ) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'The provider returned an unsupported payout quote',
      503,
    );
  }
  const payload = await provider.generateIntent(
    wallet.account.nearAccountId,
    quote.quote.depositAddress,
  );
  const expiresAt = validateTransferPayload(payload, {
    signerId: wallet.account.nearAccountId,
    contract: env().INTENTS_CONTRACT_LIVE,
    depositAddress: quote.quote.depositAddress,
    asset: request.asset,
    amount: request.amount,
  });
  const payout = await tenantTransaction(actor, async (tx) => {
    if (proposalId) {
      await tx.$queryRaw`SELECT id FROM account_proposals WHERE id = ${proposalId} AND merchant_id = ${actor.merchantId} AND livemode = ${actor.livemode} FOR UPDATE`;
      const p = await tx.accountProposal.findFirst({
        where: { id: proposalId, ...scope(actor), status: 'draft' },
      });
      if (!p) throw conflict('The refund proposal has changed');
      const old = await tx.nativePayout.findFirst({ where: { proposalId, ...scope(actor) } });
      if (old) return old;
    }
    const row = await tx.nativePayout.create({
      data: {
        id: newId('npay'),
        ...scope(actor),
        accountId: wallet.accountId,
        proposalId,
        ...request,
        destinationChain: destination.blockchain,
        depositAddress: quote.quote.depositAddress!,
        payload,
        quote: json(quote),
        expiresAt,
      },
    });
    await recordEvent(tx, actor, {
      aggregateType: 'native_payout',
      aggregateId: row.id,
      type: 'native_payout.created',
      payload: { amount: row.amount, asset: row.asset, destination: row.destination, proposalId },
    });
    return row;
  });
  return payoutView(payout);
}

export async function nativePayoutChallenge(actor: NativeActor, id: string) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  const p = await load(actor, id);
  if (
    p.accountId !== wallet.accountId ||
    p.status !== 'awaiting_signature' ||
    p.expiresAt <= new Date()
  )
    throw conflict('This payout is no longer awaiting a signature');
  return {
    ...payoutView(p),
    payload: p.payload,
    publicKey: wallet.publicKey,
    options: await nativeAuthenticationOptions(wallet, p.payload),
  };
}

export async function submitNativePayout(
  actor: NativeActor,
  id: string,
  response: AuthenticationResponseJSON,
) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  const p = await load(actor, id);
  if (p.accountId !== wallet.accountId) throw notFound('Payout not found');
  if (p.status !== 'awaiting_signature') return payoutView(p); // idempotent after acceptance, including unknown outcomes
  if (p.expiresAt <= new Date()) throw conflict('The payout quote has expired');
  const { signed, counter } = await verifyNativeAssertion(wallet, p.payload, response);
  await screen(actor, p.destination, p.destinationChain);
  validateTransferPayload(p.payload, {
    signerId: wallet.account.nearAccountId,
    contract: env().INTENTS_CONTRACT_LIVE,
    depositAddress: p.depositAddress,
    asset: p.asset,
    amount: p.amount,
  });
  await tenantTransaction(actor, async (tx) => {
    // Refund cancellation and approval serialize on the same proposal row.
    if (p.proposalId) {
      const locked = await tx.accountProposal.updateMany({
        where: { id: p.proposalId, ...scope(actor), status: 'draft' },
        data: { status: 'executing' },
      });
      if (locked.count !== 1) throw conflict('The refund proposal is no longer a draft');
    }
    const claimed = await tx.nativePayout.updateMany({
      where: { id, ...scope(actor), status: 'awaiting_signature', expiresAt: { gt: new Date() } },
      data: { status: 'submitting', signature: json(signed), claimedAt: null },
    });
    if (claimed.count !== 1) throw conflict('This payout was already submitted');
    await tx.nativeWallet.updateMany({
      where: { id: wallet.id, ...scope(actor), signCount: { lt: counter } },
      data: { signCount: counter },
    });
    await recordEvent(tx, actor, {
      aggregateType: 'native_payout',
      aggregateId: id,
      type: 'native_payout.authorized',
      payload: { ownerUserId: actor.userId },
    });
  });
  // Signed bytes are durable before any outward call. A timeout never creates a new nonce.
  await processNativePayout(id);
  return getNativePayout(actor, id);
}

async function finish(
  p: NativePayout,
  status: 'completed' | 'refunded' | 'failed',
  providerStatus: StatusResponse,
) {
  await tenantTransaction(p, async (tx) => {
    const changed = await tx.nativePayout.updateMany({
      where: { id: p.id, ...scope(p), status: { in: [...open] } },
      data: { status, providerStatus: json(providerStatus), claimedAt: null },
    });
    if (!changed.count) return;
    await recordEvent(tx, p, {
      aggregateType: 'native_payout',
      aggregateId: p.id,
      type: `native_payout.${status}`,
      payload: { intentHash: p.intentHash },
    });
    if (p.proposalId) {
      const txHash = providerStatus.swapDetails.destinationChainTxHashes[0]?.hash ?? null;
      await tx.accountProposal.updateMany({
        where: { id: p.proposalId, ...scope(p), status: 'executing' },
        data: {
          status: status === 'completed' ? 'executed' : 'failed',
          executedAt: status === 'completed' ? new Date() : null,
          lastTxHash: txHash,
          expirySettledAt: new Date(),
        },
      });
      await recordEvent(tx, p, {
        aggregateType: 'account_proposal',
        aggregateId: p.proposalId,
        type: status === 'completed' ? 'account.proposal.executed' : 'account.proposal.failed',
        payload: { proposalId: p.proposalId, txHash, reason: status, nativePayoutId: p.id },
      });
    }
  });
  await getRedis()
    .del(balancesCacheKey(p.merchantId, p.livemode))
    .catch(() => {});
}

/** Poll first, then safely retry the identical signed payload after an unknown submission. */
export async function processNativePayout(id: string) {
  const now = new Date();
  const claim = await prisma.nativePayout.updateMany({
    where: {
      id,
      status: { in: [...open] },
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - LEASE_MS) } }],
    },
    data: { claimedAt: now },
  });
  if (claim.count !== 1) return;
  const p = await prisma.nativePayout.findUniqueOrThrow({ where: { id } });
  try {
    const provider = deps.provider();
    const current = await provider.status(p.depositAddress);
    if (current.status === 'SUCCESS') {
      if (current.swapDetails.destinationChainTxHashes.length === 0) return; // keep polling until receipt available
      await finish(p, 'completed', current);
    } else if (current.status === 'FAILED' && p.signature && p.expiresAt > now) {
      // A signed transfer remains executable until its deadline. Do not release a refund for retry yet.
      await prisma.nativePayout.updateMany({
        where: { id, ...scope(p), status: { in: [...open] } },
        data: { providerStatus: json(current) },
      });
    } else if (current.status === 'REFUNDED' || current.status === 'FAILED') {
      await finish(p, current.status === 'REFUNDED' ? 'refunded' : 'failed', current);
    } else if (p.status === 'submitting' && p.signature && p.expiresAt > now) {
      const intentHash = await provider.submitIntent(p.signature as unknown as NativeSignedIntent);
      await prisma.nativePayout.updateMany({
        where: { id, ...scope(p), status: 'submitting' },
        data: {
          status: 'submitted',
          intentHash,
          submittedAt: new Date(),
          providerStatus: json(current),
        },
      });
    } else {
      await prisma.nativePayout.updateMany({
        where: { id, ...scope(p), status: { in: [...open] } },
        data: { providerStatus: json(current) },
      });
    }
  } catch (err) {
    // The provider may have accepted a timed-out request. Keep the durable signature and poll.
    log('warn', 'native payout awaiting provider reconciliation', {
      payoutId: id,
      error: err instanceof Error ? err.message : 'unknown',
    });
  } finally {
    await prisma.nativePayout.updateMany({
      where: { id, ...scope(p), claimedAt: now },
      data: { claimedAt: null },
    });
  }
}

export async function pollNativePayouts() {
  const rows = await prisma.nativePayout.findMany({
    where: { status: { in: [...open] } },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  for (const row of rows) await processNativePayout(row.id);
  return rows.length;
}
