import { randomBytes } from 'node:crypto';
import type { Merchant, MerchantAccount, Prisma } from '@prisma/client';
import bs58 from 'bs58';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryMailer } from '../test/dashboard.js';
import {
  createCredential,
  createMerchant,
  createRow,
  createUser,
  resetDb,
} from '../test/helpers.js';
import {
  enqueueReconciles,
  keyFingerprint,
  onProposalCreated,
  onProposalExecuted,
  onSignersChanged,
  onRecoveryStarted,
  onTimelockStarted,
  RECONCILE_ACCOUNT_JOB,
  RECOVERY_SOON_JOB,
  sendRecoveryExecutesSoon,
  setAccountJobs,
  setDelayedJobs,
  summarizeAction,
  processAccountJob,
  EXECUTE_TIMELOCKS_JOB,
} from '../jobs/account-notices.js';
import { env, loadEnv } from '../env.js';
import { recordEvent } from '../events/record.js';
import { accountView } from './accounts.js';
import { STORAGE_LOW_EVENT, STORAGE_LOW_THRESHOLD_YOCTO, YOCTO_PER_BYTE } from './storage.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients, type SignerKeyJson } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import type { ConfigView } from './accounts.js';
import { proposalId as computeProposalId, type ActionJson } from './encoding.js';
import { eventLog, type AccountEvent } from './events.js';
import type { ContractProposalView } from './proposals.js';
import {
  applyAccountEvents,
  executeReadyRecovery,
  executeReadyTimelocks,
  parseAccountEvents,
  reconcileAccount,
  settleExpiredProposals,
  type RecoveryView,
  type SavedAddressView,
  type SettlementView,
} from './watcher.js';

/** A prior `funding.spent` of `amount` in live mode (another account), for the daily cap. */
const recordEventForTest = (tx: Prisma.TransactionClient, merchantId: string, amount: bigint) =>
  recordEvent(
    tx,
    { merchantId, livemode: true },
    {
      aggregateType: 'near_account',
      aggregateId: 'other.tendr.near',
      type: 'funding.spent',
      payload: { accountId: 'other.tendr.near', amountYocto: amount.toString() },
    },
  );

const HOUR = 3_600_000;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const ev = (event: AccountEvent['event'], data: Record<string, unknown>): AccountEvent => ({
  event,
  version: '1.0.0',
  data,
});

interface Signer {
  userId: string;
  email: string;
  credentialRowId: string;
  key: SignerKeyJson;
}

interface ChainState {
  config: ConfigView;
  proposals: ContractProposalView[];
  recovery: RecoveryView | null;
  saved: SavedAddressView[];
  settlement: SettlementView | null;
}

describe('chain watcher', () => {
  let fake: FakeNearClient;
  let merchant: Merchant;
  let account: MerchantAccount;
  let chain: ChainState;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const ctx = () => ({ merchantId: merchant.id, livemode: true });

  beforeEach(async () => {
    await resetDb();
    resetNearClients();
    memoryMailer().clear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fake = fakeNearClient(true);
    merchant = await createMerchant();
    account = (await createRow('MerchantAccount', merchant.id, true, {
      nearAccountId: `${merchant.slug}.tendr.near`,
      status: 'active',
      threshold: 2,
      signerEpoch: 0n,
    })) as unknown as MerchantAccount;
    chain = {
      config: {
        signers: [],
        threshold: 2,
        signer_epoch: '0',
        origins: ['http://localhost:3000'],
        rp_id: 'localhost',
        recovery_key_set: true,
        recovery_key_epoch: '0',
        intents_contract: 'intents.near',
        poa_suffix: 'omft.near',
      },
      proposals: [],
      recovery: null,
      saved: [],
      settlement: null,
    };
    const c = account.nearAccountId;
    fake.scriptView(c, 'get_config', () => structuredClone(chain.config));
    fake.scriptView(c, 'list_proposals', (args) => {
      const { from_index, limit } = args as { from_index: number; limit: number };
      return structuredClone(chain.proposals.slice(from_index, from_index + limit));
    });
    fake.scriptView(c, 'get_proposal', (args) => {
      const v = chain.proposals.find((p) => p.id === (args as { id: string }).id);
      return v ? structuredClone(v) : null;
    });
    fake.scriptView(c, 'get_recovery', () => structuredClone(chain.recovery));
    fake.scriptView(c, 'list_saved_addresses', () => structuredClone(chain.saved));
    fake.scriptView(c, 'get_settlement', () => structuredClone(chain.settlement));
    fake.scriptView(c, 'get_limits', () => ({
      per_tx: null,
      per_day: null,
      refund_cap: '0',
      pending_raise: null,
      spent_24h: '0',
      refunded_24h: '0',
    }));
    fake.scriptView(c, 'get_auto_sweep', () => null);
  });
  afterEach(() => {
    setDelayedJobs(null);
    logSpy.mockRestore();
    resetNearClients();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function signer(isSigner = true): Promise<Signer> {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const cred = await createCredential(user.id);
    await createRow('MerchantUser', merchant.id, false, {
      userId: user.id,
      role: 'owner',
      isSigner,
    });
    return {
      userId: user.id,
      email: user.email,
      credentialRowId: cred.id,
      key: cred.publicKey as SignerKeyJson,
    };
  }

  const keyId = (k: SignerKeyJson) => ('p256' in k ? `p256:${k.p256}` : `ed25519:${k.ed25519}`);

  async function mirrorKey(s: Signer) {
    return createRow('AccountKey', merchant.id, true, {
      nearAccountId: account.nearAccountId,
      publicKey: keyId(s.key),
      kind: 'passkey',
      userId: s.userId,
      credentialId: s.credentialRowId,
    });
  }

  const swapWithdraw = (depositAccount: string, savedId = 'sav-1'): ActionJson => ({
    withdraw: {
      asset: 'nep141:usdc.near',
      amount: '1200000000',
      saved_address_id: savedId,
      route: { swap: { deposit_account: depositAccount } },
    },
  });

  async function proposalRow(action: ActionJson, overrides: Record<string, unknown> = {}) {
    const salt = randomBytes(32);
    const creator = await createUser();
    return prisma.accountProposal.create({
      data: {
        id: newId('prop'),
        merchantId: merchant.id,
        livemode: true,
        accountId: account.id,
        onchainId: computeProposalId(action, salt),
        kind: Object.keys(action)[0] as 'withdraw',
        action: action as object,
        salt: salt.toString('base64'),
        status: 'pending',
        createdByUserId: creator.id,
        ...overrides,
      },
    });
  }

  const eventsOf = (type: string) =>
    prisma.event.findMany({
      where: { merchantId: merchant.id, type },
      orderBy: { createdAt: 'asc' },
    });

  it('parse_ignores_foreign_standard_logs', () => {
    const logs = [
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"amount":"1"}]}',
      'EVENT_JSON:{"standard":"nep171","version":"1.0.0","event":"proposal_created","data":{"proposal_id":"aa"}}',
      'Transfer 1 from a to b',
      eventLog('proposal_cancelled', { proposal_id: 'ab'.repeat(32), signer_id: 'per_x' }),
    ];
    expect(parseAccountEvents(logs).map((e) => e.event)).toEqual(['proposal_cancelled']);
  });

  it('apply_is_idempotent_on_replay', async () => {
    const a = await signer();
    const action = swapWithdraw('swap-1.near');
    const row = await proposalRow(action, { status: 'draft' });
    const readyMs = Date.now() + 24 * HOUR;
    const events = [
      ev('proposal_created', {
        proposal_id: row.onchainId,
        signer_id: a.userId,
        action,
        expires_at: ns(Date.now() + 7 * 24 * HOUR),
      }),
      ev('proposal_approved', {
        proposal_id: row.onchainId,
        signer_id: a.userId,
        signer_epoch: '0',
        approvals: 2,
        threshold: 2,
      }),
      ev('timelock_started', { proposal_id: row.onchainId, action, ready_at: ns(readyMs) }),
    ];
    await applyAccountEvents(ctx(), account.id, events, { txHash: 'tx1' });
    const outboxAfterFirst = await prisma.eventOutbox.count();
    await applyAccountEvents(ctx(), account.id, events, { txHash: 'tx1' });
    await applyAccountEvents(ctx(), account.id, events.slice(1), { txHash: 'tx1' });

    const after = await prisma.accountProposal.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('timelocked');
    expect(after.readyAt?.getTime()).toBe(readyMs);
    for (const type of [
      'account.proposal.created',
      'account.proposal.approved',
      'account.proposal.timelocked',
    ]) {
      expect(await eventsOf(type), type).toHaveLength(1);
    }
    expect(await prisma.eventOutbox.count()).toBe(outboxAfterFirst);
  });

  it('signer_removed_onchain_updates_mirror', async () => {
    const a = await signer();
    const b = await signer();
    const keyA = await mirrorKey(a);
    const keyB = await mirrorKey(b);
    chain.config = {
      ...chain.config,
      signers: [{ id: a.userId, keys: [a.key] }],
      threshold: 1,
      signer_epoch: '1',
    };
    const removal = ev('signers_changed', {
      proposal_id: 'cd'.repeat(32),
      signer_ids: [a.userId],
      threshold: 1,
      signer_epoch: '1',
      recovery_key_set: true,
    });
    await applyAccountEvents(ctx(), account.id, [removal]);
    await applyAccountEvents(ctx(), account.id, [removal]);

    const members = await prisma.merchantUser.findMany({ where: { merchantId: merchant.id } });
    expect(members.find((m) => m.userId === a.userId)?.isSigner).toBe(true);
    expect(members.find((m) => m.userId === b.userId)?.isSigner).toBe(false);
    const acct = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acct).toMatchObject({ threshold: 1, signerEpoch: 1n });
    expect(
      (await prisma.accountKey.findUniqueOrThrow({ where: { id: keyB.id } })).revokedAt,
    ).not.toBeNull();
    expect(
      (await prisma.accountKey.findUniqueOrThrow({ where: { id: keyA.id } })).revokedAt,
    ).toBeNull();
    const changed = await eventsOf('account.signers.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ livemode: true });
    expect(changed[0]!.payload).toMatchObject({ signerIds: [a.userId], threshold: 1 });
  });

  it('a signer added on chain gets its passkey mirrored against its own credential', async () => {
    const a = await signer();
    const c = await signer(false);
    chain.config = {
      ...chain.config,
      signers: [
        { id: a.userId, keys: [a.key] },
        { id: c.userId, keys: [c.key] },
      ],
      signer_epoch: '1',
    };
    await reconcileAccount(merchant.id, true);
    const keys = await prisma.accountKey.findMany({
      where: { merchantId: merchant.id, kind: 'passkey', revokedAt: null },
    });
    expect(keys.map((k) => [k.userId, k.credentialId]).sort()).toEqual(
      [
        [a.userId, a.credentialRowId],
        [c.userId, c.credentialRowId],
      ].sort(),
    );
    const cm = await prisma.merchantUser.findFirstOrThrow({ where: { userId: c.userId } });
    expect(cm.isSigner).toBe(true);
  });

  it('live signer changes mirror onto the test contract; test-mode changes do not', async () => {
    const a = await signer();
    chain.config = { ...chain.config, signers: [{ id: a.userId, keys: [a.key] }], threshold: 1 };
    const test = (await createRow('MerchantAccount', merchant.id, false, {
      nearAccountId: `${merchant.slug}.tendr.testnet`,
      status: 'active',
      threshold: 1,
    })) as unknown as MerchantAccount;
    const testFake = fakeNearClient(false);
    let testConfig: ConfigView = { ...chain.config, signers: [], signer_epoch: '0' };
    testFake.scriptView(test.nearAccountId, 'get_config', () => structuredClone(testConfig));
    testFake.scriptLogs(test.nearAccountId, 'admin_sync_signers', () => {
      testConfig = { ...chain.config, signer_epoch: '1' };
      return [];
    });

    await applyAccountEvents(ctx(), account.id, [
      ev('signers_changed', {
        proposal_id: null,
        signer_ids: [a.userId],
        threshold: 1,
        signer_epoch: '0',
        recovery_key_set: true,
      }),
    ]);
    const [live] = await eventsOf('account.signers.changed');
    await onSignersChanged(live!);
    expect(testFake.callsTo('admin_sync_signers')).toHaveLength(1);

    await onSignersChanged({ ...live!, livemode: false });
    expect(testFake.callsTo('admin_sync_signers')).toHaveLength(1);
  });

  it('reconcile_catches_proposal_created_outside_relayer', async () => {
    const a = await signer();
    await signer();
    const action = swapWithdraw('swap-1.near');
    const id = computeProposalId(action, randomBytes(32));
    chain.proposals = [
      {
        id,
        action,
        creator: a.userId,
        created_at: ns(Date.now() - HOUR),
        expires_at: ns(Date.now() + 6 * 24 * HOUR),
        approvals: [{ signer_id: a.userId, key: a.key, signer_epoch: '0' }],
        valid_approvals: 1,
        ready_at: null,
        status: 'pending',
      },
    ];
    expect(await reconcileAccount(merchant.id, true)).toBe(true);
    const row = await prisma.accountProposal.findFirstOrThrow({ where: { onchainId: id } });
    expect(row).toMatchObject({ status: 'pending', kind: 'withdraw', createdByUserId: a.userId });
    expect(row.action).toEqual(action);
    expect(await prisma.accountApproval.findMany({ where: { proposalId: row.id } })).toMatchObject([
      { userId: a.userId, credentialId: a.credentialRowId, signerEpoch: 0n },
    ]);
    expect(await eventsOf('account.proposal.created')).toHaveLength(1);
    expect(
      (await prisma.merchantAccount.findUniqueOrThrow({ where: { id: account.id } })).proposalsSeen,
    ).toBe(1);

    // It then executes on chain, also outside the relayer; a second run catches that too.
    chain.proposals[0]!.status = 'executed';
    await reconcileAccount(merchant.id, true);
    expect((await prisma.accountProposal.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'executed',
    );
    expect(await eventsOf('account.proposal.created')).toHaveLength(1);
    expect(await eventsOf('account.proposal.executed')).toHaveLength(1);
  });

  it('reconcile settles drafts left behind by a stale relay claim (R24)', async () => {
    const a = await signer();
    const onChain = await proposalRow(swapWithdraw('swap-1.near'), {
      status: 'draft',
      relayClaimedAt: new Date(Date.now() - 3 * 60_000),
    });
    const lost = await proposalRow(swapWithdraw('swap-2.near'), {
      status: 'draft',
      relayClaimedAt: new Date(Date.now() - 3 * 60_000),
    });
    const fresh = await proposalRow(swapWithdraw('swap-3.near'), {
      status: 'draft',
      relayClaimedAt: new Date(),
    });
    chain.proposals = [
      {
        id: onChain.onchainId,
        action: onChain.action,
        creator: a.userId,
        created_at: ns(Date.now() - 5 * 60_000),
        expires_at: ns(Date.now() + 6 * 24 * HOUR),
        approvals: [{ signer_id: a.userId, key: a.key, signer_epoch: '0' }],
        valid_approvals: 1,
        ready_at: null,
        status: 'pending',
      },
    ];
    // Already listed earlier, so only the by-id lookup can find it.
    await prisma.merchantAccount.update({ where: { id: account.id }, data: { proposalsSeen: 1 } });
    await reconcileAccount(merchant.id, true);
    expect(
      await prisma.accountProposal.findUniqueOrThrow({ where: { id: onChain.id } }),
    ).toMatchObject({ status: 'pending', relayClaimedAt: null });
    expect(
      await prisma.accountProposal.findUniqueOrThrow({ where: { id: lost.id } }),
    ).toMatchObject({
      status: 'draft',
      relayClaimedAt: null,
    });
    // A live claim is left alone.
    expect(
      (await prisma.accountProposal.findUniqueOrThrow({ where: { id: fresh.id } })).relayClaimedAt,
    ).not.toBeNull();
  });

  it('reconcile mirrors saved addresses (chain active_from), settlement and removals', async () => {
    const activeFromMs = Date.now() + 20 * HOUR;
    chain.saved = [
      { id: 'sav-1', chain: 'base', address: '0xabc', active_from: ns(Date.now() - HOUR) },
      { id: 'sav-2', chain: 'eth', address: '0xdef', active_from: ns(activeFromMs) },
    ];
    chain.settlement = {
      dest_asset: 'nep141:usdc.near',
      payout_mode: 'wallet',
      saved_address_id: 'sav-1',
    };
    await reconcileAccount(merchant.id, true);
    const rows = await prisma.payoutAllowlistEntry.findMany({
      where: { merchantId: merchant.id },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['sav-1', 'active'],
      ['sav-2', 'pending'],
    ]);
    expect(rows[1]!.activeFrom.getTime()).toBe(activeFromMs);
    expect(
      await prisma.settlementConfig.findFirstOrThrow({ where: { merchantId: merchant.id } }),
    ).toMatchObject({
      livemode: true,
      isDefault: true,
      destAssetId: 'nep141:usdc.near',
      payoutMode: 'wallet',
      destChain: 'base',
      payoutAddress: '0xabc',
    });

    chain.saved = [chain.saved[1]!];
    await reconcileAccount(merchant.id, true);
    await reconcileAccount(merchant.id, true);
    expect(
      (await prisma.payoutAllowlistEntry.findUniqueOrThrow({ where: { id: 'sav-1' } })).status,
    ).toBe('revoked');
    expect(await eventsOf('account.saved_address.added')).toHaveLength(2);
    expect(await eventsOf('account.saved_address.removed')).toHaveLength(1);
    expect(await eventsOf('account.settlement.changed')).toHaveLength(1);
  });

  it('settlement_changed writes the settlement_configs mirror', async () => {
    await applyAccountEvents(ctx(), account.id, [
      ev('settlement_changed', {
        proposal_id: 'ef'.repeat(32),
        dest_asset: 'nep141:usdt.near',
        payout_mode: 'intents',
        saved_address_id: null,
      }),
    ]);
    expect(
      await prisma.settlementConfig.findFirstOrThrow({ where: { merchantId: merchant.id } }),
    ).toMatchObject({
      destAssetId: 'nep141:usdt.near',
      payoutMode: 'intents',
      destChain: 'near',
      nearAccount: account.nearAccountId,
    });
  });

  it('timelock_notice_uses_onchain_action_not_draft', async () => {
    const a = await signer();
    const b = await signer();
    await signer(false);
    chain.saved = [
      { id: 'sav-1', chain: 'base', address: '0xsaved', active_from: ns(Date.now() - 30 * HOUR) },
    ];
    // The row (what the website sent) says A; the chain's own event says B.
    const draft = swapWithdraw('attacker-a.near');
    const onChain = swapWithdraw('real-b.near');
    const row = await proposalRow(draft);
    const readyMs = Date.now() + 24 * HOUR;
    await applyAccountEvents(ctx(), account.id, [
      ev('timelock_started', {
        proposal_id: row.onchainId,
        action: onChain,
        ready_at: ns(readyMs),
      }),
    ]);
    const [event] = await eventsOf('account.proposal.timelocked');
    await onTimelockStarted(event!);

    const sent = memoryMailer().sent.filter((m) => m.template === 'timelock_started');
    expect(sent.map((m) => m.to).sort()).toEqual([a.email, b.email].sort());
    const data = sent[0]!.data;
    expect(data).toMatchObject({
      destination: 'real-b.near',
      destinationChain: 'near',
      asset: 'nep141:usdc.near',
      amount: '1200000000',
      readyAt: new Date(readyMs).toISOString(),
      cancelUrl: new URL(`/dashboard/approvals/${row.id}`, env().WEB_URL).toString(),
    });
    expect(JSON.stringify(sent)).not.toContain('attacker-a.near');
  });

  it('a refund notice names the refund destination and chain from the chain', async () => {
    await signer();
    const refund: ActionJson = {
      refund: {
        asset: 'nep141:usdc.near',
        amount: '5000000',
        destination_chain: 'eth',
        destination: '0xshopper',
        payment_id: 'pay_1',
        route: { swap: { deposit_account: 'swap-dep.near' } },
      },
    };
    const row = await proposalRow({
      ...refund,
      refund: { ...refund.refund, destination: '0xother' },
    } as ActionJson);
    await applyAccountEvents(ctx(), account.id, [
      ev('timelock_started', {
        proposal_id: row.onchainId,
        action: refund,
        ready_at: ns(Date.now()),
      }),
    ]);
    const [event] = await eventsOf('account.proposal.timelocked');
    await onTimelockStarted(event!);
    const [mail] = memoryMailer().sent;
    expect(mail!.data).toMatchObject({ destination: '0xshopper', destinationChain: 'eth' });
    expect(mail!.data.summary).toContain('swap-dep.near');
  });

  it('recovery_soon_notice_scheduled_24h_before', async () => {
    const a = await signer();
    const added: { name: string; data: object; opts: { delay?: number; jobId: string } }[] = [];
    setDelayedJobs({ add: async (name, data, opts) => added.push({ name, data, opts }) });
    const executesMs = Date.now() + 72 * HOUR;
    const started = ev('recovery_started', {
      recovery_id: 'ab'.repeat(32),
      nonce: '1',
      recovery_key_epoch: '0',
      new_signer_ids: [a.userId],
      new_threshold: 1,
      executes_at: ns(executesMs),
    });
    await applyAccountEvents(ctx(), account.id, [started], { txHash: 'tx-start' });
    await applyAccountEvents(ctx(), account.id, [started], { txHash: 'tx-start' });
    const rec = await prisma.recoveryRequest.findFirstOrThrow({
      where: { merchantId: merchant.id },
    });
    expect(rec).toMatchObject({ status: 'pending', newThreshold: 1, nonce: 1n });
    expect(rec.executesAt.getTime()).toBe(executesMs);
    const [event, ...more] = await eventsOf('account.recovery.started');
    expect(more).toHaveLength(0);

    const before = Date.now();
    await onRecoveryStarted(event!);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: RECOVERY_SOON_JOB,
      data: { recoveryId: rec.id },
      opts: { jobId: `recovery-soon__${rec.id}` },
    });
    const due = executesMs - 24 * HOUR;
    expect(added[0]!.opts.delay).toBeLessThanOrEqual(due - before);
    expect(added[0]!.opts.delay).toBeGreaterThan(due - before - 5_000);
    expect(memoryMailer().sent.map((m) => [m.to, m.template])).toEqual([
      [a.email, 'recovery_started'],
    ]);

    expect(await sendRecoveryExecutesSoon(rec.id)).toBe(true);
    expect(memoryMailer().sent.at(-1)).toMatchObject({ template: 'recovery_executes_soon' });
    await applyAccountEvents(ctx(), account.id, [
      ev('recovery_cancelled', { signer_id: a.userId }),
    ]);
    expect(await sendRecoveryExecutesSoon(rec.id)).toBe(false);
    expect((await prisma.recoveryRequest.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe(
      'cancelled',
    );
  });

  it('ready_timelock_executed_by_job', async () => {
    const action = swapWithdraw('swap-1.near');
    const ready = await proposalRow(action, {
      status: 'timelocked',
      readyAt: new Date(Date.now() - 60_000),
    });
    const notYet = await proposalRow(swapWithdraw('swap-2.near'), {
      status: 'timelocked',
      readyAt: new Date(Date.now() + HOUR),
    });
    fake.scriptLogs(account.nearAccountId, 'execute', (args) => [
      eventLog('proposal_executed', {
        proposal_id: (args as { proposal_id: string }).proposal_id,
        action,
      }),
    ]);
    expect(await executeReadyTimelocks()).toBe(1);
    expect(fake.callsTo('execute').map((c) => (c as { args: object }).args)).toEqual([
      { proposal_id: ready.onchainId },
    ]);
    expect(
      await prisma.accountProposal.findUniqueOrThrow({ where: { id: ready.id } }),
    ).toMatchObject({ status: 'executed' });
    expect(
      (await prisma.accountProposal.findUniqueOrThrow({ where: { id: notYet.id } })).status,
    ).toBe('timelocked');
    expect(await eventsOf('account.proposal.executed')).toHaveLength(1);
  });

  // ─── final review fixes ────────────────────────────────────────────────────

  it('expired proposals are settled on chain by the executor job, freeing the slot (I3)', async () => {
    const action: ActionJson = { set_threshold: 2 };
    const pending = await proposalRow(action, { status: 'pending' });
    // The chain's view reports it expired (past its TTL) while it still holds the slot.
    chain.proposals = [
      {
        id: pending.onchainId,
        action,
        creator: pending.createdByUserId!,
        created_at: ns(Date.now() - 8 * 24 * HOUR),
        expires_at: ns(Date.now() - 24 * HOUR),
        approvals: [],
        valid_approvals: 0,
        ready_at: null,
        status: 'expired',
      } as unknown as ContractProposalView,
    ];
    await reconcileAccount(merchant.id, true);
    expect(
      await prisma.accountProposal.findUniqueOrThrow({ where: { id: pending.id } }),
    ).toMatchObject({ status: 'expired', expirySettledAt: null });

    fake.scriptLogs(account.nearAccountId, 'execute', (args) => [
      eventLog('proposal_failed', {
        proposal_id: (args as { proposal_id: string }).proposal_id,
        reason: 'expired',
      }),
    ]);
    await processAccountJob(EXECUTE_TIMELOCKS_JOB, {});
    expect(fake.callsTo('execute').map((c) => (c as { args: object }).args)).toEqual([
      { proposal_id: pending.onchainId },
    ]);
    const settled = await prisma.accountProposal.findUniqueOrThrow({ where: { id: pending.id } });
    expect(settled.status).toBe('expired');
    expect(settled.expirySettledAt).not.toBeNull();
    expect(await eventsOf('account.proposal.failed')).toHaveLength(1);
    // Settled once: the next run does not call it again.
    expect(await settleExpiredProposals()).toBe(0);
    expect(fake.callsTo('execute')).toHaveLength(1);
  });

  it('an expired proposal the chain already finished is marked settled; other refusals retry', async () => {
    const done = await proposalRow({ set_threshold: 2 }, { status: 'expired' });
    fake.failNext('execute', 'Smart contract panicked: proposal is not pending');
    expect(await settleExpiredProposals()).toBe(1);
    expect(
      (await prisma.accountProposal.findUniqueOrThrow({ where: { id: done.id } })).expirySettledAt,
    ).not.toBeNull();

    const later = await proposalRow({ set_threshold: 1 }, { status: 'expired' });
    fake.failNext('execute', 'Exceeded the prepaid gas');
    expect(await settleExpiredProposals()).toBe(0);
    expect(
      (await prisma.accountProposal.findUniqueOrThrow({ where: { id: later.id } })).expirySettledAt,
    ).toBeNull();
    fake.scriptLogs(account.nearAccountId, 'execute', [
      eventLog('proposal_failed', { proposal_id: later.onchainId, reason: 'expired' }),
    ]);
    expect(await settleExpiredProposals()).toBe(1);
  });

  describe('storage top-ups (R35)', () => {
    const NEAR = 10n ** 24n;
    const provision = () =>
      fake.provisionAccount({
        merchantId: merchant.id,
        livemode: true,
        accountId: account.nearAccountId,
        init: {
          signers: [],
          threshold: 1,
          recovery_key: null,
          rp_id: 'localhost',
          origins: ['http://localhost:3000'],
          intents_contract: env().INTENTS_CONTRACT_LIVE,
          poa_suffix: null,
          testnet_admin: null,
        },
        initialBalanceYocto: NEAR / 2n,
      });
    /** Storage that leaves `free` yocto of a 0.5 NEAR balance. */
    const leaveFree = (free: bigint) =>
      fake.scriptAccountState(account.nearAccountId, {
        storageUsageBytes: (NEAR / 2n - free) / YOCTO_PER_BYTE,
      });
    const topUps = () => fake.calls.filter((c) => c.kind === 'topup');
    const storageLowAt = async () =>
      (await prisma.merchantAccount.findUniqueOrThrow({ where: { id: account.id } })).storageLowAt;

    it('nothing happens while the free balance covers 50 more proposals', async () => {
      await provision();
      leaveFree(STORAGE_LOW_THRESHOLD_YOCTO);
      await reconcileAccount(merchant.id, true);
      expect(topUps()).toHaveLength(0);
    });

    it('a low account is topped up once from funding-near (funding.topup, capped)', async () => {
      await provision();
      leaveFree(STORAGE_LOW_THRESHOLD_YOCTO - YOCTO_PER_BYTE);
      await reconcileAccount(merchant.id, true);
      expect(topUps()).toEqual([
        {
          kind: 'topup',
          accountId: account.nearAccountId,
          amountYocto: env().MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO,
        },
      ]);
      const [ev] = await prisma.event.findMany({ where: { type: 'funding.topup' } });
      expect(ev).toMatchObject({ merchantId: merchant.id, livemode: true });
      expect(fake.accounts.get(account.nearAccountId)!.balanceYocto).toBe(
        NEAR / 2n + env().MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO,
      );
      // Still low by storage (scripted) but inside the cooldown: no second top-up.
      fake.scriptAccountState(account.nearAccountId, { storageUsageBytes: 10n ** 6n });
      await reconcileAccount(merchant.id, true);
      expect(topUps()).toHaveLength(1);
      expect(await storageLowAt()).toBeNull();
    });

    it('a top-up blocked by the daily cap flags the account and the dashboard; recovery clears it', async () => {
      await provision();
      // The mode's whole daily cap is already spent.
      await prisma.$transaction((tx) =>
        recordEventForTest(tx, merchant.id, env().FUNDING_DAILY_CAP_YOCTO),
      );
      leaveFree(0n);
      await reconcileAccount(merchant.id, true);
      expect(topUps()).toHaveLength(0);
      expect(await storageLowAt()).not.toBeNull();
      const [low] = await eventsOf(STORAGE_LOW_EVENT);
      expect(low).toMatchObject({ aggregateId: account.id });
      const view = await accountView(ctx());
      expect(view.account?.storageLowAt).not.toBeNull();
      // Recorded once while it stays blocked.
      await reconcileAccount(merchant.id, true);
      expect(await eventsOf(STORAGE_LOW_EVENT)).toHaveLength(1);

      // Funded out of band: the flag clears.
      leaveFree(NEAR / 2n);
      await reconcileAccount(merchant.id, true);
      expect(await storageLowAt()).toBeNull();
    });
  });

  it('upgrade notices name the code hash in base58 and whether it is the Tendr release (I4)', async () => {
    const hash = Buffer.alloc(32, 9);
    const acct = { livemode: true, nearAccountId: account.nearAccountId, merchantId: merchant.id };
    const action: ActionJson = { upgrade: { code_hash: hash.toString('base64') } };
    try {
      loadEnv({ ...process.env, MERCHANT_ACCOUNT_CODE_HASH_LIVE: bs58.encode(hash) });
      const ok = await summarizeAction(action, acct);
      expect(ok.fields).toMatchObject({
        codeHash: bs58.encode(hash),
        codeHashIsTendrRelease: 'yes',
      });
      expect(ok.summary).toContain('matches the Tendr release');
      // The test mode's release is a different setting.
      const test = await summarizeAction(action, { ...acct, livemode: false });
      expect(test.fields.codeHashIsTendrRelease).toBe('no');
      expect(test.summary).toContain('NOT a Tendr release');
    } finally {
      loadEnv(process.env);
    }
  });

  it('notices say widening security changes take effect 24 h after approval (R34)', async () => {
    const a = await signer();
    const acct = {
      livemode: true,
      nearAccountId: account.nearAccountId,
      merchantId: merchant.id,
      threshold: 2,
    };
    const delayed: ActionJson[] = [
      { add_signer: { id: a.userId, keys: [a.key] } },
      { add_signer_key: { id: a.userId, key: a.key } },
      { rotate_recovery_key: Buffer.alloc(32, 7).toString('base64') },
      { rotate_recovery_key: null },
      { set_origins: ['https://usetendr.tech'] },
      { set_threshold: 1 },
    ];
    for (const action of delayed) {
      const sum = await summarizeAction(action, acct);
      expect(sum.summary, sum.kind).toContain('takes effect 24 h after approval');
    }
    for (const action of [
      { set_threshold: 2 },
      { remove_signer: { id: a.userId } },
      { remove_signer_key: { id: a.userId, key: a.key } },
    ] as ActionJson[]) {
      const sum = await summarizeAction(action, acct);
      expect(sum.summary, sum.kind).not.toContain('24 h');
    }
  });

  it('a ready recovery is executed by the job and mirrors the new signers', async () => {
    const a = await signer();
    const b = await signer();
    const rec = await createRow('RecoveryRequest', merchant.id, true, {
      onchainId: 'ab'.repeat(32),
      executesAt: new Date(Date.now() - 60_000),
      newSignerIds: [a.userId],
      newThreshold: 1,
    });
    chain.config = {
      ...chain.config,
      signers: [{ id: a.userId, keys: [a.key] }],
      threshold: 1,
      signer_epoch: '1',
    };
    fake.scriptLogs(account.nearAccountId, 'execute_recovery', [
      eventLog('recovery_executed', {
        new_signer_ids: [a.userId],
        new_threshold: 1,
        signer_epoch: '1',
      }),
      eventLog('signers_changed', {
        proposal_id: null,
        signer_ids: [a.userId],
        threshold: 1,
        signer_epoch: '1',
        recovery_key_set: true,
      }),
    ]);
    expect(await executeReadyRecovery()).toBe(1);
    expect((await prisma.recoveryRequest.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe(
      'executed',
    );
    expect(
      (await prisma.merchantUser.findFirstOrThrow({ where: { userId: b.userId } })).isSigner,
    ).toBe(false);
    expect(await eventsOf('account.recovery.executed')).toHaveLength(1);
    expect(await eventsOf('account.signers.changed')).toHaveLength(1);
  });

  it('reconcile notices a recovery started and cancelled outside the relayer', async () => {
    const a = await signer();
    chain.recovery = {
      recovery_id: 'cd'.repeat(32),
      nonce: '4',
      recovery_key_epoch: '0',
      new_signer_ids: [a.userId],
      new_threshold: 1,
      executes_at: ns(Date.now() + 72 * HOUR),
    };
    await reconcileAccount(merchant.id, true);
    expect(
      await prisma.recoveryRequest.findFirstOrThrow({ where: { merchantId: merchant.id } }),
    ).toMatchObject({ status: 'pending', onchainId: 'cd'.repeat(32), nonce: 4n });
    expect(await eventsOf('account.recovery.started')).toHaveLength(1);

    chain.recovery = null;
    await reconcileAccount(merchant.id, true);
    expect(
      (await prisma.recoveryRequest.findFirstOrThrow({ where: { merchantId: merchant.id } }))
        .status,
    ).toBe('cancelled');
    expect(await eventsOf('account.recovery.cancelled')).toHaveLength(1);
  });

  it('an executed rotate_recovery_key replaces the mirrored recovery key once', async () => {
    const old = await createRow('AccountKey', merchant.id, true, {
      nearAccountId: account.nearAccountId,
      publicKey: `ed25519:${Buffer.alloc(32, 1).toString('base64')}`,
      kind: 'recovery',
    });
    const next = Buffer.alloc(32, 2).toString('base64');
    const action: ActionJson = { rotate_recovery_key: next };
    const row = await proposalRow(action);
    const executed = ev('proposal_executed', { proposal_id: row.onchainId, action });
    await applyAccountEvents(ctx(), account.id, [executed]);
    await applyAccountEvents(ctx(), account.id, [executed]);
    const keys = await prisma.accountKey.findMany({
      where: { merchantId: merchant.id, kind: 'recovery', revokedAt: null },
    });
    expect(keys.map((k) => k.publicKey)).toEqual([`ed25519:${next}`]);
    expect(
      (await prisma.accountKey.findUniqueOrThrow({ where: { id: old.id } })).revokedAt,
    ).not.toBeNull();
    expect(await eventsOf('account.recovery_key.rotated')).toHaveLength(1);
  });

  // ─── fix round 1 ───────────────────────────────────────────────────────────

  it('notices decode every action variant from the chain (I1)', async () => {
    const a = await signer();
    chain.saved = [
      { id: 'pal_S', chain: 'base', address: '0xsweep', active_from: ns(Date.now() - 30 * HOUR) },
    ];
    const acct = { livemode: true, nearAccountId: account.nearAccountId, merchantId: merchant.id };
    const fp = (b64: string, curve: 'p256' | 'ed25519') =>
      keyFingerprint(curve === 'p256' ? { p256: b64 } : { ed25519: b64 });
    const p256 = (a.key as { p256: string }).p256;
    const rec = Buffer.alloc(32, 7).toString('base64');
    const hash = Buffer.alloc(32, 9);
    const cases: [ActionJson, Record<string, string>][] = [
      [
        { add_signer: { id: a.userId, keys: [a.key] } },
        { signer: `${a.email} (${a.userId})`, keyFingerprints: fp(p256, 'p256') },
      ],
      [{ remove_signer: { id: a.userId } }, { signer: `${a.email} (${a.userId})` }],
      [{ remove_signer_key: { id: a.userId, key: a.key } }, { keyFingerprints: fp(p256, 'p256') }],
      [{ set_threshold: 3 }, { threshold: '3' }],
      [{ set_origins: ['https://usetendr.tech'] }, { origins: 'https://usetendr.tech' }],
      [{ rotate_recovery_key: rec }, { recoveryKeyFingerprint: fp(rec, 'ed25519') }],
      [
        { add_saved_address: { id: 'pal_N', chain: 'eth', address: '0xnew' } },
        { destination: '0xnew', destinationChain: 'eth' },
      ],
      [
        { remove_saved_address: { id: 'pal_S' } },
        { destination: '0xsweep', destinationChain: 'base' },
      ],
      [
        { set_limits: { asset: 'nep141:usdc.near', per_tx: '100', per_day: null } },
        { asset: 'nep141:usdc.near', perTx: '100', perDay: 'unlimited' },
      ],
      [{ set_refund_cap: { asset: 'nep141:usdc.near', daily: '500' } }, { refundCap: '500' }],
      [
        {
          set_auto_sweep: {
            asset: 'nep141:usdc.near',
            trigger_above: '1000',
            keep: '10',
            saved_address_id: 'pal_S',
          },
        },
        { triggerAbove: '1000', keep: '10', destination: '0xsweep', destinationChain: 'base' },
      ],
      [{ clear_auto_sweep: { asset: 'nep141:usdc.near' } }, { asset: 'nep141:usdc.near' }],
      [
        { upgrade: { code_hash: hash.toString('base64') } },
        { codeHash: bs58.encode(hash), codeHashIsTendrRelease: 'no' },
      ],
      [
        {
          set_settlement: {
            dest_asset: 'nep141:usdc.near',
            payout_mode: 'wallet',
            saved_address_id: 'pal_S',
          },
        },
        { payoutMode: 'wallet', destination: '0xsweep', destinationChain: 'base' },
      ],
    ];
    for (const [action, fields] of cases) {
      const sum = await summarizeAction(action, acct);
      expect(sum.fields, sum.kind).toMatchObject(fields);
      expect(sum.summary.length, sum.kind).toBeGreaterThan(sum.kind.length);
    }
  });

  it('an executed remove_signer is also mailed to the removed signer (M3)', async () => {
    const a = await signer();
    const b = await signer(false); // already un-flagged by the change
    const action: ActionJson = { remove_signer: { id: b.userId } };
    const row = await proposalRow(action);
    await applyAccountEvents(ctx(), account.id, [
      ev('proposal_executed', { proposal_id: row.onchainId, action }),
    ]);
    const [event] = await eventsOf('account.proposal.executed');
    await onProposalExecuted(event!);
    expect(
      memoryMailer()
        .sent.filter((m) => m.template === 'proposal_executed')
        .map((m) => m.to)
        .sort(),
    ).toEqual([a.email, b.email].sort());
  });

  it('every on-chain signer change is announced, even A → B → A in one epoch (M2)', async () => {
    const a = await signer();
    const extra = Buffer.concat([Buffer.from([3]), randomBytes(32)]).toString('base64');
    const withKey = {
      ...chain.config,
      signers: [{ id: a.userId, keys: [a.key, { p256: extra }] }],
    };
    const without = { ...chain.config, signers: [{ id: a.userId, keys: [a.key] }] };
    const change = (proposal: string) =>
      ev('signers_changed', {
        proposal_id: proposal.repeat(32),
        signer_ids: [a.userId],
        threshold: 2,
        signer_epoch: '0',
        recovery_key_set: true,
      });
    chain.config = without;
    await applyAccountEvents(ctx(), account.id, [change('a1')]);
    chain.config = withKey;
    await applyAccountEvents(ctx(), account.id, [change('b2')]);
    chain.config = without;
    await applyAccountEvents(ctx(), account.id, [change('c3')]);
    await applyAccountEvents(ctx(), account.id, [change('c3')]); // replay
    expect(await eventsOf('account.signers.changed')).toHaveLength(3);
    // Reconciliation finds nothing new to announce.
    await reconcileAccount(merchant.id, true);
    expect(await eventsOf('account.signers.changed')).toHaveLength(3);
  });

  it('a proposal whose creator is not a known person is still mirrored and notified (I4)', async () => {
    const a = await signer();
    chain.config = { ...chain.config, signers: [{ id: a.userId, keys: [a.key] }] };
    const action = swapWithdraw('swap-1.near');
    const id = computeProposalId(action, randomBytes(32));
    chain.proposals = [
      {
        id,
        action,
        creator: newId('per'),
        created_at: ns(Date.now() - HOUR),
        expires_at: ns(Date.now() + 6 * 24 * HOUR),
        approvals: [],
        valid_approvals: 0,
        ready_at: null,
        status: 'pending',
      },
    ];
    await reconcileAccount(merchant.id, true);
    const row = await prisma.accountProposal.findFirstOrThrow({ where: { onchainId: id } });
    expect(row).toMatchObject({ status: 'pending', createdByUserId: null });
    const [created] = await eventsOf('account.proposal.created');
    await onProposalCreated(created!);
    expect(memoryMailer().sent.map((m) => m.template)).toEqual(['proposal_needs_approval']);
    expect(
      (await prisma.merchantAccount.findUniqueOrThrow({ where: { id: account.id } })).proposalsSeen,
    ).toBe(1);
  });

  it('a saved-address id owned by another store is a recorded conflict, not a failure (I3)', async () => {
    const other = await createMerchant();
    await createRow('PayoutAllowlistEntry', other.id, true, { id: 'pal_TAKEN', chain: 'eth' });
    chain.saved = [
      { id: 'pal_TAKEN', chain: 'base', address: '0xmine', active_from: ns(Date.now() - HOUR) },
      { id: 'pal_OK', chain: 'base', address: '0xok', active_from: ns(Date.now() - HOUR) },
    ];
    await reconcileAccount(merchant.id, true);
    await reconcileAccount(merchant.id, true);
    expect(
      (await prisma.payoutAllowlistEntry.findMany({ where: { merchantId: merchant.id } })).map(
        (r) => r.id,
      ),
    ).toEqual(['pal_OK']);
    expect(
      (await prisma.payoutAllowlistEntry.findUniqueOrThrow({ where: { id: 'pal_TAKEN' } }))
        .merchantId,
    ).toBe(other.id);
    const conflicts = await eventsOf('merchant_account.mirror_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.payload).toMatchObject({ id: 'pal_TAKEN' });
  });

  it('reconciliation fans out one job per active account per tick (I5)', async () => {
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    const other = await createMerchant();
    await createRow('MerchantAccount', other.id, true, { status: 'provisioning' });
    const added: { name: string; jobId: string }[] = [];
    setAccountJobs({ add: async (name, _d, opts) => added.push({ name, jobId: opts.jobId }) });
    const now = Date.now();
    expect(await enqueueReconciles(now)).toBe(2);
    expect(await enqueueReconciles(now + 1)).toBe(2);
    expect(added.every((j) => j.name === RECONCILE_ACCOUNT_JOB)).toBe(true);
    const ids = added.map((j) => j.jobId);
    expect(new Set(ids).size).toBe(2); // same tick → same job ids
    expect(ids).toContain(`reconcile__${account.id}__${Math.floor(now / 60_000)}`);
  });
});
