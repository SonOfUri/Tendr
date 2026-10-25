import { randomBytes } from 'node:crypto';
import type { Merchant, MerchantAccount } from '@prisma/client';
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
  onSignersChanged,
  onRecoveryStarted,
  onTimelockStarted,
  RECOVERY_SOON_JOB,
  sendRecoveryExecutesSoon,
  setDelayedJobs,
} from '../jobs/account-notices.js';
import { env } from '../env.js';
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
  type RecoveryView,
  type SavedAddressView,
  type SettlementView,
} from './watcher.js';

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
    const added: { name: string; data: object; opts: { delay: number; jobId: string } }[] = [];
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
});
