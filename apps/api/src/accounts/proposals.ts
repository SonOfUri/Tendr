// Proposals on a merchant's account contract: drafts, approval challenges, relayed approvals and
// cancels, and the fast local checks that mirror the contract's.
//
// Flow (spec §1 "Proposals start with a signer", §4 "Money out"):
// - Anyone with the right permission drafts a proposal. A draft lives only in Postgres; nothing
//   touches NEAR until a signer approves it.
// - A signer asks for the challenge — `sha256(borsh(ApprovalPayload))` for this account contract,
//   the proposal id, the MIRRORED signer epoch and the intent — signs it with a passkey, and posts
//   the WebAuthn response. The first approval relays `propose(action, salt, approval)`; later ones
//   relay `approve(proposal_id, approval)`. `cancel(proposal_id, approval)` takes a `cancel` intent.
// - The relayer (`relayer-accounts`) only pays gas. The contract re-verifies everything.
//
// Credentials are looked up by (the signer's person id, the credential id the response names),
// never by public key alone, and only among the person's non-revoked passkeys. The on-chain signer
// id is the person id (`per_…`).
//
// Outcomes are read from the transaction's top-level status and the contract's own NEP-297 events
// in its logs (`applyProposalEvents`), not from `TxResult.status`: that is `'failure'` whenever ANY
// receipt failed, including a downstream verifier transfer the contract settles in a callback.
import type { AccountProposal, Prisma, WebauthnCredential } from '@prisma/client';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  isSecurityKind,
  SignerKeySchema,
  type MerchantPermission,
  type ProposalKind,
  type ProposalStatus,
  type SignerKey,
} from '@tendr/contracts';
import { randomBytes } from 'node:crypto';
import { activeCredentials, recordSignCount, signerKeyToCose } from '../auth/webauthn.js';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { nearClient, type TxResult } from '../near/client.js';
import { RELAY_GAS } from '../near/tx.js';
import {
  AccountIdSchema,
  ActionSchema,
  challengeB64u,
  kindOf,
  normalizeP256Signature,
  proposalId as computeProposalId,
  type ActionJson,
  type ActionOf,
  type ApprovalIntent,
} from './encoding.js';
import { nsToDate, parseAccountEvents, u64Of, type AccountEvent } from './events.js';

/** The caller: a person acting in one store and mode (a `dashboard_user` principal). */
export interface ProposalActor extends ScopeContext {
  userId: string;
  isSigner: boolean;
  permissions: readonly MerchantPermission[];
}

/** Contract limits mirrored for fast 4xx (onchain/merchant-account/src/{action,saved}.rs). */
const MAX_SIGNERS = 20;
const MAX_KEYS_PER_SIGNER = 10;
const MAX_ORIGINS = 10;
const MAX_ORIGIN_LEN = 256;
const MAX_ID_LEN = 64;
const MAX_CHAIN_LEN = 16;
const MAX_ADDRESS_LEN = 128;
const MAX_ASSET_LEN = 128;
export const SUPPORTED_CHAINS: readonly string[] = [
  'near',
  'eth',
  'base',
  'arbitrum',
  'polygon',
  'bsc',
  'optimism',
  'avalanche',
  'sol',
  'tron',
  'btc',
];
const SIGNER_ID = /^per_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** How far back the stale-epoch check looks before calling an assertion simply wrong. */
const STALE_EPOCH_LOOKBACK = 64n;

/** Kinds that move money or name where it goes: refunds, withdrawals, saved addresses. */
const MONEY_KINDS: ReadonlySet<ProposalKind> = new Set([
  'withdraw',
  'refund',
  'add_saved_address',
  'remove_saved_address',
]);
/** Kinds whose execution starts a transfer or deployment that settles in a callback. */
const ASYNC_KINDS: ReadonlySet<ProposalKind> = new Set(['withdraw', 'refund', 'upgrade']);

/**
 * The permission needed to draft `kind` (spec §2):
 * - signers, keys, threshold, origins, recovery key, and contract upgrades → `security:propose`
 *   (owner); an upgrade swaps the code that guards the funds;
 * - withdrawals, refunds, saved addresses → `money:request` (finance and up);
 * - limits, refund cap, auto-sweep, settlement → `settings:manage` (admin and up).
 */
export function draftPermission(kind: ProposalKind): MerchantPermission {
  if (isSecurityKind(kind) || kind === 'upgrade') return 'security:propose';
  if (MONEY_KINDS.has(kind)) return 'money:request';
  return 'settings:manage';
}

const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, 400, details);

// ─── public view ─────────────────────────────────────────────────────────────

type ProposalWithApprovals = AccountProposal & {
  approvals: {
    userId: string;
    credentialId: string;
    signerEpoch: bigint;
    txHash: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[];
};

export type ProposalView = ReturnType<typeof view>;

function view(p: ProposalWithApprovals) {
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    onchainId: p.onchainId,
    action: p.action as ActionJson,
    salt: p.salt,
    createdByUserId: p.createdByUserId,
    readyAt: p.readyAt,
    executedAt: p.executedAt,
    lastTxHash: p.lastTxHash,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    approvals: p.approvals.map((a) => ({
      userId: a.userId,
      credentialId: a.credentialId,
      signerEpoch: a.signerEpoch.toString(),
      txHash: a.txHash,
      approvedAt: a.updatedAt,
    })),
  };
}

const withApprovals = { approvals: { orderBy: { createdAt: 'asc' as const } } };

async function loadProposal(ctx: ScopeContext, id: string): Promise<ProposalWithApprovals> {
  const p = await prisma.accountProposal.findFirst({
    where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode },
    include: withApprovals,
  });
  if (!p) throw notFound('Proposal not found');
  return p;
}

/** The store's account contract in this mode; 409 until it is provisioned and active. */
async function activeAccount(ctx: ScopeContext) {
  const account = await prisma.merchantAccount.findFirst({
    where: { merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (!account || account.status !== 'active') {
    throw conflict('The account is not ready yet');
  }
  return account;
}

export async function getProposal(ctx: ScopeContext, id: string): Promise<ProposalView> {
  return view(await loadProposal(ctx, id));
}

export async function listProposals(
  ctx: ScopeContext,
  filter: { status?: ProposalStatus } = {},
): Promise<ProposalView[]> {
  const rows = await prisma.accountProposal.findMany({
    where: {
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: withApprovals,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return rows.map(view);
}

// ─── drafts ──────────────────────────────────────────────────────────────────

/**
 * Creates a draft. Only Postgres is touched: the proposal reaches the chain when a signer first
 * approves it. The salt is 32 random bytes, so the same action can be proposed twice.
 */
export async function createDraft(
  actor: ProposalActor,
  input: { kind?: ProposalKind; action: unknown },
): Promise<ProposalView> {
  const action = ActionSchema.parse(input.action);
  const kind = kindOf(action);
  if (input.kind && input.kind !== kind) {
    throw invalid(`kind ${input.kind} does not match the action (${kind})`);
  }
  const permission = draftPermission(kind);
  if (!actor.permissions.includes(permission)) {
    throw forbidden(`Missing permission ${permission}`);
  }
  const account = await activeAccount(actor);
  await validateLocally(actor, action);
  const salt = randomBytes(32);
  const created = await tenantTransaction(actor, (tx, ctx) =>
    tx.accountProposal.create({
      data: {
        id: newId('prop'),
        merchantId: ctx.merchantId,
        livemode: ctx.livemode,
        accountId: account.id,
        onchainId: computeProposalId(action, salt),
        kind,
        action: action as Prisma.InputJsonValue,
        salt: salt.toString('base64'),
        status: 'draft',
        createdByUserId: actor.userId,
      },
      include: withApprovals,
    }),
  );
  return view(created);
}

// ─── local validation ────────────────────────────────────────────────────────

function bounded(s: string, max: number, what: string): void {
  if (s.length === 0 || Buffer.byteLength(s, 'utf8') > max) {
    throw invalid(`${what} must be 1 to ${max} characters`);
  }
}

function boundsOf(action: ActionJson): void {
  const a = action as Record<string, Record<string, unknown>>;
  const kind = kindOf(action);
  const v = a[kind] as Record<string, unknown>;
  const str = (k: string) => v[k] as string;
  switch (kind) {
    case 'add_signer':
      bounded(str('id'), MAX_ID_LEN, 'id');
      break;
    case 'remove_signer':
    case 'add_signer_key':
    case 'remove_signer_key':
    case 'remove_saved_address':
      bounded(str('id'), MAX_ID_LEN, 'id');
      break;
    case 'add_saved_address':
      bounded(str('id'), MAX_ID_LEN, 'id');
      bounded(str('chain'), MAX_CHAIN_LEN, 'chain');
      bounded(str('address'), MAX_ADDRESS_LEN, 'address');
      break;
    case 'set_limits':
    case 'set_refund_cap':
    case 'clear_auto_sweep':
      bounded(str('asset'), MAX_ASSET_LEN, 'asset');
      break;
    case 'set_auto_sweep':
    case 'withdraw':
      bounded(str('asset'), MAX_ASSET_LEN, 'asset');
      bounded(str('saved_address_id'), MAX_ID_LEN, 'saved_address_id');
      break;
    case 'refund':
      bounded(str('asset'), MAX_ASSET_LEN, 'asset');
      bounded(str('destination_chain'), MAX_CHAIN_LEN, 'destination_chain');
      bounded(str('destination'), MAX_ADDRESS_LEN, 'destination');
      bounded(str('payment_id'), MAX_ID_LEN, 'payment_id');
      break;
    case 'set_settlement':
      bounded(str('dest_asset'), MAX_ASSET_LEN, 'dest_asset');
      if (v.saved_address_id !== null) {
        bounded(str('saved_address_id'), MAX_ID_LEN, 'saved_address_id');
      }
      break;
    default:
      break;
  }
}

function validateOrigins(origins: string[]): void {
  if (origins.length === 0 || origins.length > MAX_ORIGINS) {
    throw invalid('origins must list 1 to 10 entries');
  }
  origins.forEach((o, i) => {
    const host = o.startsWith('https://') ? o.slice(8) : o.startsWith('http://') ? o.slice(7) : '';
    if (!host || o.length > MAX_ORIGIN_LEN || host.includes('/') || /[\s\p{Cc}]/u.test(o)) {
      throw invalid(`invalid origin ${o}`);
    }
    if (origins.indexOf(o) !== i) throw invalid(`duplicate origin ${o}`);
  });
}

const keyId = (k: SignerKey) => ('p256' in k ? `p256:${k.p256}` : `ed25519:${k.ed25519}`);

/** The store's current signers (the `merchant_users.is_signer` mirror). */
async function signerMemberships(ctx: ScopeContext) {
  return prisma.merchantUser.findMany({
    where: { merchantId: ctx.merchantId, isSigner: true },
    select: { userId: true },
  });
}

/** Checks `keys` are active passkeys of `personId` (R1: a key maps to its owner's credential). */
async function assertOwnKeys(personId: string, keys: SignerKey[]): Promise<void> {
  const own = new Set(
    (await activeCredentials(personId)).map((c) =>
      keyId(SignerKeySchema.parse(c.publicKey) as SignerKey),
    ),
  );
  for (const k of keys) {
    if (!own.has(keyId(k))) throw invalid("A signer key must be one of that person's passkeys");
  }
}

/** A saved address (the `payout_allowlist` mirror) usable for funds now; 400 otherwise. */
async function usableSavedAddress(ctx: ScopeContext, id: string, now: Date) {
  const entry = await prisma.payoutAllowlistEntry.findFirst({
    where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (!entry || entry.status === 'revoked' || entry.activeFrom > now) {
    throw invalid('saved address is unknown or not yet active');
  }
  return entry;
}

function positive(amount: string, what = 'amount'): void {
  if (BigInt(amount) === 0n) throw invalid(`${what} must be positive`);
}

/**
 * Mirrors the contract's checks against what Postgres knows, for a fast 4xx before any gas is
 * spent: field bounds, signer ids and keys, threshold vs. signer count, origins, supported chains,
 * saved addresses (`payout_allowlist`: id = the on-chain saved-address id, usable from
 * `active_from`, never once revoked) and settlement modes. Limits and refund caps live only in
 * contract state until they are mirrored, so they are left to the contract. The contract stays
 * the authority: passing here never means the chain will accept.
 */
export async function validateLocally(ctx: ScopeContext, action: ActionJson): Promise<void> {
  boundsOf(action);
  const now = new Date();
  const kind = kindOf(action);
  const a = action as Record<string, unknown>;
  switch (kind) {
    case 'add_signer': {
      const s = a.add_signer as ActionOf<'add_signer'>;
      if (!SIGNER_ID.test(s.id)) throw invalid('signer id must be per_ followed by a ULID');
      if (s.keys.length === 0) throw invalid('signer needs at least one key');
      if (s.keys.length > MAX_KEYS_PER_SIGNER) throw invalid('too many keys for one signer');
      if (new Set(s.keys.map(keyId)).size !== s.keys.length) throw invalid('duplicate key');
      const membership = await prisma.merchantUser.findFirst({
        where: { merchantId: ctx.merchantId, userId: s.id },
      });
      if (!membership) throw invalid('A signer must be a member of this store');
      if (membership.role === 'viewer') throw invalid('A viewer cannot be a signer');
      if (membership.isSigner) throw invalid('duplicate signer');
      if ((await signerMemberships(ctx)).length >= MAX_SIGNERS) throw invalid('too many signers');
      await assertOwnKeys(s.id, s.keys as SignerKey[]);
      return;
    }
    case 'remove_signer': {
      const { id } = a.remove_signer as ActionOf<'remove_signer'>;
      const signers = await signerMemberships(ctx);
      if (!signers.some((s) => s.userId === id)) throw invalid('unknown signer');
      const account = await activeAccount(ctx);
      if (account.threshold > signers.length - 1) {
        throw invalid('threshold must be between 1 and the number of signers');
      }
      return;
    }
    case 'add_signer_key':
    case 'remove_signer_key': {
      const { id, key } = a[kind] as ActionOf<'add_signer_key'>;
      const signers = await signerMemberships(ctx);
      if (!signers.some((s) => s.userId === id)) throw invalid('unknown signer');
      if (kind === 'add_signer_key') await assertOwnKeys(id, [key as SignerKey]);
      return;
    }
    case 'set_threshold': {
      const t = a.set_threshold as number;
      const n = (await signerMemberships(ctx)).length;
      if (t < 1 || t > n) throw invalid('threshold must be between 1 and the number of signers');
      return;
    }
    case 'set_origins':
      validateOrigins(a.set_origins as string[]);
      return;
    case 'rotate_recovery_key':
    case 'upgrade':
      return;
    case 'add_saved_address': {
      const v = a.add_saved_address as ActionOf<'add_saved_address'>;
      if (!SUPPORTED_CHAINS.includes(v.chain)) throw invalid('unsupported chain');
      if (v.chain === 'near' && !AccountIdSchema.safeParse(v.address).success) {
        throw invalid('near destination must be a valid NEAR account id');
      }
      const clash = await prisma.payoutAllowlistEntry.findFirst({
        where: {
          merchantId: ctx.merchantId,
          livemode: ctx.livemode,
          OR: [{ id: v.id }, { chain: v.chain, address: v.address, status: { not: 'revoked' } }],
        },
      });
      if (clash?.id === v.id) throw invalid('saved address id was used before');
      if (clash) throw invalid('duplicate saved address');
      return;
    }
    case 'remove_saved_address': {
      const { id } = a.remove_saved_address as ActionOf<'remove_saved_address'>;
      const entry = await prisma.payoutAllowlistEntry.findFirst({
        where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode },
      });
      if (!entry || entry.status === 'revoked') throw invalid('unknown saved address');
      return;
    }
    case 'withdraw': {
      const v = a.withdraw as ActionOf<'withdraw'>;
      positive(v.amount);
      await usableSavedAddress(ctx, v.saved_address_id, now);
      return;
    }
    case 'refund': {
      const v = a.refund as ActionOf<'refund'>;
      positive(v.amount);
      if (!SUPPORTED_CHAINS.includes(v.destination_chain)) throw invalid('unsupported chain');
      return;
    }
    case 'set_auto_sweep': {
      const v = a.set_auto_sweep as ActionOf<'set_auto_sweep'>;
      if (BigInt(v.keep) > BigInt(v.trigger_above)) {
        throw invalid('keep must not exceed trigger_above');
      }
      const entry = await prisma.payoutAllowlistEntry.findFirst({
        where: { id: v.saved_address_id, merchantId: ctx.merchantId, livemode: ctx.livemode },
      });
      if (!entry || entry.status === 'revoked') throw invalid('unknown saved address');
      return;
    }
    case 'set_settlement': {
      const v = a.set_settlement as ActionOf<'set_settlement'>;
      if (v.payout_mode === 'intents' && v.saved_address_id !== null) {
        throw invalid('intents settlement takes no saved address');
      }
      if (v.payout_mode === 'wallet') {
        if (v.saved_address_id === null) throw invalid('wallet settlement needs a saved address');
        await usableSavedAddress(ctx, v.saved_address_id, now);
      }
      return;
    }
    case 'set_limits':
    case 'set_refund_cap':
    case 'clear_auto_sweep':
      return;
  }
}

// ─── signer checks and challenges ────────────────────────────────────────────

function requireSigner(actor: ProposalActor): void {
  if (!actor.isSigner) throw forbidden('Only signers can approve or cancel proposals');
}

const OPEN: ReadonlySet<ProposalStatus> = new Set(['draft', 'pending', 'timelocked']);
const ON_CHAIN_OPEN: ReadonlySet<ProposalStatus> = new Set(['pending', 'timelocked']);

function assertCanSign(p: AccountProposal, intent: ApprovalIntent): void {
  const ok = intent === 'approve' ? OPEN.has(p.status) : ON_CHAIN_OPEN.has(p.status);
  if (!ok) throw conflict(`A ${p.status} proposal cannot take a ${intent}`);
}

function assertNotApprovedAtEpoch(p: ProposalWithApprovals, userId: string, epoch: bigint): void {
  if (p.approvals.some((a) => a.userId === userId && a.signerEpoch === epoch)) {
    throw conflict('You already approved this proposal');
  }
}

/**
 * The WebAuthn request for approving (or cancelling) a proposal: the challenge is the approval
 * payload hash at the account's mirrored signer epoch, offered to the signer's active passkeys.
 */
export async function challengeFor(
  actor: ProposalActor,
  id: string,
  intent: ApprovalIntent = 'approve',
) {
  requireSigner(actor);
  const p = await loadProposal(actor, id);
  assertCanSign(p, intent);
  const account = await activeAccount(actor);
  if (intent === 'approve') assertNotApprovedAtEpoch(p, actor.userId, account.signerEpoch);
  const creds = await activeCredentials(actor.userId);
  if (creds.length === 0) throw forbidden('Register a passkey first');
  return {
    intent,
    signerEpoch: account.signerEpoch.toString(),
    challengeB64u: challengeB64u({
      contractId: account.nearAccountId,
      proposalId: p.onchainId,
      signerEpoch: account.signerEpoch,
      intent,
    }),
    rpId: env().WEBAUTHN_RP_ID,
    userVerification: 'required' as const,
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      type: 'public-key' as const,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
  };
}

// ─── assertions → contract `SignedApproval` ──────────────────────────────────

interface ParsedAssertion {
  credential: WebauthnCredential;
  key: SignerKey;
  authenticatorData: Uint8Array;
  clientDataJSON: string;
  challenge: string;
  signature: Uint8Array;
}

const badAssertion = (message = 'The passkey assertion is not valid for this proposal') =>
  invalid(message);

function b64urlField(v: unknown): Uint8Array {
  if (typeof v !== 'string' || !isoBase64URL.isBase64URL(v)) throw badAssertion();
  return isoBase64URL.toBuffer(v);
}

/**
 * Reads the three fields the contract needs from a browser's WebAuthn response —
 * authenticatorData, clientDataJSON and the signature — and the credential it names, which must be
 * an active passkey of `userId`. Nothing else the client sends is used.
 */
async function parseAssertion(userId: string, response: unknown): Promise<ParsedAssertion> {
  const r = response as Partial<AuthenticationResponseJSON> | undefined;
  if (!r || typeof r.id !== 'string' || !r.response) throw badAssertion();
  const credential = await prisma.webauthnCredential.findFirst({
    where: { credentialId: r.id, userId, revokedAt: null },
  });
  if (!credential) throw forbidden('That passkey is not one of your active passkeys');
  const authenticatorData = b64urlField(r.response.authenticatorData);
  const clientDataBytes = b64urlField(r.response.clientDataJSON);
  const signature = b64urlField(r.response.signature);
  const clientDataJSON = Buffer.from(clientDataBytes).toString('utf8');
  // The contract hashes the string's UTF-8 bytes; they must be exactly what was signed.
  if (!Buffer.from(clientDataJSON, 'utf8').equals(Buffer.from(clientDataBytes))) {
    throw badAssertion();
  }
  let client: ReturnType<typeof decodeClientDataJSON>;
  try {
    client = decodeClientDataJSON(r.response.clientDataJSON as string);
  } catch {
    throw badAssertion();
  }
  if (client.type !== 'webauthn.get' || typeof client.challenge !== 'string') {
    throw badAssertion();
  }
  if (client.crossOrigin === true) throw badAssertion('Cross-origin assertions are not accepted');
  const key = SignerKeySchema.parse(credential.publicKey) as SignerKey;
  return {
    credential,
    key,
    authenticatorData,
    clientDataJSON,
    challenge: client.challenge,
    signature,
  };
}

/**
 * Checks the assertion answers the challenge for this proposal and intent at the CURRENT mirrored
 * epoch. One made at an earlier epoch is a 409 (the signer set changed: approve again), so a stale
 * approval never costs gas.
 */
function checkChallenge(
  parsed: ParsedAssertion,
  input: { contractId: string; proposalId: string; intent: ApprovalIntent; epoch: bigint },
): void {
  const at = (signerEpoch: bigint) =>
    challengeB64u({
      contractId: input.contractId,
      proposalId: input.proposalId,
      signerEpoch,
      intent: input.intent,
    });
  if (parsed.challenge === at(input.epoch)) return;
  const floor = input.epoch > STALE_EPOCH_LOOKBACK ? input.epoch - STALE_EPOCH_LOOKBACK : 0n;
  for (let e = input.epoch - 1n; e >= floor; e--) {
    if (parsed.challenge === at(e)) {
      throw new AppError(
        'CONFLICT',
        `This approval was signed at signer epoch ${e}; the account is now at epoch ${input.epoch}. Sign again.`,
        409,
        { signerEpoch: input.epoch.toString() },
      );
    }
  }
  throw badAssertion();
}

/**
 * Verifies the assertion's signature locally against the stored passkey (with the contract's
 * rules: RP ID, origin, user verification), so a bad one is a 4xx and never costs gas, then
 * advances the credential's signature counter.
 */
async function verifyLocally(parsed: ParsedAssertion, response: unknown): Promise<void> {
  const { WEBAUTHN_RP_ID, WEBAUTHN_ORIGINS } = env();
  const c = parsed.credential;
  let newCounter: number;
  try {
    const verified = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: parsed.challenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: {
        id: c.credentialId,
        publicKey: signerKeyToCose(parsed.key),
        // Approvals never fail on a counter regression: the contract ignores counters and an
        // approval cannot be replayed on chain (bound to proposal, epoch and intent, one per
        // signer per epoch). A counter can legitimately go "back", e.g. an approval signed
        // before, and submitted after, a newer login from the same authenticator.
        counter: 0,
        transports: c.transports as AuthenticatorTransportFuture[],
      },
    });
    if (!verified.verified || !verified.authenticationInfo.userVerified) throw badAssertion();
    newCounter = verified.authenticationInfo.newCounter;
  } catch (err) {
    log('info', 'approval assertion rejected', { credentialId: c.id, err: String(err) });
    throw badAssertion();
  }
  await prisma.webauthnCredential.updateMany({
    where: { id: c.id, revokedAt: null },
    data: { lastUsedAt: new Date() },
  });
  await recordSignCount(c.id, newCounter);
}

/** The contract's `SignedApproval` JSON: byte fields standard padded base64, P-256 raw low-s. */
function signedApproval(signerId: string, parsed: ParsedAssertion) {
  let signature: Uint8Array;
  if ('p256' in parsed.key) {
    try {
      signature = normalizeP256Signature(parsed.signature);
    } catch {
      throw badAssertion();
    }
  } else {
    if (parsed.signature.length !== 64) throw badAssertion();
    signature = parsed.signature;
  }
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  return {
    signer_id: signerId,
    key: parsed.key,
    assertion: {
      authenticator_data: b64(parsed.authenticatorData),
      client_data_json: parsed.clientDataJSON,
      signature: b64(signature),
    },
  };
}

// ─── relay and outcome ───────────────────────────────────────────────────────

async function relay(
  livemode: boolean,
  contractId: string,
  method: 'propose' | 'approve' | 'cancel',
  args: object,
): Promise<TxResult> {
  return nearClient(livemode).call('relayer-accounts', contractId, method, args, {
    gas: RELAY_GAS,
  });
}

const landed = (r: TxResult) => r.topLevelStatus === 'success';

const rejected = (r: TxResult) =>
  new AppError('CONFLICT', 'The account contract rejected this', 409, {
    failure: r.failure,
    txHash: r.txHash,
  });

const RANK: Record<ProposalStatus, number> = {
  draft: 0,
  pending: 1,
  timelocked: 2,
  executing: 3,
  executed: 4,
  cancelled: 4,
  expired: 4,
  failed: 4,
};
const TERMINAL = (s: ProposalStatus) => RANK[s] === 4;

/**
 * Applies the contract's events about one proposal (from a transaction's logs) to its row: status,
 * `ready_at`, `executed_at`, `last_tx_hash`. Status only moves forward (draft → pending →
 * timelocked → executing → final). An approval that reached the threshold on a withdrawal, refund
 * or upgrade with no outcome event yet means the transfer or deployment is in flight
 * (`executing`). A `signers_changed` event also advances the account's mirrored threshold and
 * signer epoch, which the next challenge depends on. Idempotent on replay.
 */
export async function applyProposalEvents(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  proposalRowId: string,
  events: readonly AccountEvent[],
  txHash: string | null,
): Promise<AccountProposal> {
  const p = await tx.accountProposal.findFirst({
    where: { id: proposalRowId, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (!p) throw notFound('Proposal not found');
  let status = p.status as ProposalStatus;
  // A draft cancelled only in Postgres does not outrank the chain: if the contract reports on it,
  // the proposal exists on chain after all, so the events decide.
  const aboutIt = events.some((e) => e.data.proposal_id === p.onchainId);
  if (aboutIt && (await isLocalOnlyCancel(tx, ctx, p))) status = 'draft';
  let readyAt = p.readyAt;
  let executedAt = p.executedAt;
  let reached = false;
  let settled = false;
  const advance = (to: ProposalStatus) => {
    if (TERMINAL(status)) return;
    if (RANK[to] >= RANK[status]) status = to;
  };
  for (const e of events) {
    if (e.event === 'signers_changed') {
      const epoch = u64Of(e.data.signer_epoch);
      const threshold = e.data.threshold;
      if (epoch !== null && typeof threshold === 'number') {
        await tx.merchantAccount.updateMany({
          where: {
            id: p.accountId,
            merchantId: ctx.merchantId,
            livemode: ctx.livemode,
            signerEpoch: { lt: epoch },
          },
          data: { signerEpoch: epoch, threshold },
        });
      }
      continue;
    }
    if (e.data.proposal_id !== p.onchainId) continue;
    switch (e.event) {
      case 'proposal_created':
        advance('pending');
        break;
      case 'proposal_approved': {
        advance('pending');
        const n = e.data.approvals;
        const t = e.data.threshold;
        if (typeof n === 'number' && typeof t === 'number' && n >= t) reached = true;
        break;
      }
      case 'timelock_started':
        advance('timelocked');
        readyAt = nsToDate(e.data.ready_at) ?? readyAt;
        settled = true;
        break;
      case 'proposal_executed':
        advance('executed');
        executedAt ??= new Date();
        settled = true;
        break;
      case 'proposal_failed':
        advance(e.data.reason === 'expired' ? 'expired' : 'failed');
        settled = true;
        break;
      case 'proposal_cancelled':
        advance('cancelled');
        settled = true;
        break;
      default:
        break;
    }
  }
  const timelockOver = status === 'timelocked' && readyAt !== null && readyAt <= new Date();
  if (reached && !settled && ASYNC_KINDS.has(p.kind) && (status === 'pending' || timelockOver)) {
    advance('executing');
  }
  return tx.accountProposal.update({
    where: { id: p.id },
    data: { status, readyAt, executedAt, ...(txHash ? { lastTxHash: txHash } : {}) },
  });
}

async function recordTxHash(ctx: ScopeContext, id: string, txHash: string): Promise<void> {
  await prisma.accountProposal.updateMany({
    where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode },
    data: { lastTxHash: txHash },
  });
}

const isAlreadyExists = (r: TxResult) => /proposal already exists/.test(r.failure ?? '');
const isAlreadyApproved = (r: TxResult) =>
  /signer already approved this proposal/.test(r.failure ?? '');

/** The contract's `ProposalView` JSON (`get_proposal`), the fields used here. */
export interface ContractProposalView {
  id: string;
  status: 'pending' | 'executed' | 'failed' | 'cancelled' | 'expired' | 'executing';
  approvals: { signer_id: string; key: unknown; signer_epoch: string }[];
  valid_approvals: number;
  ready_at: string | null;
}

/**
 * Relays a signer's approval: `propose` for a draft (the first approval puts it on chain),
 * `approve` otherwise. Checks before any gas is spent: the caller is a signer, the passkey is
 * theirs and active, the assertion answers this proposal's approve challenge at the current
 * mirrored epoch, its signature verifies, and the action still passes local validation.
 *
 * A draft is CLAIMED (`relay_claimed_at`, set by a conditional update) before its `propose` is
 * relayed, and the draft-cancel path refuses a claimed draft. Without the claim a requester could
 * cancel the row mid-relay while `propose` landed, leaving the mirror "cancelled" for a live (or,
 * at threshold 1, already executed) proposal. The claim is released when the relay fails and
 * cleared when it lands; one older than `RELAY_CLAIM_LEASE_MS` (a crashed relay) may be taken
 * over. A claim rather than a row lock held across the relay, which would pin a pooled connection
 * and an open transaction for the seconds a NEAR round-trip takes.
 *
 * If the contract answers "signer already approved" (an earlier approval landed and its answer was
 * lost, or the `propose` → "already exists" → `approve` fallback met our own approval), the relay
 * counts as done and the row is brought up to date from the contract's `get_proposal` view.
 *
 * If the call never returns (network), the error propagates, the claim is released and nothing is
 * stored; the chain watcher's reconciliation picks up a transaction that did land.
 */
export async function submitApproval(
  actor: ProposalActor,
  id: string,
  response: unknown,
): Promise<ProposalView> {
  requireSigner(actor);
  const p = await loadProposal(actor, id);
  assertCanSign(p, 'approve');
  const account = await activeAccount(actor);
  assertNotApprovedAtEpoch(p, actor.userId, account.signerEpoch);
  const parsed = await parseAssertion(actor.userId, response);
  checkChallenge(parsed, {
    contractId: account.nearAccountId,
    proposalId: p.onchainId,
    intent: 'approve',
    epoch: account.signerEpoch,
  });
  await verifyLocally(parsed, response);
  const action = ActionSchema.parse(p.action);
  await validateLocally(actor, action);
  const approval = signedApproval(actor.userId, parsed);
  const contractId = account.nearAccountId;
  const approveArgs = { proposal_id: p.onchainId, approval };

  const claim = p.status === 'draft' ? await claimDraft(actor, p.id) : null;
  let result: TxResult;
  try {
    if (claim) {
      result = await relay(actor.livemode, contractId, 'propose', {
        action,
        salt: p.salt,
        approval,
      });
      // Another signer's `propose` landed first (or ours did, and its answer was lost).
      if (!landed(result) && isAlreadyExists(result)) {
        result = await relay(actor.livemode, contractId, 'approve', approveArgs);
      }
    } else {
      result = await relay(actor.livemode, contractId, 'approve', approveArgs);
    }
  } catch (err) {
    if (claim) await releaseClaim(actor, p.id, claim);
    throw err;
  }

  if (!landed(result) && isAlreadyApproved(result)) {
    const onChain = await nearClient(actor.livemode).view<ContractProposalView | null>(
      contractId,
      'get_proposal',
      { id: p.onchainId },
    );
    if (!onChain) {
      if (claim) await releaseClaim(actor, p.id, claim);
      throw rejected(result);
    }
    const mine = onChain.approvals.find((a) => a.signer_id === actor.userId);
    const credentialId = (await credentialForKey(actor.userId, mine?.key)) ?? parsed.credential.id;
    await tenantTransaction(actor, async (tx, ctx) => {
      await markOnChain(tx, ctx, p.id);
      await upsertApproval(tx, ctx, p.id, actor.userId, {
        credentialId,
        signerEpoch: u64Of(mine?.signer_epoch) ?? account.signerEpoch,
        txHash: null,
      });
      await applyProposalView(tx, ctx, p.id, onChain);
    });
    return getProposal(actor, p.id);
  }

  if (!landed(result)) {
    if (claim) await releaseClaim(actor, p.id, claim);
    await recordTxHash(actor, p.id, result.txHash);
    log('info', 'approval rejected on chain', { proposalId: p.id, failure: result.failure });
    throw rejected(result);
  }
  // Only receipts that succeeded: a failed receipt's events were rolled back with it.
  const events = parseAccountEvents(result.successLogs);
  await tenantTransaction(actor, async (tx, ctx) => {
    // The call landed, so the proposal is on chain even if its events were not in the logs.
    await markOnChain(tx, ctx, p.id);
    await upsertApproval(tx, ctx, p.id, actor.userId, {
      credentialId: parsed.credential.id,
      signerEpoch: account.signerEpoch,
      txHash: result.txHash,
    });
    await applyProposalEvents(tx, ctx, p.id, events, result.txHash);
  });
  return getProposal(actor, p.id);
}

/** How long a draft's relay claim holds before another approval may take it over. */
export const RELAY_CLAIM_LEASE_MS = 2 * 60_000;

/** Rows not claimed by a live relay: no claim, or a claim past its lease. */
const claimFree = () => ({
  OR: [
    { relayClaimedAt: null },
    { relayClaimedAt: { lt: new Date(Date.now() - RELAY_CLAIM_LEASE_MS) } },
  ],
});

/** Claims a draft for relaying its `propose`; 409 if it is no longer a free draft. */
async function claimDraft(ctx: ScopeContext, id: string): Promise<Date> {
  const claimedAt = new Date();
  const { count } = await prisma.accountProposal.updateMany({
    where: {
      id,
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      status: 'draft',
      ...claimFree(),
    },
    data: { relayClaimedAt: claimedAt },
  });
  if (count === 0) {
    throw conflict('This proposal is being submitted or has changed; reload it and try again');
  }
  return claimedAt;
}

/** Releases our own claim (a later claimer's is left alone). */
async function releaseClaim(ctx: ScopeContext, id: string, claimedAt: Date): Promise<void> {
  await prisma.accountProposal.updateMany({
    where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode, relayClaimedAt: claimedAt },
    data: { relayClaimedAt: null },
  });
}

/**
 * Whether the row's `cancelled` is local only: a draft cancelled in Postgres that never had an
 * approval land through the relay. On-chain evidence about the proposal (events, the contract's
 * view) overrides such a status; every other final status stays final.
 */
async function isLocalOnlyCancel(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  p: AccountProposal,
): Promise<boolean> {
  if (p.status !== 'cancelled') return false;
  const landedApprovals = await tx.accountApproval.count({
    where: { proposalId: p.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  return landedApprovals === 0;
}

/**
 * A relay landed for this proposal: a draft (or a locally cancelled draft, which the chain
 * overrides) becomes `pending`, and any relay claim is cleared.
 */
async function markOnChain(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  id: string,
): Promise<void> {
  const p = await tx.accountProposal.findFirst({
    where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (!p) throw notFound('Proposal not found');
  const reopen = p.status === 'draft' || (await isLocalOnlyCancel(tx, ctx, p));
  await tx.accountProposal.update({
    where: { id: p.id },
    data: { relayClaimedAt: null, ...(reopen ? { status: 'pending' as const } : {}) },
  });
}

async function upsertApproval(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  proposalId: string,
  userId: string,
  v: { credentialId: string; signerEpoch: bigint; txHash: string | null },
): Promise<void> {
  await tx.accountApproval.upsert({
    where: { proposalId_userId: { proposalId, userId } },
    create: {
      id: newId('appr'),
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      proposalId,
      userId,
      ...v,
    },
    update: {
      credentialId: v.credentialId,
      signerEpoch: v.signerEpoch,
      ...(v.txHash ? { txHash: v.txHash } : {}),
    },
  });
}

/** The person's credential row whose public key is `key` (R1: searched within the person only). */
async function credentialForKey(userId: string, key: unknown): Promise<string | null> {
  const parsed = SignerKeySchema.safeParse(key);
  if (!parsed.success) return null;
  const want = keyId(parsed.data as SignerKey);
  const creds = await prisma.webauthnCredential.findMany({ where: { userId } });
  const match = creds.find((c) => {
    const k = SignerKeySchema.safeParse(c.publicKey);
    return k.success && keyId(k.data as SignerKey) === want;
  });
  return match?.id ?? null;
}

/**
 * Brings a proposal row up to date from the contract's `get_proposal` view. Forward-only like
 * `applyProposalEvents`, and likewise overriding a local-only `cancelled`. A pending view with a
 * live `ready_at` is `timelocked`.
 */
export async function applyProposalView(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  proposalRowId: string,
  v: ContractProposalView,
): Promise<AccountProposal> {
  const p = await tx.accountProposal.findFirst({
    where: { id: proposalRowId, merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  if (!p) throw notFound('Proposal not found');
  let current = p.status as ProposalStatus;
  if (await isLocalOnlyCancel(tx, ctx, p)) current = 'draft';
  const readyAt = v.ready_at !== null ? nsToDate(v.ready_at) : null;
  const target: ProposalStatus =
    v.status === 'pending' ? (readyAt ? 'timelocked' : 'pending') : v.status;
  const status = TERMINAL(current) || RANK[target] < RANK[current] ? current : target;
  return tx.accountProposal.update({
    where: { id: p.id },
    data: {
      status,
      ...(readyAt ? { readyAt } : {}),
      ...(status === 'executed' && !p.executedAt ? { executedAt: new Date() } : {}),
    },
  });
}

/**
 * Cancels a proposal. A draft is off chain: its creator or any signer may drop it, no passkey
 * needed. A pending or timelocked proposal needs a signer's `cancel` assertion, relayed to the
 * contract's `cancel` (which may report it expired instead).
 */
export async function cancelProposal(
  actor: ProposalActor,
  id: string,
  response?: unknown,
): Promise<ProposalView> {
  const p = await loadProposal(actor, id);
  if (p.status === 'draft') {
    if (!actor.isSigner && p.createdByUserId !== actor.userId) {
      throw forbidden('Only the requester or a signer can cancel a draft');
    }
    // Never while a signer's first approval is being relayed: `propose` may be landing.
    const { count } = await prisma.accountProposal.updateMany({
      where: {
        id: p.id,
        merchantId: actor.merchantId,
        livemode: actor.livemode,
        status: 'draft',
        ...claimFree(),
      },
      data: { status: 'cancelled' },
    });
    if (count === 0) {
      throw conflict(
        'A signer is submitting this proposal to the account; reload it, then cancel it there',
      );
    }
    return getProposal(actor, p.id);
  }
  requireSigner(actor);
  assertCanSign(p, 'cancel');
  if (response === undefined)
    throw badAssertion('A passkey assertion with intent cancel is required');
  const account = await activeAccount(actor);
  const parsed = await parseAssertion(actor.userId, response);
  checkChallenge(parsed, {
    contractId: account.nearAccountId,
    proposalId: p.onchainId,
    intent: 'cancel',
    epoch: account.signerEpoch,
  });
  await verifyLocally(parsed, response);
  const result = await relay(actor.livemode, account.nearAccountId, 'cancel', {
    proposal_id: p.onchainId,
    approval: signedApproval(actor.userId, parsed),
  });
  if (!landed(result)) {
    await recordTxHash(actor, p.id, result.txHash);
    throw rejected(result);
  }
  const events = parseAccountEvents(result.successLogs);
  await tenantTransaction(actor, (tx, ctx) =>
    applyProposalEvents(tx, ctx, p.id, events, result.txHash),
  );
  return getProposal(actor, p.id);
}
