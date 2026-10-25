// A store's merchant accounts: the test account (`<slug>.tendr.testnet`) provisioned when the store
// is created, the live account (`<slug>.tendr.near`) provisioned at go-live, the recovery key, the
// testnet-admin mirror of the live signer set, and balances.
//
// Provisioning runs as a job (the `merchant_account.provision_requested` event), never inline in
// a request:
// - a `merchant_accounts` row is created as `provisioning` and the event is recorded in the same
//   transaction, so the job exists iff the row does;
// - the job builds the init config from Postgres at run time (signers = members with `is_signer`,
//   each with all their ACTIVE passkeys; signer id = the person id `per_…`) and calls
//   `provisionAccount` with `funding-near` (capped);
// - an unknown outcome (a timeout) or a retry that finds the account already exists is settled by
//   looking at the chain: an account with zero access keys whose `get_config` answers for this
//   mode's intents contract and RP ID is the one we created. Anything else marks the row `failed`;
//   a failed row is retried by the job (when it threw) or by the owner (`retryProvisioning`).
//
// Two-key rule (spec §2): a store goes live only when `signers + (recovery key ? 1 : 0) >= 2` and
// `1 <= threshold <= signers`. The recovery key never counts toward the threshold.
import {
  ROLE_PERMISSIONS,
  SignerKeySchema,
  type MerchantUserRole,
  type SignerKey,
} from '@tendr/contracts';
import { Prisma, type MerchantAccount } from '@prisma/client';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import {
  nearClient,
  type InitConfigJson,
  type NearClient,
  type SignerKeyJson,
  type TxResult,
} from '../near/client.js';
import { NotBroadcastError } from '../near/rpc.js';
import { createDraft, type ProposalView } from './proposals.js';

/** Recorded with a `provisioning` row; its job provisions the account. */
export const PROVISION_REQUESTED = 'merchant_account.provision_requested';
/** The job (event handler) name; stable across deploys. */
export const PROVISION_HANDLER = 'provision-merchant-account';
/** How long balances are cached, per (merchant, mode). */
export const BALANCES_TTL_SECONDS = 15;
/** Most assets one balance read asks the intents contract about. */
const MAX_BALANCE_ASSETS = 100;
const MAX_FAILURE_LEN = 500;

const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, 400, details);

type Db = Prisma.TransactionClient | typeof prisma;

/** `<slug>.<parent>` for the mode: `<slug>.tendr.near` / `<slug>.tendr.testnet`. */
export function nearAccountIdFor(slug: string, livemode: boolean): string {
  const e = env();
  return `${slug}.${livemode ? e.NEAR_PARENT_ACCOUNT_LIVE : e.NEAR_PARENT_ACCOUNT_TEST}`;
}

function codeHashFor(livemode: boolean): string | null {
  const e = env();
  return (livemode ? e.MERCHANT_ACCOUNT_CODE_HASH_LIVE : e.MERCHANT_ACCOUNT_CODE_HASH_TEST) ?? null;
}

function intentsContractFor(livemode: boolean): string {
  const e = env();
  return livemode ? e.INTENTS_CONTRACT_LIVE : e.INTENTS_CONTRACT_TEST;
}

// ─── signers and keys ────────────────────────────────────────────────────────

export interface SignerEntry {
  id: string;
  keys: SignerKeyJson[];
  /** `webauthn_credentials.id` of each key, in the same order. */
  credentialRowIds: string[];
}

/**
 * The store's signers as they go into an init config: every member with `is_signer`, each with
 * all their active (non-revoked) passkeys. A signer with no active passkey is left out (an empty
 * key list could never approve, and the contract refuses it).
 */
async function signerSet(db: Db, merchantId: string): Promise<SignerEntry[]> {
  const members = await db.merchantUser.findMany({
    where: { merchantId, isSigner: true },
    orderBy: { userId: 'asc' },
    select: {
      userId: true,
      user: {
        select: {
          credentials: {
            where: { revokedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, publicKey: true },
          },
        },
      },
    },
  });
  return members
    .map((m) => ({
      id: m.userId,
      keys: m.user.credentials.map((c) => SignerKeySchema.parse(c.publicKey) as SignerKeyJson),
      credentialRowIds: m.user.credentials.map((c) => c.id),
    }))
    .filter((s) => s.keys.length > 0);
}

async function activeRecoveryKey(db: Db, merchantId: string): Promise<string | null> {
  const row = await db.accountKey.findFirst({
    where: { merchantId, livemode: true, kind: 'recovery', revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return row?.publicKey ?? null;
}

const keyId = (k: SignerKeyJson | SignerKey) =>
  'p256' in k ? `p256:${k.p256}` : `ed25519:${k.ed25519}`;

// ─── provisioning ────────────────────────────────────────────────────────────

/** Queues provisioning for `account` (same transaction as the row change). */
async function requestProvisioning(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  account: MerchantAccount,
): Promise<void> {
  await recordEvent(tx, ctx, {
    aggregateType: 'merchant_account',
    aggregateId: account.id,
    type: PROVISION_REQUESTED,
    payload: { accountId: account.id, nearAccountId: account.nearAccountId },
  });
}

/**
 * Creates the store's test account row (`provisioning`, threshold 1) and queues its provisioning.
 * Called inside the store-creation transaction.
 */
export async function createTestAccount(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  slug: string,
): Promise<MerchantAccount> {
  if (ctx.livemode) throw new Error('createTestAccount is for the test mode only');
  const account = await tx.merchantAccount.create({
    data: {
      id: newId('macc'),
      merchantId: ctx.merchantId,
      livemode: false,
      nearAccountId: nearAccountIdFor(slug, false),
      contractCodeHash: codeHashFor(false),
      threshold: 1,
      status: 'provisioning',
    },
  });
  await requestProvisioning(tx, ctx, account);
  return account;
}

/** Why an init config cannot be built right now (the job does not retry these). */
class NotProvisionable extends Error {}

async function initConfigFor(account: MerchantAccount): Promise<{
  init: InitConfigJson;
  signers: SignerEntry[];
}> {
  const e = env();
  const signers = await signerSet(prisma, account.merchantId);
  if (signers.length === 0) throw new NotProvisionable('the store has no signer with a passkey');
  let recovery: string | null = null;
  if (account.livemode) {
    recovery = await activeRecoveryKey(prisma, account.merchantId);
    const check = goLiveRule(signers.length, recovery !== null, account.threshold);
    if (!check.ok) throw new NotProvisionable(`go-live rule not met: ${check.missing.join(', ')}`);
    if (recovery && signers.some((s) => s.keys.some((k) => keyId(k) === `ed25519:${recovery}`))) {
      throw new NotProvisionable('the recovery key equals a signer key');
    }
  }
  return {
    signers,
    init: {
      signers: signers.map((s) => ({ id: s.id, keys: s.keys })),
      threshold: account.livemode ? account.threshold : 1,
      recovery_key: recovery,
      rp_id: e.WEBAUTHN_RP_ID,
      origins: [...e.WEBAUTHN_ORIGINS],
      intents_contract: intentsContractFor(account.livemode),
      poa_suffix: null,
      // The test parent administers test accounts; a live account never has an admin.
      testnet_admin: account.livemode ? null : e.NEAR_PARENT_ACCOUNT_TEST,
    },
  };
}

/** The contract's `ConfigView` JSON. */
export interface ConfigView {
  signers: { id: string; keys: SignerKeyJson[] }[];
  threshold: number;
  signer_epoch: string;
  origins: string[];
  rp_id: string;
  recovery_key_set: boolean;
  recovery_key_epoch: string;
  intents_contract: string;
  poa_suffix: string;
}

/**
 * Whether `account` exists on chain as a correctly initialised merchant account: zero access
 * keys, and `get_config` answers for this mode's intents contract and RP ID. Only the mode's
 * parent can create `<slug>.<parent>`, and our parent only ever creates it with that batch, so
 * this identifies our own earlier attempt. Returns its config, or null.
 */
async function onChainConfig(
  client: NearClient,
  account: MerchantAccount,
): Promise<ConfigView | null> {
  try {
    const keys = await client.accessKeys(account.nearAccountId);
    if (keys.length > 0) return null;
    const config = await client.view<ConfigView>(account.nearAccountId, 'get_config', {});
    if (
      config?.intents_contract !== intentsContractFor(account.livemode) ||
      config.rp_id !== env().WEBAUTHN_RP_ID ||
      !Array.isArray(config.signers)
    ) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

const isAlreadyExists = (r: TxResult) => /already exists/i.test(r.failure ?? '');

/**
 * Provisions the store's account in `livemode` if it is `provisioning` or `failed`; an `active`
 * account is returned untouched (so a replayed job is a no-op).
 *
 * - success (or an earlier attempt found on chain) → `active`, threshold and epoch from chain,
 *   signer keys mirrored into `account_keys`;
 * - a definite failure (failed on chain, init not buildable) → `failed`, returned (not thrown:
 *   retrying the same thing would fail the same way; the owner retries after fixing it);
 * - a thrown error (not broadcast, funding cap, unknown outcome not found on chain) → `failed`,
 *   then rethrown so the job retries.
 */
export async function provisionMerchantAccount(
  merchantId: string,
  livemode: boolean,
): Promise<MerchantAccount> {
  const account = await prisma.merchantAccount.findFirst({ where: { merchantId, livemode } });
  if (!account) throw notFound('No account to provision');
  if (account.status === 'active') return account;

  let built: Awaited<ReturnType<typeof initConfigFor>>;
  try {
    built = await initConfigFor(account);
  } catch (err) {
    if (err instanceof NotProvisionable) return markFailed(account, err.message);
    throw err;
  }

  const client = nearClient(livemode);
  let result: TxResult;
  try {
    result = await client.provisionAccount({
      merchantId,
      livemode,
      accountId: account.nearAccountId,
      init: built.init,
      initialBalanceYocto: env().MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO,
    });
  } catch (err) {
    // Nothing reached the chain for these; anything else may have landed.
    const definitelyNotSent = err instanceof NotBroadcastError || err instanceof AppError;
    if (!definitelyNotSent) {
      const config = await onChainConfig(client, account);
      if (config) return activateFromChain(account, config, null);
    }
    await markFailed(account, String(err));
    throw err;
  }

  if (result.status === 'success') {
    return activate(account, {
      signers: built.signers,
      threshold: built.init.threshold,
      signerEpoch: 0n,
      txHash: result.txHash,
    });
  }
  if (isAlreadyExists(result)) {
    const config = await onChainConfig(client, account);
    if (config) return activateFromChain(account, config, null);
  }
  return markFailed(account, result.failure ?? 'provisioning failed on chain', result.txHash);
}

/** Test mode's `provisionMerchantAccount`. */
export function provisionTestAccount(merchantId: string): Promise<MerchantAccount> {
  return provisionMerchantAccount(merchantId, false);
}

/** Maps the chain's signer set onto credential rows, then activates. */
async function activateFromChain(
  account: MerchantAccount,
  config: ConfigView,
  txHash: string | null,
): Promise<MerchantAccount> {
  const known = new Set(
    (
      await prisma.user.findMany({
        where: { id: { in: config.signers.map((s) => s.id) } },
        select: { id: true },
      })
    ).map((u) => u.id),
  );
  const signers = await Promise.all(
    config.signers
      .filter((s) => known.has(s.id))
      .map(async (s) => {
        const creds = await prisma.webauthnCredential.findMany({
          where: { userId: s.id },
          select: { id: true, publicKey: true },
        });
        const byKey = new Map(
          creds.map((c) => [keyId(SignerKeySchema.parse(c.publicKey) as SignerKey), c.id]),
        );
        return {
          id: s.id,
          keys: s.keys,
          credentialRowIds: s.keys.map((k) => byKey.get(keyId(k)) ?? ''),
        };
      }),
  );
  return activate(account, {
    signers,
    threshold: config.threshold,
    signerEpoch: BigInt(config.signer_epoch),
    txHash,
  });
}

async function activate(
  account: MerchantAccount,
  s: { signers: SignerEntry[]; threshold: number; signerEpoch: bigint; txHash: string | null },
): Promise<MerchantAccount> {
  const ctx = { merchantId: account.merchantId, livemode: account.livemode };
  return tenantTransaction(ctx, async (tx) => {
    const updated = await tx.merchantAccount.updateMany({
      where: { id: account.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
      data: {
        status: 'active',
        threshold: s.threshold,
        signerEpoch: s.signerEpoch,
        ...(s.txHash ? { createdTx: s.txHash } : {}),
      },
    });
    if (updated.count !== 1) throw notFound('Account not found');
    await mirrorSignerKeys(tx, account, s.signers);
    await recordEvent(tx, ctx, {
      aggregateType: 'merchant_account',
      aggregateId: account.id,
      type: 'merchant_account.activated',
      payload: { nearAccountId: account.nearAccountId, txHash: s.txHash },
    });
    return tx.merchantAccount.findFirstOrThrow({ where: { id: account.id } });
  });
}

/** Replaces the account's mirrored passkey rows with `signers` (display only; chain is truth). */
async function mirrorSignerKeys(
  tx: Prisma.TransactionClient,
  account: MerchantAccount,
  signers: SignerEntry[],
): Promise<void> {
  await tx.accountKey.deleteMany({
    where: {
      merchantId: account.merchantId,
      livemode: account.livemode,
      nearAccountId: account.nearAccountId,
      kind: 'passkey',
    },
  });
  await tx.accountKey.createMany({
    data: signers.flatMap((s) =>
      s.keys.map((k, i) => ({
        id: newId('akey'),
        merchantId: account.merchantId,
        livemode: account.livemode,
        nearAccountId: account.nearAccountId,
        publicKey: keyId(k),
        kind: 'passkey' as const,
        userId: s.id,
        credentialId: s.credentialRowIds[i] || null,
      })),
    ),
  });
}

async function markFailed(
  account: MerchantAccount,
  reason: string,
  txHash?: string,
): Promise<MerchantAccount> {
  const ctx = { merchantId: account.merchantId, livemode: account.livemode };
  log('warn', 'merchant account provisioning failed', {
    accountId: account.id,
    nearAccountId: account.nearAccountId,
    reason: reason.slice(0, MAX_FAILURE_LEN),
  });
  return tenantTransaction(ctx, async (tx) => {
    const updated = await tx.merchantAccount.updateMany({
      where: {
        id: account.id,
        merchantId: ctx.merchantId,
        livemode: ctx.livemode,
        status: { not: 'active' },
      },
      data: { status: 'failed' },
    });
    if (updated.count === 1) {
      await recordEvent(tx, ctx, {
        aggregateType: 'merchant_account',
        aggregateId: account.id,
        type: 'merchant_account.provisioning_failed',
        payload: {
          nearAccountId: account.nearAccountId,
          reason: reason.slice(0, MAX_FAILURE_LEN),
          ...(txHash ? { txHash } : {}),
        },
      });
    }
    return tx.merchantAccount.findFirstOrThrow({ where: { id: account.id } });
  });
}

/** Re-queues a `failed` account's provisioning (409 for any other status). */
export async function retryProvisioning(ctx: ScopeContext): Promise<MerchantAccount> {
  return tenantTransaction(ctx, async (tx) => {
    const account = await tx.merchantAccount.findFirst({
      where: { merchantId: ctx.merchantId, livemode: ctx.livemode },
    });
    if (!account) throw notFound('No account in this mode');
    const updated = await tx.merchantAccount.updateMany({
      where: { id: account.id, merchantId: ctx.merchantId, status: 'failed' },
      data: { status: 'provisioning' },
    });
    if (updated.count !== 1)
      throw conflict(`The account is ${account.status}; only a failed one is retried`);
    const row = await tx.merchantAccount.findFirstOrThrow({ where: { id: account.id } });
    await requestProvisioning(tx, ctx, row);
    return row;
  });
}

// ─── go-live ─────────────────────────────────────────────────────────────────

export type GoLiveMissing = 'second_key' | 'threshold';

function goLiveRule(
  signerCount: number,
  hasRecoveryKey: boolean,
  threshold: number,
): { ok: boolean; missing: GoLiveMissing[] } {
  const missing: GoLiveMissing[] = [];
  if (signerCount + (hasRecoveryKey ? 1 : 0) < 2) missing.push('second_key');
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > signerCount) {
    missing.push('threshold');
  }
  return { ok: missing.length === 0, missing };
}

/**
 * The two-key rule for going live with `threshold` (default 1): signers (with an active passkey)
 * plus the recovery key must be at least 2, and `1 <= threshold <= signers`.
 */
export async function goLiveCheck(
  merchantId: string,
  threshold = 1,
  db: Db = prisma,
): Promise<{ ok: boolean; missing: GoLiveMissing[] }> {
  const [signers, recovery] = await Promise.all([
    signerSet(db, merchantId),
    activeRecoveryKey(db, merchantId),
  ]);
  return goLiveRule(signers.length, recovery !== null, threshold);
}

/** What the go-live checklist shows. */
export async function goLiveStatus(merchantId: string, threshold = 1) {
  const [signers, recovery, live, check] = await Promise.all([
    signerSet(prisma, merchantId),
    activeRecoveryKey(prisma, merchantId),
    prisma.merchantAccount.findFirst({ where: { merchantId, livemode: true } }),
    goLiveCheck(merchantId, threshold),
  ]);
  return {
    ...check,
    signerCount: signers.length,
    recoveryKeySet: recovery !== null,
    liveAccount: live ? accountJson(live) : null,
  };
}

/** Actor of the owner-only account actions (go-live, recovery key). */
export interface OwnerActor {
  merchantId: string;
  userId: string;
}

async function membershipOf(actor: OwnerActor) {
  const m = await prisma.merchantUser.findFirst({
    where: { merchantId: actor.merchantId, userId: actor.userId },
  });
  if (!m) throw forbidden('Not a member of this store');
  return m;
}

async function requireOwner(actor: OwnerActor) {
  const m = await membershipOf(actor);
  if (m.role !== 'owner') throw forbidden('Only an owner can do this');
  return m;
}

/** Serialises go-live and recovery-key registration for one store. */
async function lockMerchant(tx: Prisma.TransactionClient, merchantId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${merchantId} FOR UPDATE`;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Goes live: checks the two-key rule for `threshold` (default 1), creates the live account row
 * (`<slug>.tendr.near`, `provisioning`) and queues its provisioning — the current signers, the
 * threshold and the recovery key, no admin. Idempotent: once a live account exists, it is
 * returned as is (`created: false`).
 */
export async function goLiveOutcome(
  actor: OwnerActor,
  opts: { threshold?: number } = {},
): Promise<{ account: MerchantAccount; created: boolean }> {
  await requireOwner(actor);
  const threshold = opts.threshold ?? 1;
  const ctx = { merchantId: actor.merchantId, livemode: true };
  const existing = () =>
    prisma.merchantAccount.findFirst({ where: { merchantId: actor.merchantId, livemode: true } });
  const found = await existing();
  if (found) return { account: found, created: false };
  try {
    const account = await tenantTransaction(ctx, async (tx) => {
      await lockMerchant(tx, ctx.merchantId);
      const again = await tx.merchantAccount.findFirst({
        where: { merchantId: ctx.merchantId, livemode: true },
      });
      if (again) return null;
      const check = await goLiveCheck(ctx.merchantId, threshold, tx);
      if (!check.ok) {
        throw conflict('The store cannot go live yet', { missing: check.missing });
      }
      const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: ctx.merchantId } });
      const row = await tx.merchantAccount.create({
        data: {
          id: newId('macc'),
          merchantId: ctx.merchantId,
          livemode: true,
          nearAccountId: nearAccountIdFor(merchant.slug, true),
          contractCodeHash: codeHashFor(true),
          threshold,
          status: 'provisioning',
        },
      });
      await requestProvisioning(tx, ctx, row);
      return row;
    });
    if (account) return { account, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  return { account: (await existing())!, created: false };
}

export async function goLive(
  actor: OwnerActor,
  opts: { threshold?: number } = {},
): Promise<MerchantAccount> {
  return (await goLiveOutcome(actor, opts)).account;
}

// ─── recovery key ────────────────────────────────────────────────────────────

const STD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Registers the store's recovery public key (32-byte Ed25519, standard padded base64). It must
 * differ from every signer key.
 * - Before go-live (no live account, or a failed one): stored as the active `recovery` account key
 *   (replacing any earlier one) and used in the live init.
 * - After go-live: becomes a `rotate_recovery_key` proposal draft on the live account; nothing is
 *   written until the contract executes it.
 * - While go-live is provisioning: 409 (the live init is being built).
 */
export async function registerRecoveryKey(
  actor: OwnerActor,
  publicKeyB64: string,
): Promise<{ stored: true } | { stored: false; proposal: ProposalView }> {
  const membership = await requireOwner(actor);
  if (!STD_BASE64.test(publicKeyB64) || Buffer.from(publicKeyB64, 'base64').length !== 32) {
    throw invalid('The recovery key must be a 32-byte Ed25519 public key in standard base64');
  }
  const signers = await signerSet(prisma, actor.merchantId);
  if (signers.some((s) => s.keys.some((k) => keyId(k) === `ed25519:${publicKeyB64}`))) {
    throw invalid('The recovery key must differ from every signer key');
  }

  const live = await prisma.merchantAccount.findFirst({
    where: { merchantId: actor.merchantId, livemode: true },
  });
  if (live?.status === 'active') {
    const proposal = await createDraft(
      {
        merchantId: actor.merchantId,
        livemode: true,
        userId: actor.userId,
        isSigner: membership.isSigner,
        permissions: ROLE_PERMISSIONS[membership.role as MerchantUserRole],
      },
      { kind: 'rotate_recovery_key', action: { rotate_recovery_key: publicKeyB64 } },
    );
    return { stored: false, proposal };
  }

  const ctx = { merchantId: actor.merchantId, livemode: true };
  await tenantTransaction(ctx, async (tx) => {
    await lockMerchant(tx, ctx.merchantId);
    const current = await tx.merchantAccount.findFirst({
      where: { merchantId: ctx.merchantId, livemode: true },
    });
    if (current && current.status !== 'failed') {
      throw conflict('Go-live is in progress; set the recovery key once the live account is ready');
    }
    const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: ctx.merchantId } });
    const now = new Date();
    await tx.accountKey.updateMany({
      where: { merchantId: ctx.merchantId, livemode: true, kind: 'recovery', revokedAt: null },
      data: { revokedAt: now },
    });
    const id = newId('akey');
    await tx.accountKey.create({
      data: {
        id,
        merchantId: ctx.merchantId,
        livemode: true,
        nearAccountId: nearAccountIdFor(merchant.slug, true),
        publicKey: publicKeyB64,
        kind: 'recovery',
      },
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'account_key',
      aggregateId: id,
      type: 'account.recovery_key_registered',
      payload: { publicKey: publicKeyB64, registeredBy: actor.userId },
    });
  });
  return { stored: true };
}

// ─── test mirror ─────────────────────────────────────────────────────────────

const sameSigners = (a: ConfigView, b: ConfigView) =>
  a.threshold === b.threshold &&
  JSON.stringify([...a.signers].sort((x, y) => x.id.localeCompare(y.id))) ===
    JSON.stringify([...b.signers].sort((x, y) => x.id.localeCompare(y.id)));

/**
 * Mirrors the LIVE contract's signer set and threshold onto the store's TEST contract with
 * `admin_sync_signers`, signed by the test parent (the test account's `testnet_admin`) via
 * `funding-near`. Called after any executed live signer or threshold change. The live config is
 * read from the live contract (the authority). A no-op before go-live, while either account is
 * not active, or when the test contract already matches. Throws when the sync fails on chain.
 */
export async function mirrorTestSigners(
  merchantId: string,
): Promise<{ synced: boolean; txHash?: string }> {
  const [live, test] = await Promise.all([
    prisma.merchantAccount.findFirst({ where: { merchantId, livemode: true } }),
    prisma.merchantAccount.findFirst({ where: { merchantId, livemode: false } }),
  ]);
  if (live?.status !== 'active' || test?.status !== 'active') return { synced: false };
  // Only ever the TEST client signs as an admin; the live client is only read.
  const testClient = nearClient(false);
  const [liveConfig, testConfig] = await Promise.all([
    nearClient(true).view<ConfigView>(live.nearAccountId, 'get_config', {}),
    testClient.view<ConfigView>(test.nearAccountId, 'get_config', {}),
  ]);
  if (sameSigners(liveConfig, testConfig)) return { synced: false };
  const result = await testClient.callAsTestnetAdmin(test.nearAccountId, 'admin_sync_signers', {
    signers: liveConfig.signers,
    threshold: liveConfig.threshold,
  });
  if (result.topLevelStatus !== 'success') {
    throw new Error(`admin_sync_signers failed on ${test.nearAccountId}: ${result.failure ?? ''}`);
  }
  const after = await testClient.view<ConfigView>(test.nearAccountId, 'get_config', {});
  const ctx = { merchantId, livemode: false };
  await tenantTransaction(ctx, async (tx) => {
    await tx.merchantAccount.updateMany({
      where: { id: test.id, merchantId, livemode: false },
      data: { threshold: after.threshold, signerEpoch: BigInt(after.signer_epoch) },
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'merchant_account',
      aggregateId: test.id,
      type: 'merchant_account.test_signers_mirrored',
      payload: { txHash: result.txHash, signerEpoch: after.signer_epoch },
    });
  });
  return { synced: true, txHash: result.txHash };
}

// ─── views and balances ──────────────────────────────────────────────────────

export function accountJson(a: MerchantAccount) {
  return {
    id: a.id,
    livemode: a.livemode,
    nearAccountId: a.nearAccountId,
    status: a.status,
    threshold: a.threshold,
    signerEpoch: a.signerEpoch.toString(),
    contractCodeHash: a.contractCodeHash,
    createdTx: a.createdTx,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** The store's account in the caller's mode only, with its mirrored signers. */
export async function accountView(ctx: ScopeContext) {
  const account = await prisma.merchantAccount.findFirst({
    where: { merchantId: ctx.merchantId, livemode: ctx.livemode },
  });
  const keys = account
    ? await prisma.accountKey.findMany({
        where: {
          merchantId: ctx.merchantId,
          livemode: ctx.livemode,
          nearAccountId: account.nearAccountId,
          kind: 'passkey',
          revokedAt: null,
        },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { email: true } } },
      })
    : [];
  const bySigner = new Map<string, { userId: string; email: string | null; keys: number }>();
  for (const k of keys) {
    if (!k.userId) continue;
    const entry = bySigner.get(k.userId) ?? {
      userId: k.userId,
      email: k.user?.email ?? null,
      keys: 0,
    };
    entry.keys += 1;
    bySigner.set(k.userId, entry);
  }
  return {
    livemode: ctx.livemode,
    account: account ? accountJson(account) : null,
    signers: [...bySigner.values()],
  };
}

export const balancesCacheKey = (merchantId: string, livemode: boolean) =>
  `balances:${merchantId}:${livemode ? 'live' : 'test'}`;

/** Asset ids named in an action JSON (`asset`, `dest_asset` fields). */
function assetsIn(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) assetsIn(x, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'asset' || k === 'dest_asset') && typeof x === 'string' && x.length > 0) {
        out.add(x);
      } else {
        assetsIn(x, out);
      }
    }
  }
}

export interface Balances {
  accountId: string | null;
  balances: { asset: string; amount: string }[];
}

/**
 * The account's intents balances in `livemode`: `mt_batch_balance_of` on the mode's intents
 * contract for the assets in `settlement_configs` and every asset named by a proposal. Cached for
 * 15 s in Redis per (merchant, mode); a Redis failure only skips the cache. Amounts are decimal
 * strings (u128).
 */
export async function getBalances(merchantId: string, livemode: boolean): Promise<Balances> {
  const account = await prisma.merchantAccount.findFirst({ where: { merchantId, livemode } });
  if (account?.status !== 'active') return { accountId: null, balances: [] };
  const key = balancesCacheKey(merchantId, livemode);
  try {
    const cached = await getRedis().get(key);
    if (cached) return JSON.parse(cached) as Balances;
  } catch (err) {
    log('warn', 'balances cache read failed', { err: String(err) });
  }

  const assets = new Set<string>();
  const [configs, proposals] = await Promise.all([
    prisma.settlementConfig.findMany({
      where: { merchantId, livemode },
      select: { destAssetId: true },
    }),
    prisma.accountProposal.findMany({
      where: { merchantId, livemode },
      select: { action: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
  ]);
  for (const c of configs) assets.add(c.destAssetId);
  for (const p of proposals) assetsIn(p.action, assets);
  const tokenIds = [...assets].sort().slice(0, MAX_BALANCE_ASSETS);

  let balances: Balances['balances'] = [];
  if (tokenIds.length > 0) {
    const amounts = await nearClient(livemode).view<unknown>(
      intentsContractFor(livemode),
      'mt_batch_balance_of',
      { account_id: account.nearAccountId, token_ids: tokenIds },
    );
    if (
      !Array.isArray(amounts) ||
      amounts.length !== tokenIds.length ||
      !amounts.every((a) => typeof a === 'string' && /^\d{1,39}$/.test(a))
    ) {
      throw new Error('mt_batch_balance_of returned an unexpected result');
    }
    balances = tokenIds.map((asset, i) => ({ asset, amount: amounts[i] as string }));
  }
  const out: Balances = { accountId: account.nearAccountId, balances };
  try {
    await getRedis().set(key, JSON.stringify(out), 'EX', BALANCES_TTL_SECONDS);
  } catch (err) {
    log('warn', 'balances cache write failed', { err: String(err) });
  }
  return out;
}
