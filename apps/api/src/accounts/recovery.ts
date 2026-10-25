// Recovery of a merchant account with the store's recovery kit (spec §3, R19).
//
// - Starting a recovery is authorised by the recovery KEY, not by an email or a session: the kit
//   signs `sha256(borsh(RecoveryPayload))` in the browser; the API checks that signature locally
//   against the stored recovery public key (`account_keys`, kind `recovery`, `ed25519:<b64>`)
//   before spending gas, then relays `start_recovery` with the kit's arguments unchanged. The
//   contract re-checks everything; signers have 72 h to cancel.
// - Cancelling is a signer's WebAuthn `cancel` approval over the recovery id from `get_recovery`.
// - Lost all passkeys (R19, R28): a person with NO active passkey proves the kit to the API (an
//   Ed25519 signature over a fresh, namespaced, single-use, 5-minute server challenge) and gets a
//   RESTRICTED session; registering a passkey through it also needs a single-use link mailed to
//   that person (kit AND mailbox). The person and every signer are notified. Every other route
//   refuses the session (gateway), which also re-checks the person's membership on every use.
import { ed25519 } from '@noble/curves/ed25519';
import type { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MAGIC_LINK_TTL_MS, newLinkToken } from '../auth/magic-link.js';
import { getMailer } from '../auth/mailer.js';
import { createDashboardSession, type NewSession } from '../auth/session.js';
import { CHALLENGE_TTL_MS } from '../auth/webauthn.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
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
import {
  AccountEventTypes,
  afterAccountEvents,
  applyAccountEventsTx,
  type RecoveryView,
} from './watcher.js';

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
export async function startRecovery(
  input: StartRecoveryInput,
  hooks: {
    /** Runs once the kit signature verified, before the relay (the per-account rate limit). */
    onVerified?: (accountId: string) => Promise<void>;
  } = {},
) {
  const account = await accountByRef(input);
  const key = await recoveryKeyOf(account);
  if (!key) throw conflict('This account has no recovery key');
  const messageAt = (recoveryKeyEpoch: bigint) =>
    recoveryMessage({
      contractId: account.nearAccountId,
      newSigners: input.newSigners as SignerJson[],
      newThreshold: input.newThreshold,
      nonce: BigInt(input.nonce),
      recoveryKeyEpoch,
      validUntil: BigInt(input.validUntil),
    });
  // The mirrored recovery-key epoch first (no RPC for junk requests); the contract's own when
  // there is no mirror yet or the mirror may be stale.
  let verified =
    account.recoveryKeyEpoch !== null &&
    verifyEd25519(input.signature, messageAt(account.recoveryKeyEpoch), key);
  if (!verified) {
    const config = await nearClient(account.livemode).view<ConfigView>(
      account.nearAccountId,
      'get_config',
      {},
    );
    if (!config.recovery_key_set) throw conflict('This account has no recovery key');
    const chainEpoch = BigInt(config.recovery_key_epoch);
    verified =
      chainEpoch !== account.recoveryKeyEpoch &&
      verifyEd25519(input.signature, messageAt(chainEpoch), key);
  }
  if (!verified) throw invalid('The recovery signature does not verify for this account');
  await hooks.onVerified?.(account.id);
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

/**
 * The inputs of a recovery payload the browser cannot know: the account contract id, the
 * contract's current recovery-key epoch, and the last recovery nonce used under it. Read from the
 * contract (not the mirror), since a stale epoch or nonce makes the kit's signature useless.
 */
export async function recoveryParams(ctx: ScopeContext) {
  const account = await activeAccount(ctx);
  const client = nearClient(account.livemode);
  const [config, lastNonce] = await Promise.all([
    client.view<ConfigView>(account.nearAccountId, 'get_config', {}),
    client.view<string>(account.nearAccountId, 'get_recovery_nonce', {}),
  ]);
  return {
    accountId: account.nearAccountId,
    livemode: account.livemode,
    recoveryKeySet: config.recovery_key_set,
    recoveryKeyEpoch: String(config.recovery_key_epoch),
    lastNonce: String(lastNonce),
  };
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

// ─── lost all passkeys: the restricted recovery session (R19, R28) ──────────
//
// Kit AND mailbox: the kit opens a restricted session for a store member who has NO active
// passkey (checked under a lock on the person's row at options and at verify); opening it mails
// that person a single-use `recovery_register` link (15 minutes), and registering a passkey needs
// both the kit session and that link. The person and every current signer of the store are told
// when such a session opens and when a passkey is registered through it. The session re-checks
// the person's membership of the store on every use (gateway).

/** Namespace of the message a kit signs to open a recovery session. */
export const RECOVERY_SESSION_DOMAIN = 'tendr-recovery-session-v1';
/** How long the mailbox link of a recovery registration lives. */
export const RECOVERY_REGISTER_TTL_MS = MAGIC_LINK_TTL_MS;

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
 * The member of `merchantId` with `email` if they may be recovered: a member of the store with
 * ZERO active passkeys. Locks the person's `users` row (`FOR UPDATE`), so a passkey registered
 * concurrently is seen.
 */
async function recoverableMember(
  tx: Prisma.TransactionClient,
  merchantId: string,
  email: string,
): Promise<string | null> {
  const [person] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${email} FOR UPDATE`;
  if (!person) return null;
  const member = await tx.merchantUser.findFirst({
    where: { merchantId, userId: person.id },
    select: { id: true },
  });
  if (!member) return null;
  const active = await tx.webauthnCredential.count({
    where: { userId: person.id, revokedAt: null },
  });
  return active === 0 ? person.id : null;
}

/**
 * A fresh single-use challenge (5 minutes) for opening a recovery session on `merchant`'s LIVE
 * account for the member `email`. Answers the same whether or not the email names a recoverable
 * member (no enumeration); for anyone else the challenge can never verify.
 */
export async function recoverySessionOptions(input: { merchant: string; email: string }) {
  const account = await accountByRef({ merchant: input.merchant, livemode: true });
  const email = lower(input.email);
  const challenge = randomBytes(32).toString('base64url');
  const message = recoverySessionMessage(account.nearAccountId, email, challenge);
  await prisma.$transaction(async (tx) => {
    const userId = await recoverableMember(tx, account.merchantId, email);
    await tx.webauthnChallenge.create({
      data: {
        id: newId('wch'),
        purpose: 'recovery_session',
        challengeHash: sha256(Buffer.from(message).toString('utf8')),
        userId,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
  });
  return {
    challenge,
    accountId: account.nearAccountId,
    message: Buffer.from(message).toString('utf8'),
    expiresInSeconds: CHALLENGE_TTL_MS / 1000,
  };
}

/**
 * Opens a restricted recovery session: consumes the challenge (single use, even when the rest
 * fails), checks the kit's signature against the account's recovery key, re-checks under a lock
 * that the person is still a member with no active passkey, creates the session, mails the person
 * the `recovery_register` link, and records `account.recovery_session.opened` (which notifies the
 * person and every signer). Any failure is the same 401.
 */
export async function verifyRecoverySession(
  input: { merchant: string; email: string; challenge: string; signature: string },
  hooks: {
    /** Runs once the kit signature verified (the per-merchant rate limit). */
    onKitVerified?: (merchantId: string) => Promise<void>;
  } = {},
): Promise<{ session: NewSession; userId: string; merchantId: string }> {
  const fail = () => unauthorized('The recovery kit could not be verified');
  const account = await accountByRef({ merchant: input.merchant, livemode: true });
  const email = lower(input.email);
  const message = recoverySessionMessage(account.nearAccountId, email, input.challenge);
  const now = new Date();
  const row = await prisma.webauthnChallenge.findFirst({
    where: {
      challengeHash: sha256(Buffer.from(message).toString('utf8')),
      purpose: 'recovery_session',
      consumedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (!row) throw fail();
  const { count } = await prisma.webauthnChallenge.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (count !== 1 || !row.userId) throw fail();
  const key = await recoveryKeyOf(account);
  if (!key || !Sig64.safeParse(input.signature).success) throw fail();
  if (!verifyEd25519(input.signature, message, key)) throw fail();
  await hooks.onKitVerified?.(account.merchantId);

  const ctx = { merchantId: account.merchantId, livemode: true };
  const link = newLinkToken();
  const { session, userId } = await tenantTransaction(ctx, async (tx) => {
    const target = await recoverableMember(tx, account.merchantId, email);
    if (!target || target !== row.userId) throw fail();
    const session = await createDashboardSession(target, {
      recoveryMerchantId: account.merchantId,
      db: tx,
    });
    await tx.emailToken.create({
      data: {
        id: newId('etok'),
        email,
        purpose: 'recovery_register',
        tokenHash: link.hash,
        expiresAt: new Date(Date.now() + RECOVERY_REGISTER_TTL_MS),
      },
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'user',
      aggregateId: target,
      type: AccountEventTypes.recoverySessionOpened,
      payload: { userId: target, email, sessionId: session.sessionId },
    });
    return { session, userId: target };
  });
  const url = new URL('/recover/passkey', env().WEB_URL);
  url.searchParams.set('token', link.raw);
  await getMailer().send({
    to: email,
    template: 'recovery_register_link',
    data: { url: url.toString(), store: input.merchant },
  });
  log('info', 'recovery session opened', { merchantId: account.merchantId, userId });
  return { session, userId, merchantId: account.merchantId };
}

/**
 * Checks (or, with `consume`, uses up) the person's `recovery_register` mailbox link: unexpired,
 * unused, and sent to this person's email. Returns whether it holds.
 */
export async function recoveryRegisterToken(
  userId: string,
  token: string | undefined,
  opts: { consume: boolean },
): Promise<boolean> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return false;
  const where = {
    tokenHash: sha256(token),
    purpose: 'recovery_register' as const,
    email: user.email,
    consumedAt: null,
    expiresAt: { gt: new Date() },
  };
  if (!opts.consume) return (await prisma.emailToken.count({ where })) === 1;
  const { count } = await prisma.emailToken.updateMany({
    where,
    data: { consumedAt: new Date() },
  });
  return count === 1;
}

/** Records `account.recovery_session.passkey_registered` (notifies the person and the signers). */
export async function recordRecoveryPasskey(
  merchantId: string,
  userId: string,
  credentialRowId: string,
): Promise<void> {
  const ctx = { merchantId, livemode: true };
  await tenantTransaction(ctx, (tx) =>
    recordEvent(tx, ctx, {
      aggregateType: 'user',
      aggregateId: userId,
      type: AccountEventTypes.recoveryPasskeyRegistered,
      payload: { userId, credentialId: credentialRowId },
    }),
  );
}
