import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import type { Merchant, MerchantAccount } from '@prisma/client';
import type { MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { challengeB64u } from '../accounts/encoding.js';
import { eventLog, parseAccountEvents } from '../accounts/events.js';
import {
  applyProposalEvents,
  RELAY_CLAIM_LEASE_MS,
  RELAY_TIMEOUT_MS,
} from '../accounts/proposals.js';
import { buildApp } from '../app.js';
import { recordSignCount, registrationOptions, verifyRegistration } from '../auth/webauthn.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import { NotBroadcastError } from '../near/rpc.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

type Member = {
  userId: string;
  membershipId: string;
  login: Login;
  auth: SoftAuthenticator;
  credentialRowId: string;
};

const HOUR = 3_600_000;

describe('account proposals', () => {
  let app: FastifyInstance;
  let fake: FakeNearClient;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let merchant: Merchant;
  let account: MerchantAccount;

  beforeEach(async () => {
    await resetDb();
    resetNearClients();
    fake = fakeNearClient(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant();
    account = (await createRow('MerchantAccount', merchant.id, false, {
      status: 'active',
      threshold: 2,
      signerEpoch: 0n,
    })) as unknown as MerchantAccount;
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    resetNearClients();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function member(role: MerchantUserRole, isSigner: boolean): Promise<Member> {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const auth = new SoftAuthenticator();
    const { credential: cred } = await verifyRegistration(
      user,
      auth.create(await registrationOptions(user)),
      null,
    );
    const m = await createRow('MerchantUser', merchant.id, false, {
      userId: user.id,
      role,
      isSigner,
    });
    return {
      userId: user.id,
      membershipId: m.id,
      login: await loginAs(user.id),
      auth,
      credentialRowId: cred.id,
    };
  }

  const h = (m: Member) => dashHeaders(m.login, { merchantId: merchant.id, livemode: false });
  const post = (url: string, m: Member, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: h(m), payload: (payload ?? {}) as object });
  const get = (url: string, m: Member) => app.inject({ method: 'GET', url, headers: h(m) });

  async function savedAddress(opts: { id?: string; activeFrom?: Date } = {}) {
    return createRow('PayoutAllowlistEntry', merchant.id, false, {
      ...(opts.id ? { id: opts.id } : {}),
      chain: 'base',
      address: `0x${randomBytes(20).toString('hex')}`,
      status: 'active',
      activeFrom: opts.activeFrom ?? new Date(Date.now() - 25 * HOUR),
    });
  }

  const withdraw = (savedAddressId: string, amount = '1200000000') => ({
    withdraw: {
      asset: 'nep141:usdc.tendr.testnet',
      amount,
      saved_address_id: savedAddressId,
      route: {
        poa: { token_contract: 'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near' },
      },
    },
  });

  /** Fetches a challenge and has `m`'s authenticator sign it. */
  async function signFor(m: Member, proposalId: string, intent: 'approve' | 'cancel' = 'approve') {
    const res = await post(`/v1/account/proposals/${proposalId}/challenge`, m, { intent });
    expect(res.statusCode, res.body).toBe(200);
    return m.auth.assert(res.json().challengeB64u);
  }

  function scriptCreated(onchainId: string, signerId: string, approvals: number) {
    fake.scriptLogs(account.nearAccountId, 'propose', [
      eventLog('proposal_created', { proposal_id: onchainId, signer_id: signerId }),
      eventLog('proposal_approved', {
        proposal_id: onchainId,
        signer_id: signerId,
        signer_epoch: '0',
        approvals,
        threshold: 2,
      }),
    ]);
  }

  it('draft_stays_offchain_until_signer_approves', async () => {
    const finance = await member('finance', false);
    const sav = await savedAddress();
    const res = await post('/v1/account/proposals', finance, { action: withdraw(sav.id) });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'draft',
      kind: 'withdraw',
      action: withdraw(sav.id),
      createdByUserId: finance.userId,
    });
    expect(body.onchainId).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.calls).toHaveLength(0);
    expect((await get(`/v1/account/proposals/${body.id}`, finance)).json()).toMatchObject({
      id: body.id,
      status: 'draft',
    });
    const list = await get('/v1/account/proposals?status=draft', finance);
    expect(list.json().proposals.map((p: { id: string }) => p.id)).toEqual([body.id]);
    expect((await get('/v1/account/proposals?status=pending', finance)).json().proposals).toEqual(
      [],
    );
  });

  it('viewer_cannot_draft', async () => {
    const viewer = await member('viewer', false);
    const sav = await savedAddress();
    const res = await post('/v1/account/proposals', viewer, { action: withdraw(sav.id) });
    expect(res.statusCode).toBe(403);
    expect(await prisma.accountProposal.count()).toBe(0);
    // Reading is fine.
    expect((await get('/v1/account/proposals', viewer)).statusCode).toBe(200);
  });

  it('security kinds need security:propose; finance cannot draft them', async () => {
    const finance = await member('finance', true);
    const res = await post('/v1/account/proposals', finance, { action: { set_threshold: 1 } });
    expect(res.statusCode).toBe(403);
    const owner = await member('owner', true);
    expect(
      (await post('/v1/account/proposals', owner, { action: { set_threshold: 1 } })).statusCode,
    ).toBe(201);
  });

  it('a stated kind must match the action', async () => {
    const owner = await member('owner', true);
    const res = await post('/v1/account/proposals', owner, {
      kind: 'withdraw',
      action: { set_threshold: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('non_signer_can_draft_but_not_approve', async () => {
    const finance = await member('finance', false);
    const sav = await savedAddress();
    const draft = (
      await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })
    ).json();
    const challenge = await post(`/v1/account/proposals/${draft.id}/challenge`, finance, {});
    expect(challenge.statusCode).toBe(403);
    const signed = finance.auth.assert(
      challengeB64u({
        contractId: account.nearAccountId,
        proposalId: draft.onchainId,
        signerEpoch: 0n,
        intent: 'approve',
      }),
    );
    const approve = await post(`/v1/account/proposals/${draft.id}/approve`, finance, {
      response: signed,
    });
    expect(approve.statusCode).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it('first_approval_calls_propose_then_approve', async () => {
    const finance = await member('finance', false);
    const a = await member('owner', true);
    const b = await member('admin', true);
    const sav = await savedAddress();
    const draft = (
      await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })
    ).json();

    // The challenge is the approval payload hash at the mirrored signer epoch.
    const ch = await post(`/v1/account/proposals/${draft.id}/challenge`, a, {});
    expect(ch.json()).toMatchObject({
      challengeB64u: challengeB64u({
        contractId: account.nearAccountId,
        proposalId: draft.onchainId,
        signerEpoch: 0n,
        intent: 'approve',
      }),
      signerEpoch: '0',
      allowCredentials: [{ id: a.auth.id }],
    });

    scriptCreated(draft.onchainId, a.userId, 1);
    const first = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
      response: a.auth.assert(ch.json().challengeB64u),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: 'pending' });

    const [propose] = fake.callsTo('propose');
    expect(fake.calls.filter((c) => c.kind === 'call')).toHaveLength(1);
    expect(propose).toMatchObject({
      contractId: account.nearAccountId,
      signer: 'relayer-accounts',
    });
    const args = (propose as { args: unknown }).args as {
      action: unknown;
      salt: string;
      approval: {
        signer_id: string;
        key: { p256: string };
        assertion: { authenticator_data: string; client_data_json: string; signature: string };
      };
    };
    expect(args.action).toEqual(withdraw(sav.id));
    expect(Buffer.from(args.salt, 'base64')).toHaveLength(32);
    expect(args.approval.signer_id).toBe(a.userId);
    const stored = await prisma.webauthnCredential.findUniqueOrThrow({
      where: { id: a.credentialRowId },
    });
    expect(args.approval.key).toEqual(stored.publicKey);
    // The relayed signature is raw r‖s, low-s, and verifies as the contract checks it.
    const sig = Buffer.from(args.approval.assertion.signature, 'base64');
    expect(sig).toHaveLength(64);
    expect(p256.Signature.fromCompact(sig).hasHighS()).toBe(false);
    const authData = Buffer.from(args.approval.assertion.authenticator_data, 'base64');
    const msg = Buffer.concat([
      authData,
      sha256(Buffer.from(args.approval.assertion.client_data_json, 'utf8')),
    ]);
    expect(
      p256.verify(sig, sha256(msg), Buffer.from(args.approval.key.p256, 'base64'), {
        prehash: false,
        lowS: true,
      }),
    ).toBe(true);
    expect(JSON.parse(args.approval.assertion.client_data_json)).toMatchObject({
      type: 'webauthn.get',
      challenge: ch.json().challengeB64u,
    });

    // Second signer: `approve`, which reaches the threshold and runs the withdrawal.
    fake.scriptLogs(account.nearAccountId, 'approve', [
      eventLog('proposal_approved', {
        proposal_id: draft.onchainId,
        signer_id: b.userId,
        signer_epoch: '0',
        approvals: 2,
        threshold: 2,
      }),
      eventLog('proposal_executed', { proposal_id: draft.onchainId, action: withdraw(sav.id) }),
    ]);
    const second = await post(`/v1/account/proposals/${draft.id}/approve`, b, {
      response: await signFor(b, draft.id),
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ status: 'executed' });
    const [approve] = fake.callsTo('approve');
    expect((approve as { args: { proposal_id: string } }).args.proposal_id).toBe(draft.onchainId);
    expect(fake.callsTo('propose')).toHaveLength(1);

    const row = await prisma.accountProposal.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('executed');
    expect(row.executedAt).not.toBeNull();
    expect(row.lastTxHash).toBeTruthy();
    const approvals = await prisma.accountApproval.findMany({ where: { proposalId: draft.id } });
    expect(approvals.map((x) => x.userId).sort()).toEqual([a.userId, b.userId].sort());
    expect(approvals.every((x) => x.txHash && x.signerEpoch === 0n)).toBe(true);
  });

  it('a threshold-reaching money approval with no outcome event yet is executing', async () => {
    const a = await member('owner', true);
    const sav = await savedAddress();
    await prisma.merchantAccount.update({ where: { id: account.id }, data: { threshold: 1 } });
    const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
    fake.scriptLogs(account.nearAccountId, 'propose', [
      eventLog('proposal_created', { proposal_id: draft.onchainId, signer_id: a.userId }),
      eventLog('proposal_approved', {
        proposal_id: draft.onchainId,
        signer_id: a.userId,
        signer_epoch: '0',
        approvals: 1,
        threshold: 1,
      }),
    ]);
    // The verifier's transfer receipt failed downstream: `status` is failure, the call landed.
    fake.failDownstreamNext('propose', 'ft_withdraw failed');
    const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
      response: await signFor(a, draft.id),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('executing');
  });

  it('a timelock event marks the proposal timelocked with ready_at', async () => {
    const a = await member('owner', true);
    await prisma.merchantAccount.update({ where: { id: account.id }, data: { threshold: 1 } });
    const draft = (
      await post('/v1/account/proposals', a, {
        action: { set_limits: { asset: 'nep141:usdc.near', per_tx: '10', per_day: null } },
      })
    ).json();
    const readyAtNs = BigInt(Date.UTC(2026, 10, 1)) * 1_000_000n;
    fake.scriptLogs(account.nearAccountId, 'propose', [
      eventLog('proposal_created', { proposal_id: draft.onchainId, signer_id: a.userId }),
      eventLog('proposal_approved', {
        proposal_id: draft.onchainId,
        signer_id: a.userId,
        signer_epoch: '0',
        approvals: 1,
        threshold: 1,
      }),
      eventLog('timelock_started', { proposal_id: draft.onchainId, ready_at: String(readyAtNs) }),
    ]);
    const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
      response: await signFor(a, draft.id),
    });
    expect(res.json()).toMatchObject({ status: 'timelocked' });
    const row = await prisma.accountProposal.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.readyAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('local_validation_rejects_unsaved_address_withdraw', async () => {
    const owner = await member('owner', true);
    const unknown = await post('/v1/account/proposals', owner, {
      action: withdraw('pal_UNKNOWN'),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toMatch(/saved address/i);

    const fresh = await savedAddress({ activeFrom: new Date(Date.now() + 23 * HOUR) });
    const notYet = await post('/v1/account/proposals', owner, { action: withdraw(fresh.id) });
    expect(notYet.statusCode).toBe(400);
    expect(notYet.json().error.message).toMatch(/not yet active|unknown/i);

    const revoked = await savedAddress();
    await prisma.payoutAllowlistEntry.update({
      where: { id: revoked.id },
      data: { status: 'revoked' },
    });
    expect(
      (await post('/v1/account/proposals', owner, { action: withdraw(revoked.id) })).statusCode,
    ).toBe(400);

    // Another merchant's saved address is unknown here.
    const other = await createMerchant();
    const theirs = await createRow('PayoutAllowlistEntry', other.id, false, {
      activeFrom: new Date(Date.now() - 48 * HOUR),
    });
    expect(
      (await post('/v1/account/proposals', owner, { action: withdraw(theirs.id) })).statusCode,
    ).toBe(400);

    const zero = await savedAddress();
    expect(
      (await post('/v1/account/proposals', owner, { action: withdraw(zero.id, '0') })).statusCode,
    ).toBe(400);
    expect(await prisma.accountProposal.count()).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('local validation mirrors threshold, chain and signer checks', async () => {
    const owner = await member('owner', true);
    const bad = async (action: unknown) => {
      const res = await post('/v1/account/proposals', owner, { action });
      expect(res.statusCode, JSON.stringify(action)).toBe(400);
    };
    await bad({ set_threshold: 0 });
    await bad({ set_threshold: 2 }); // one signer only
    await bad({ add_saved_address: { id: 'pal_1', chain: 'dogecoin', address: 'x' } });
    await bad({ add_saved_address: { id: 'pal_1', chain: 'near', address: 'Not A Near Id' } });
    await bad({
      refund: {
        asset: 'a',
        amount: '1',
        destination_chain: 'moon',
        destination: 'x',
        payment_id: 'pay_1',
        route: { poa: { token_contract: 't.near' } },
      },
    });
    await bad({ set_origins: ['https://usetendr.tech/path'] });
    await bad({ remove_signer: { id: owner.userId } }); // would leave fewer signers than threshold
    await bad({
      set_settlement: { dest_asset: 'a', payout_mode: 'wallet', saved_address_id: null },
    });
    // A signer's keys must be that person's own active passkeys.
    const finance = await member('finance', false);
    await bad({
      add_signer: {
        id: finance.userId,
        keys: [{ ed25519: Buffer.alloc(32, 1).toString('base64') }],
      },
    });
    const stored = await prisma.webauthnCredential.findUniqueOrThrow({
      where: { id: finance.credentialRowId },
    });
    const ok = await post('/v1/account/proposals', owner, {
      action: { add_signer: { id: finance.userId, keys: [stored.publicKey] } },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    // A viewer can never be made a signer.
    const viewer = await member('viewer', false);
    const vk = await prisma.webauthnCredential.findUniqueOrThrow({
      where: { id: viewer.credentialRowId },
    });
    await bad({ add_signer: { id: viewer.userId, keys: [vk.publicKey] } });
    const saved = await post('/v1/account/proposals', owner, {
      action: { add_saved_address: { id: 'pal_NEW', chain: 'near', address: 'shop.near' } },
    });
    expect(saved.statusCode).toBe(201);
    // The API mints the saved-address id (globally unique); the client's choice is ignored (I3).
    const minted = saved.json().action.add_saved_address.id as string;
    expect(minted).toMatch(/^pal_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(minted).not.toBe('pal_NEW');
  });

  it('approval_with_stale_epoch_rejected_before_relay', async () => {
    const a = await member('owner', true);
    const sav = await savedAddress();
    const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
    const signed = await signFor(a, draft.id);
    // A signer change executed meanwhile: the mirror's epoch moved on.
    await prisma.merchantAccount.update({ where: { id: account.id }, data: { signerEpoch: 1n } });
    const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, { response: signed });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/epoch/);
    expect(res.json().error.details).toMatchObject({ signerEpoch: '1' });
    expect(fake.calls).toHaveLength(0);
    expect(await prisma.accountApproval.count()).toBe(0);
  });

  it('rejects an assertion for another proposal, a revoked passkey, or someone else’s passkey', async () => {
    const a = await member('owner', true);
    const b = await member('admin', true);
    const sav = await savedAddress();
    const one = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
    const two = (await post('/v1/account/proposals', a, { action: withdraw(sav.id, '5') })).json();

    const forOne = await signFor(a, one.id);
    const wrong = await post(`/v1/account/proposals/${two.id}/approve`, a, { response: forOne });
    expect(wrong.statusCode).toBe(400);

    // b submits a's assertion: the credential is not b's.
    const stolen = await post(`/v1/account/proposals/${one.id}/approve`, b, {
      response: await signFor(a, one.id),
    });
    expect(stolen.statusCode).toBe(403);

    await prisma.webauthnCredential.update({
      where: { id: a.credentialRowId },
      data: { revokedAt: new Date() },
    });
    const revoked = await post(`/v1/account/proposals/${one.id}/approve`, a, {
      response: a.auth.assert(
        challengeB64u({
          contractId: account.nearAccountId,
          proposalId: one.onchainId,
          signerEpoch: 0n,
          intent: 'approve',
        }),
      ),
    });
    expect(revoked.statusCode).toBe(403);

    // A cancel assertion never counts as an approval.
    const cancelSig = b.auth.assert(
      challengeB64u({
        contractId: account.nearAccountId,
        proposalId: one.onchainId,
        signerEpoch: 0n,
        intent: 'cancel',
      }),
    );
    const asApproval = await post(`/v1/account/proposals/${one.id}/approve`, b, {
      response: cancelSig,
    });
    expect(asApproval.statusCode).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('a contract rejection stores no approval and leaves the draft', async () => {
    const a = await member('owner', true);
    const sav = await savedAddress();
    const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
    fake.failNext('propose', 'Smart contract panicked: saved address is unknown or not yet active');
    const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
      response: await signFor(a, draft.id),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/rejected/);
    expect(await prisma.accountApproval.count()).toBe(0);
    const row = await prisma.accountProposal.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('draft');
    expect(row.lastTxHash).toBeTruthy();
  });

  it('falls back to approve when another signer created the proposal first', async () => {
    const a = await member('owner', true);
    const sav = await savedAddress();
    const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
    fake.failNext('propose', 'Smart contract panicked: proposal already exists');
    fake.scriptLogs(account.nearAccountId, 'approve', [
      eventLog('proposal_approved', {
        proposal_id: draft.onchainId,
        signer_id: a.userId,
        signer_epoch: '0',
        approvals: 1,
        threshold: 2,
      }),
    ]);
    const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
      response: await signFor(a, draft.id),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('pending');
    expect(fake.callsTo('approve')).toHaveLength(1);
  });

  it('re-approving at a new epoch replaces the approval row', async () => {
    const a = await member('owner', true);
    const sav = await savedAddress();
    const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
    scriptCreated(draft.onchainId, a.userId, 1);
    await post(`/v1/account/proposals/${draft.id}/approve`, a, {
      response: await signFor(a, draft.id),
    });
    // Same epoch: already approved.
    expect((await post(`/v1/account/proposals/${draft.id}/challenge`, a, {})).statusCode).toBe(409);

    await prisma.merchantAccount.update({ where: { id: account.id }, data: { signerEpoch: 1n } });
    fake.scriptLogs(account.nearAccountId, 'approve', [
      eventLog('proposal_approved', {
        proposal_id: draft.onchainId,
        signer_id: a.userId,
        signer_epoch: '1',
        approvals: 1,
        threshold: 2,
      }),
    ]);
    const again = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
      response: await signFor(a, draft.id),
    });
    expect(again.statusCode, again.body).toBe(200);
    const rows = await prisma.accountApproval.findMany({ where: { proposalId: draft.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signerEpoch).toBe(1n);
  });

  it('cancels: a draft locally, a pending proposal on chain with a cancel assertion', async () => {
    const finance = await member('finance', false);
    const a = await member('owner', true);
    const viewer = await member('viewer', false);
    const sav = await savedAddress();

    const d1 = (await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })).json();
    expect((await post(`/v1/account/proposals/${d1.id}/cancel`, viewer, {})).statusCode).toBe(403);
    const c1 = await post(`/v1/account/proposals/${d1.id}/cancel`, finance, {});
    expect(c1.statusCode, c1.body).toBe(200);
    expect(c1.json().status).toBe('cancelled');
    expect(fake.calls).toHaveLength(0);

    const d2 = (await post('/v1/account/proposals', a, { action: withdraw(sav.id, '7') })).json();
    scriptCreated(d2.onchainId, a.userId, 1);
    await post(`/v1/account/proposals/${d2.id}/approve`, a, {
      response: await signFor(a, d2.id),
    });
    // A non-signer cannot cancel an on-chain proposal; a signer needs a cancel assertion.
    expect((await post(`/v1/account/proposals/${d2.id}/cancel`, finance, {})).statusCode).toBe(403);
    expect((await post(`/v1/account/proposals/${d2.id}/cancel`, a, {})).statusCode).toBe(400);
    const approveSig = a.auth.assert(
      challengeB64u({
        contractId: account.nearAccountId,
        proposalId: d2.onchainId,
        signerEpoch: 0n,
        intent: 'approve',
      }),
    );
    expect(
      (await post(`/v1/account/proposals/${d2.id}/cancel`, a, { response: approveSig })).statusCode,
    ).toBe(400);
    fake.scriptLogs(account.nearAccountId, 'cancel', [
      eventLog('proposal_cancelled', { proposal_id: d2.onchainId, signer_id: a.userId }),
    ]);
    const c2 = await post(`/v1/account/proposals/${d2.id}/cancel`, a, {
      response: await signFor(a, d2.id, 'cancel'),
    });
    expect(c2.statusCode, c2.body).toBe(200);
    expect(c2.json().status).toBe('cancelled');
    expect(fake.callsTo('cancel')).toHaveLength(1);
    // Terminal: no more approvals or cancels.
    expect((await post(`/v1/account/proposals/${d2.id}/challenge`, a, {})).statusCode).toBe(409);
  });

  it('another merchant’s proposal is not found', async () => {
    const a = await member('owner', true);
    const other = await createMerchant();
    const theirs = await createRow('AccountProposal', other.id, false, {});
    expect((await get(`/v1/account/proposals/${theirs.id}`, a)).statusCode).toBe(404);
    expect((await post(`/v1/account/proposals/${theirs.id}/challenge`, a, {})).statusCode).toBe(
      404,
    );
  });

  describe('fix round 1', () => {
    /** Runs `during` while the next relay of `method` is in flight, before the fake answers. */
    function duringRelay(method: string, during: () => Promise<void>) {
      const original = fake.call.bind(fake);
      const spy = vi.spyOn(fake, 'call');
      spy.mockImplementation(async (...args: Parameters<FakeNearClient['call']>) => {
        if (args[2] === method) {
          spy.mockRestore();
          await during();
        }
        return original(...args);
      });
    }

    const executedLogs = (onchainId: string, signerId: string, action: unknown) => [
      eventLog('proposal_created', { proposal_id: onchainId, signer_id: signerId }),
      eventLog('proposal_approved', {
        proposal_id: onchainId,
        signer_id: signerId,
        signer_epoch: '0',
        approvals: 1,
        threshold: 1,
      }),
      eventLog('proposal_executed', { proposal_id: onchainId, action }),
    ];

    it('a draft cancel racing the first approval is refused while the relay is in flight', async () => {
      const finance = await member('finance', false);
      const a = await member('owner', true);
      await prisma.merchantAccount.update({ where: { id: account.id }, data: { threshold: 1 } });
      const sav = await savedAddress();
      const draft = (
        await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })
      ).json();
      const signed = await signFor(a, draft.id);
      fake.scriptLogs(
        account.nearAccountId,
        'propose',
        executedLogs(draft.onchainId, a.userId, withdraw(sav.id)),
      );
      let midRelay: { statusCode: number; body: string } | undefined;
      let claimSeen: Date | null = null;
      duringRelay('propose', async () => {
        claimSeen = (await prisma.accountProposal.findUniqueOrThrow({ where: { id: draft.id } }))
          .relayClaimedAt;
        midRelay = await post(`/v1/account/proposals/${draft.id}/cancel`, finance, {});
      });
      const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, { response: signed });
      expect(res.statusCode, res.body).toBe(200);
      expect(claimSeen).not.toBeNull();
      expect(midRelay?.statusCode).toBe(409);
      // The mirror matches the chain: the withdrawal executed.
      const row = await prisma.accountProposal.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row.status).toBe('executed');
      expect(row.relayClaimedAt).toBeNull();
    });

    it('a second signer cannot relay a claimed draft at the same time', async () => {
      const a = await member('owner', true);
      const b = await member('admin', true);
      const sav = await savedAddress();
      const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
      const signedA = await signFor(a, draft.id);
      const signedB = await signFor(b, draft.id);
      scriptCreated(draft.onchainId, a.userId, 1);
      let second: { statusCode: number } | undefined;
      duringRelay('propose', async () => {
        second = await post(`/v1/account/proposals/${draft.id}/approve`, b, {
          response: signedB,
        });
      });
      const first = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
        response: signedA,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(second?.statusCode).toBe(409);
      expect(fake.callsTo('propose')).toHaveLength(1);
    });

    it('a failed or thrown relay releases the claim, so the draft can be cancelled', async () => {
      const finance = await member('finance', false);
      const a = await member('owner', true);
      const sav = await savedAddress();
      const d1 = (
        await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })
      ).json();
      fake.failNext('propose', 'Smart contract panicked: nope');
      expect(
        (
          await post(`/v1/account/proposals/${d1.id}/approve`, a, {
            response: await signFor(a, d1.id),
          })
        ).statusCode,
      ).toBe(409);
      expect((await post(`/v1/account/proposals/${d1.id}/cancel`, finance, {})).statusCode).toBe(
        200,
      );

      const d2 = (
        await post('/v1/account/proposals', finance, { action: withdraw(sav.id, '9') })
      ).json();
      // Nothing was broadcast: the claim is released.
      fake.throwNext('call', new NotBroadcastError(new Error('vault down')));
      expect(
        (
          await post(`/v1/account/proposals/${d2.id}/approve`, a, {
            response: await signFor(a, d2.id),
          })
        ).statusCode,
      ).toBe(500);
      const row = await prisma.accountProposal.findUniqueOrThrow({ where: { id: d2.id } });
      expect(row).toMatchObject({ status: 'draft', relayClaimedAt: null });
    });

    it('an unknown relay outcome keeps the claim (R24): the propose may have landed', async () => {
      const finance = await member('finance', false);
      const a = await member('owner', true);
      const sav = await savedAddress();
      const d = (await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })).json();
      fake.throwNext('call', new Error('socket hang up after send'));
      expect(
        (
          await post(`/v1/account/proposals/${d.id}/approve`, a, {
            response: await signFor(a, d.id),
          })
        ).statusCode,
      ).toBe(500);
      const row = await prisma.accountProposal.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.status).toBe('draft');
      expect(row.relayClaimedAt).not.toBeNull();
      // A local cancel cannot race it while the claim holds.
      expect((await post(`/v1/account/proposals/${d.id}/cancel`, finance, {})).statusCode).toBe(
        409,
      );
    });

    it('relays are bounded below the claim lease', () => {
      expect(RELAY_TIMEOUT_MS).toBeLessThan(RELAY_CLAIM_LEASE_MS);
    });

    it('a claim past its lease no longer blocks the draft', async () => {
      const finance = await member('finance', false);
      const sav = await savedAddress();
      const d = (await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })).json();
      await prisma.accountProposal.update({
        where: { id: d.id },
        data: { relayClaimedAt: new Date(Date.now() - 60_000) },
      });
      expect((await post(`/v1/account/proposals/${d.id}/cancel`, finance, {})).statusCode).toBe(
        409,
      );
      await prisma.accountProposal.update({
        where: { id: d.id },
        data: { relayClaimedAt: new Date(Date.now() - 3 * 60_000) },
      });
      expect((await post(`/v1/account/proposals/${d.id}/cancel`, finance, {})).statusCode).toBe(
        200,
      );
    });

    it('on-chain events override a local-only cancel, but not a cancel of a relayed proposal', async () => {
      const finance = await member('finance', false);
      const a = await member('owner', true);
      const sav = await savedAddress();
      // A draft cancelled in Postgres only, whose propose landed after all (e.g. a crashed relay
      // whose claim lapsed): the watcher's events win.
      const d1 = (
        await post('/v1/account/proposals', finance, { action: withdraw(sav.id) })
      ).json();
      await post(`/v1/account/proposals/${d1.id}/cancel`, finance, {});
      const ctx = { merchantId: merchant.id, livemode: false };
      const events = parseAccountEvents(executedLogs(d1.onchainId, a.userId, withdraw(sav.id)));
      const after = await tenantTransaction(ctx, (tx) =>
        applyProposalEvents(tx, ctx, d1.id, events, 'TX1'),
      );
      expect(after.status).toBe('executed');

      // A relayed proposal cancelled on chain stays cancelled whatever arrives later.
      const d2 = (await post('/v1/account/proposals', a, { action: withdraw(sav.id, '3') })).json();
      scriptCreated(d2.onchainId, a.userId, 1);
      await post(`/v1/account/proposals/${d2.id}/approve`, a, {
        response: await signFor(a, d2.id),
      });
      fake.scriptLogs(account.nearAccountId, 'cancel', [
        eventLog('proposal_cancelled', { proposal_id: d2.onchainId, signer_id: a.userId }),
      ]);
      await post(`/v1/account/proposals/${d2.id}/cancel`, a, {
        response: await signFor(a, d2.id, 'cancel'),
      });
      const late = await tenantTransaction(ctx, (tx) =>
        applyProposalEvents(
          tx,
          ctx,
          d2.id,
          parseAccountEvents(executedLogs(d2.onchainId, a.userId, withdraw(sav.id, '3'))),
          'TX2',
        ),
      );
      expect(late.status).toBe('cancelled');
    });

    it('an approval does not fail on a sign-counter regression; stored counters only rise', async () => {
      const a = await member('owner', true);
      const sav = await savedAddress();
      await prisma.webauthnCredential.update({
        where: { id: a.credentialRowId },
        data: { signCount: 1000n },
      });
      const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
      scriptCreated(draft.onchainId, a.userId, 1);
      const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
        response: await signFor(a, draft.id),
      });
      expect(res.statusCode, res.body).toBe(200);
      const cred = await prisma.webauthnCredential.findUniqueOrThrow({
        where: { id: a.credentialRowId },
      });
      expect(cred.signCount).toBe(1000n);
      await recordSignCount(a.credentialRowId, 5);
      expect(
        (await prisma.webauthnCredential.findUniqueOrThrow({ where: { id: a.credentialRowId } }))
          .signCount,
      ).toBe(1000n);
      await recordSignCount(a.credentialRowId, 1001);
      expect(
        (await prisma.webauthnCredential.findUniqueOrThrow({ where: { id: a.credentialRowId } }))
          .signCount,
      ).toBe(1001n);
    });

    it('ignores events logged by a receipt that failed', async () => {
      const a = await member('owner', true);
      const sav = await savedAddress();
      await prisma.merchantAccount.update({ where: { id: account.id }, data: { threshold: 1 } });
      const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
      fake.scriptLogs(account.nearAccountId, 'propose', [
        eventLog('proposal_created', { proposal_id: draft.onchainId, signer_id: a.userId }),
        eventLog('proposal_approved', {
          proposal_id: draft.onchainId,
          signer_id: a.userId,
          signer_epoch: '0',
          approvals: 1,
          threshold: 1,
        }),
      ]);
      // A later receipt logged `proposal_executed`, then panicked: rolled back, never happened.
      fake.failDownstreamNext('propose', 'callback panicked', [
        eventLog('proposal_executed', { proposal_id: draft.onchainId, action: withdraw(sav.id) }),
      ]);
      const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
        response: await signFor(a, draft.id),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe('executing');
    });

    it('treats "already approved" after the propose fallback as done, from the contract view', async () => {
      const a = await member('owner', true);
      const sav = await savedAddress();
      const draft = (await post('/v1/account/proposals', a, { action: withdraw(sav.id) })).json();
      const stored = await prisma.webauthnCredential.findUniqueOrThrow({
        where: { id: a.credentialRowId },
      });
      fake.failNext('propose', 'Smart contract panicked: proposal already exists');
      fake.failNext('approve', 'Smart contract panicked: signer already approved this proposal');
      const readyNs = BigInt(Date.now() + 24 * HOUR) * 1_000_000n;
      fake.scriptView(account.nearAccountId, 'get_proposal', (args) => {
        expect(args).toEqual({ id: draft.onchainId });
        return {
          id: draft.onchainId,
          action: withdraw(sav.id),
          creator: a.userId,
          created_at: '0',
          expires_at: '0',
          approvals: [{ signer_id: a.userId, key: stored.publicKey, signer_epoch: '0' }],
          valid_approvals: 1,
          ready_at: String(readyNs),
          status: 'pending',
        };
      });
      const res = await post(`/v1/account/proposals/${draft.id}/approve`, a, {
        response: await signFor(a, draft.id),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe('timelocked');
      const row = await prisma.accountProposal.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row.relayClaimedAt).toBeNull();
      expect(row.readyAt).not.toBeNull();
      const approvals = await prisma.accountApproval.findMany({ where: { proposalId: draft.id } });
      expect(approvals).toMatchObject([
        { userId: a.userId, credentialId: a.credentialRowId, signerEpoch: 0n },
      ]);
    });
  });

  it('settlement_change_is_a_proposal_not_a_patch', async () => {
    // No route path touches settlement directly …
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/settlement/i);
    // … no route module writes the settlement_configs mirror …
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(readFileSync(dir + f, 'utf8'), f).not.toMatch(/settlementConfig/);
    }
    // … and changing it is an ordinary proposal that leaves the mirror untouched.
    const owner = await member('owner', true);
    const res = await post('/v1/account/proposals', owner, {
      action: {
        set_settlement: {
          dest_asset: 'nep141:usdc.near',
          payout_mode: 'intents',
          saved_address_id: null,
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'set_settlement', status: 'draft' });
    expect(await prisma.settlementConfig.count()).toBe(0);
  });
});
