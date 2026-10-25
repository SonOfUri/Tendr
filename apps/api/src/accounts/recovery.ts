// Recovery of a merchant account with the store's recovery kit (spec §3, R19).
//
// - Starting a recovery is authorised by the recovery KEY, not by an email or a session: the kit
//   signs `sha256(borsh(RecoveryPayload))` in the browser; the API checks that signature locally
//   against the stored recovery public key (`account_keys`, kind `recovery`, `ed25519:<b64>`)
//   before spending gas, then relays `start_recovery` with the kit's arguments unchanged. The
//   contract re-checks everything; signers have 72 h to cancel.
// - Cancelling is a signer's WebAuthn `cancel` approval over the recovery id from `get_recovery`.
// - Lost all passkeys: a person proves the kit to the API (an Ed25519 signature over a fresh,
//   namespaced, single-use, 5-minute server challenge) and gets a RESTRICTED session that can only
//   register a passkey for that person (a member of the store, named by email — the kit holder
//   vouches) and start a recovery of that store. Every other route refuses it (gateway).
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createDashboardSession, type NewSession } from '../auth/session.js';
import { CHALLENGE_TTL_MS } from '../auth/webauthn.js';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { nearClient } from '../near/client.js';
import type { ConfigView } from './accounts.js';
import { recoveryMessage, SignerSchema, type SignerJson } from './encoding.js';
import { parseAccountEvents } from './events.js';
import {
  assertedApproval,
  landed,
  rejected,
  relay,
  requireSigner,
  signerChallenge,
  withRelayTimeout,
  type ProposalActor,
} from './proposals.js';
import { afterAccountEvents, applyAccountEventsTx, type RecoveryView } from './watcher.js';

const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, 400, details);

const U64 = z.string().regex(/^(0|[1-9]\d{0,19})$/, 'must be a decimal u64 string');
const STD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const Sig64 = z
  .string()
  .refine((v) => STD_BASE64.test(v) && Buffer.from(v, 'base64').length === 64, {
    message: 'must be a 64-byte signature in standard padded base64',
  });

/** Which store's account: its slug or its NEAR account id, and the mode. */
export const AccountRefSchema = z
  .object({
    merchant: z.string().min(1).max(64).optional(),
    accountId: z.string().min(2).max(64).optional(),
    livemode: z.boolean(),
  })
  .refine((v) => (v.merchant === undefined) !== (v.accountId === undefined), {
    message: 'give exactly one of merchant (slug) or accountId',
  });

export const StartRecoverySchema = z
  .object({
    merchant: z.string().min(1).max(64).optional(),
    accountId: z.string().min(2).max(64).optional(),
    livemode: z.boolean(),
    newSigners: z.array(SignerSchema).min(1).max(20),
    newThreshold: z.number().int().min(1).max(255),
    nonce: U64,
    validUntil: U64,
    signature: Sig64,
  })
  .strict()
  .refine((v) => (v.merchant === undefined) !== (v.accountId === undefined), {
    message: 'give exactly one of merchant (slug) or accountId',
  });
export type StartRecoveryInput = z.infer<typeof StartRecoverySchema>;

/** The active account a kit request names (by slug or NEAR account id), or 404. */
export async function accountByRef(ref: {
  merchant?: string;
  accountId?: string;
  livemode: boolean;
}) {
  const account = ref.accountId
    ? await prisma.merchantAccount.findFirst({
        where: { nearAccountId: ref.accountId, livemode: ref.livemode },
      })
    : await prisma.merchantAccount.findFirst({
        where: { livemode: ref.livemode, merchant: { slug: ref.merchant } },
      });
  if (!account || account.status !== 'active') throw notFound('Account not found');
  return account;
}

/** The account's active recovery public key (32 raw bytes), or null. */
async function recoveryKeyOf(account: {
  merchantId: string;
  livemode: boolean;
  nearAccountId: string;
}): Promise<Uint8Array | null> {
  const row = await prisma.accountKey.findFirst({
    where: {
      merchantId: account.merchantId,
      livemode: account.livemode,
      nearAccountId: account.nearAccountId,
      kind: 'recovery',
      revokedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!row?.publicKey.startsWith('ed25519:')) return null;
  const bytes = Buffer.from(row.publicKey.slice('ed25519:'.length), 'base64');
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

function verifyEd25519(signatureB64: string, message: Uint8Array, key: Uint8Array): boolean {
  try {
    return ed25519.verify(new Uint8Array(Buffer.from(signatureB64, 'base64')), message, key);
  } catch {
    return false;
  }
}

/** A recovery request row as the API shows it. */
function recoveryJson(r: {
  id: string;
  onchainId: string | null;
  status: string;
  executesAt: Date;
  newSignerIds: string[];
  newThreshold: number | null;
  startTxHash: string | null;
  cancelTxHash: string | null;
  executeTxHash: string | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    onchainId: r.onchainId,
    status: r.status,
    executesAt: r.executesAt,
    newSignerIds: r.newSignerIds,
    newThreshold: r.newThreshold,
    startTxHash: r.startTxHash,
    cancelTxHash: r.cancelTxHash,
    executeTxHash: r.executeTxHash,
    createdAt: r.createdAt,
  };
}

/** The account's latest recovery in this mode (a pending one first), or null. */
export async function recoveryStatus(ctx: ScopeContext) {
  const rows = await prisma.recoveryRequest.findMany({
    where: { merchantId: ctx.merchantId, livemode: ctx.livemode },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const r = rows.find((x) => x.status === 'pending') ?? rows[0];
  return { recovery: r ? recoveryJson(r) : null };
}

/**
 * Starts a recovery with a payload the recovery kit signed. Checked locally first (no gas for a
 * bad request): the account is active and has a recovery key, the contract reports one is set,
 * and the signature verifies over `sha256(borsh(RecoveryPayload))` at the contract's current
 * recovery-key epoch. Then `start_recovery` is relayed with exactly the kit's arguments.
 */
export async function startRecovery(input: StartRecoveryInput) {
  const account = await accountByRef(input);
  const key = await recoveryKeyOf(account);
  if (!key) throw conflict('This account has no recovery key');
  const client = nearClient(account.livemode);
  const config = await client.view<ConfigView>(account.nearAccountId, 'get_config', {});
  if (!config.recovery_key_set) throw conflict('This account has no recovery key');
  const message = recoveryMessage({
    contractId: account.nearAccountId,
    newSigners: input.newSigners as SignerJson[],
    newThreshold: input.newThreshold,
    nonce: BigInt(input.nonce),
    recoveryKeyEpoch: BigInt(config.recovery_key_epoch),
    validUntil: BigInt(input.validUntil),
  });
  if (!verifyEd25519(input.signature, message, key)) {
    throw invalid('The recovery signature does not verify for this account');
  }
  const result = await withRelayTimeout(
    relay(account.livemode, account.nearAccountId, 'start_recovery', {
      new_signers: input.newSigners,
      new_threshold: input.newThreshold,
      nonce: input.nonce,
      valid_until: input.validUntil,
      signature: input.signature,
    }),
  );
  if (!landed(result)) {
    log('info', 'start_recovery rejected on chain', {
      accountId: account.id,
      failure: result.failure,
    });
    throw rejected(result);
  }
  const ctx = { merchantId: account.merchantId, livemode: account.livemode };
  const events = parseAccountEvents(result.successLogs);
  const outcome = await tenantTransaction(ctx, (tx, c) =>
    applyAccountEventsTx(tx, c, account, events, result.txHash),
  );
  await afterAccountEvents(account, outcome);
  return { txHash: result.txHash, ...(await recoveryStatus(ctx)) };
}

async function activeAccount(ctx: ScopeContext) {
  const account = await prisma.merchantAccount.findFirst({
    where: { merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (!account || account.status !== 'active') throw conflict('The account is not ready yet');
  return account;
}

async function pendingOnChain(account: { livemode: boolean; nearAccountId: string }) {
  const r = await nearClient(account.livemode).view<RecoveryView | null>(
    account.nearAccountId,
    'get_recovery',
    {},
  );
  if (!r) throw conflict('No recovery is pending');
  return r;
}

/** The WebAuthn request a signer signs to cancel the pending recovery (its on-chain id). */
export async function recoveryCancelChallenge(actor: ProposalActor) {
  requireSigner(actor);
  const account = await activeAccount(actor);
  const r = await pendingOnChain(account);
  return {
    recoveryId: r.recovery_id,
    ...(await signerChallenge(actor, account, r.recovery_id, 'cancel')),
  };
}

/**
 * Cancels the pending recovery: a signer's `cancel` approval over the recovery id from
 * `get_recovery`, verified locally, then relayed to `cancel_recovery`.
 */
export async function cancelRecovery(actor: ProposalActor, response: unknown) {
  requireSigner(actor);
  const account = await activeAccount(actor);
  const r = await pendingOnChain(account);
  const approval = await assertedApproval(actor, account, r.recovery_id, 'cancel', response);
  const result = await withRelayTimeout(
    relay(actor.livemode, account.nearAccountId, 'cancel_recovery', { approval }),
  );
  if (!landed(result)) throw rejected(result);
  const events = parseAccountEvents(result.successLogs);
  const outcome = await tenantTransaction(actor, async (tx, c) => {
    // The contract names no recovery id in `recovery_cancelled`; this one is the id it cancelled.
    const named = events.map((e) =>
      e.event === 'recovery_cancelled'
        ? { ...e, data: { ...e.data, recovery_id: r.recovery_id } }
        : e,
    );
    return applyAccountEventsTx(tx, c, account, named, result.txHash);
  });
  await afterAccountEvents(account, outcome);
  return { txHash: result.txHash, ...(await recoveryStatus(actor)) };
}

// ─── lost all passkeys: the restricted recovery session ──────────────────────

/** Namespace of the message a kit signs to open a recovery session. */
export const RECOVERY_SESSION_DOMAIN = 'tendr-recovery-session-v1';

/**
 * The exact bytes the recovery kit signs (Ed25519) to open a session: an ASCII line naming the
 * domain, the account, the person's email and the server's random challenge. Never a 32-byte hash,
 * so it can never double as a recovery payload or an approval.
 */
export function recoverySessionMessage(nearAccountId: string, email: string, challenge: string) {
  return new TextEncoder().encode(
    `${RECOVERY_SESSION_DOMAIN}:${nearAccountId}:${email}:${challenge}`,
  );
}

const lower = (e: string) => e.trim().toLowerCase();

/**
 * A fresh single-use challenge (5 minutes) for opening a recovery session on `merchant`'s LIVE
 * account for the member `email`. Answers the same whether or not the email is a member (no
 * enumeration); verification fails for a non-member.
 */
export async function recoverySessionOptions(input: { merchant: string; email: string }) {
  const account = await accountByRef({ merchant: input.merchant, livemode: true });
  const email = lower(input.email);
  const challenge = randomBytes(32).toString('base64url');
  const message = recoverySessionMessage(account.nearAccountId, email, challenge);
  await prisma.webauthnChallenge.create({
    data: {
      id: newId('wch'),
      purpose: 'recovery_session',
      challengeHash: sha256(Buffer.from(message).toString('utf8')),
      userId: null,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
  return {
    challenge,
    accountId: account.nearAccountId,
    message: Buffer.from(message).toString('utf8'),
    expiresInSeconds: CHALLENGE_TTL_MS / 1000,
  };
}

/**
 * Opens a restricted recovery session: consumes the challenge (single use), checks the kit's
 * signature against the account's recovery key, and binds the session to the store member with
 * that email. Any failure is the same 401.
 */
export async function verifyRecoverySession(input: {
  merchant: string;
  email: string;
  challenge: string;
  signature: string;
}): Promise<{ session: NewSession; userId: string; merchantId: string }> {
  const fail = () => unauthorized('The recovery kit could not be verified');
  const account = await accountByRef({ merchant: input.merchant, livemode: true });
  const email = lower(input.email);
  const message = recoverySessionMessage(account.nearAccountId, email, input.challenge);
  const now = new Date();
  const { count } = await prisma.webauthnChallenge.updateMany({
    where: {
      challengeHash: sha256(Buffer.from(message).toString('utf8')),
      purpose: 'recovery_session',
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (count !== 1) throw fail();
  const key = await recoveryKeyOf(account);
  if (!key || !Sig64.safeParse(input.signature).success) throw fail();
  if (!verifyEd25519(input.signature, message, key)) throw fail();
  const member = await prisma.merchantUser.findFirst({
    where: { merchantId: account.merchantId, user: { email } },
    select: { userId: true },
  });
  if (!member) throw fail();
  const session = await createDashboardSession(member.userId, {
    recoveryMerchantId: account.merchantId,
  });
  log('info', 'recovery session opened', {
    merchantId: account.merchantId,
    userId: member.userId,
  });
  return { session, userId: member.userId, merchantId: account.merchantId };
}
