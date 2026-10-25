import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { proposalId, recoveryId, type ActionJson } from '../accounts/encoding.js';
import { parseAccountEvents } from '../accounts/events.js';
import type { InitConfigJson } from './client.js';
import { FakeNearClient } from './fake.js';

const ACCOUNT = 'shop.tendr.testnet';
const key = (n: number) => ({ ed25519: Buffer.alloc(32, n).toString('base64') });
const SIGNER = 'per_01AAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'per_01BBBBBBBBBBBBBBBBBBBBBBBB';

function client(threshold = 1, recoveryKey: string | null = null) {
  const f = new FakeNearClient(
    { livemode: false, parentAccountId: 'tendr.testnet', intentsContractId: 'intents-mock.x' },
    { simulateContracts: true },
  );
  const init: InitConfigJson = {
    signers: [
      { id: SIGNER, keys: [key(1)] },
      { id: OTHER, keys: [key(2)] },
    ],
    threshold,
    recovery_key: recoveryKey,
    rp_id: 'localhost',
    origins: ['http://localhost:3000'],
    intents_contract: 'intents-mock.x',
    poa_suffix: null,
    testnet_admin: 'tendr.testnet',
  };
  return { f, init };
}

async function provisioned(threshold = 1, recoveryKey: string | null = null) {
  const { f, init } = client(threshold, recoveryKey);
  await f.provisionAccount({
    merchantId: 'mer_x',
    livemode: false,
    accountId: ACCOUNT,
    init,
    initialBalanceYocto: 1n,
  });
  return f;
}

const approval = (signer: string, n = 1) => ({ signer_id: signer, key: key(n), assertion: {} });

async function propose(f: FakeNearClient, action: ActionJson, signer = SIGNER) {
  const salt = randomBytes(32);
  const res = await f.call('relayer-accounts', ACCOUNT, 'propose', {
    action,
    salt: salt.toString('base64'),
    approval: approval(signer),
  });
  return { res, id: proposalId(action, salt), events: parseAccountEvents(res.successLogs) };
}

describe('FakeNearClient with simulated merchant-account contracts', () => {
  it('threshold 1: a saved address executes at once and is usable 24 h later', async () => {
    const f = await provisioned();
    const action: ActionJson = {
      add_saved_address: { id: 'pal_1', chain: 'near', address: 'payout.near' },
    };
    const { res, id, events } = await propose(f, action);
    expect(res.topLevelStatus).toBe('success');
    expect(events.map((e) => e.event)).toEqual([
      'proposal_created',
      'proposal_approved',
      'proposal_executed',
    ]);
    expect(events[0]!.data.proposal_id).toBe(id);
    const saved = await f.view<{ id: string; active_from: string }[]>(
      ACCOUNT,
      'list_saved_addresses',
      {},
    );
    expect(saved).toHaveLength(1);
    const activeFromMs = Number(BigInt(saved[0]!.active_from) / 1_000_000n);
    expect(activeFromMs).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await f.view(ACCOUNT, 'get_proposal', { id })).toMatchObject({
      id,
      status: 'executed',
      valid_approvals: 1,
    });

    // A withdrawal to it is refused until then.
    const w = await propose(f, {
      withdraw: {
        asset: 'nep141:usdc.near',
        amount: '1',
        saved_address_id: 'pal_1',
        route: { poa: { token_contract: 'usdc.near' } },
      },
    });
    expect(w.res.topLevelStatus).toBe('failure');
    expect(w.res.failure).toMatch(/not active yet/);
  });

  it('threshold 2: pending after one approval; a second executes; double approval panics', async () => {
    const f = await provisioned(2);
    const { id, events } = await propose(f, { set_threshold: 1 });
    expect(events.map((e) => e.event)).toEqual(['proposal_created', 'proposal_approved']);
    const again = await f.call('relayer-accounts', ACCOUNT, 'approve', {
      proposal_id: id,
      approval: approval(SIGNER),
    });
    expect(again.failure).toMatch(/already approved/);
    const second = await f.call('relayer-accounts', ACCOUNT, 'approve', {
      proposal_id: id,
      approval: approval(OTHER, 2),
    });
    expect(parseAccountEvents(second.successLogs).map((e) => e.event)).toEqual([
      'proposal_approved',
      'proposal_executed',
      'signers_changed',
    ]);
    expect(await f.view(ACCOUNT, 'get_config', {})).toMatchObject({
      threshold: 1,
      signer_epoch: '1',
    });
  });

  it('a limit raise is timelocked for 24 h; execute before then panics', async () => {
    const f = await provisioned();
    await propose(f, { set_limits: { asset: 'a', per_tx: '10', per_day: null } });
    const { id, events } = await propose(f, {
      set_limits: { asset: 'a', per_tx: '20', per_day: null },
    });
    expect(events.map((e) => e.event)).toEqual([
      'proposal_created',
      'proposal_approved',
      'timelock_started',
    ]);
    const early = await f.call('relayer-accounts', ACCOUNT, 'execute', { proposal_id: id });
    expect(early.failure).toMatch(/timelocked/);
    expect(await f.view(ACCOUNT, 'get_limits', { asset: 'a' })).toMatchObject({ per_tx: '10' });
    // Cancel by a signer.
    const cancelled = await f.call('relayer-accounts', ACCOUNT, 'cancel', {
      proposal_id: id,
      approval: approval(OTHER, 2),
    });
    expect(parseAccountEvents(cancelled.successLogs)[0]!.event).toBe('proposal_cancelled');
  });

  it('recovery: start needs a key and a fresh nonce; get_recovery and the nonce views', async () => {
    const f = await provisioned(1, Buffer.alloc(32, 9).toString('base64'));
    const args = {
      new_signers: [{ id: OTHER, keys: [key(2)] }],
      new_threshold: 1,
      nonce: '1',
      valid_until: (BigInt(Date.now() + 3_600_000) * 1_000_000n).toString(),
      signature: 'x',
    };
    const started = await f.call('relayer-accounts', ACCOUNT, 'start_recovery', args);
    expect(parseAccountEvents(started.successLogs)[0]).toMatchObject({
      event: 'recovery_started',
      data: { recovery_id: recoveryId(ACCOUNT, 0n, 1n), nonce: '1' },
    });
    expect(await f.view(ACCOUNT, 'get_recovery_nonce', {})).toBe('1');
    expect(await f.view(ACCOUNT, 'get_recovery', {})).toMatchObject({ new_signer_ids: [OTHER] });
    const cancel = await f.call('relayer-accounts', ACCOUNT, 'cancel_recovery', {
      approval: approval(SIGNER),
    });
    expect(parseAccountEvents(cancel.successLogs)[0]!.event).toBe('recovery_cancelled');
    const replay = await f.call('relayer-accounts', ACCOUNT, 'start_recovery', args);
    expect(replay.failure).toMatch(/nonce/);
  });

  it('scripted logs and views still win; without simulation nothing changes', async () => {
    const f = await provisioned();
    f.scriptLogs(ACCOUNT, 'propose', ['scripted']);
    const res = await f.call('relayer-accounts', ACCOUNT, 'propose', {});
    expect(res.logs).toEqual(['scripted']);
    expect(
      await f.view('intents-mock.x', 'mt_batch_balance_of', { token_ids: ['a', 'b'] }),
    ).toEqual(['0', '0']);

    const plain = new FakeNearClient({
      livemode: false,
      parentAccountId: 'tendr.testnet',
      intentsContractId: 'intents-mock.x',
    });
    expect(plain.contracts).toBeNull();
  });
});
