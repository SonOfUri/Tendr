import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proposalId, recoveryId, type ActionJson } from '../accounts/encoding.js';
import { parseAccountEvents } from '../accounts/events.js';
import type { InitConfigJson } from './client.js';
import { FakeNearClient } from './fake.js';

const ACCOUNT = 'shop.tendr.testnet';
const key = (n: number) => ({ ed25519: Buffer.alloc(32, n).toString('base64') });
const SIGNER = 'per_01AAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'per_01BBBBBBBBBBBBBBBBBBBBBBBB';

function client(threshold = 1, recoveryKey: string | null = null, timelockNs?: bigint) {
  const f = new FakeNearClient(
    { livemode: false, parentAccountId: 'tendr.testnet', intentsContractId: 'intents-mock.x' },
    { simulateContracts: true, timelockNs },
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

async function provisioned(threshold = 1, recoveryKey: string | null = null, timelockNs?: bigint) {
  const { f, init } = client(threshold, recoveryKey, timelockNs);
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
    // An unchanged (or raised) threshold is not timelocked; lowering it is (below).
    const { id, events } = await propose(f, { set_threshold: 2 });
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
      threshold: 2,
      signer_epoch: '1',
    });
  });

  it('security changes that widen access are timelocked for 24 h (R34); removals are not', async () => {
    const widening: ActionJson[] = [
      { add_signer: { id: 'per_01CCCCCCCCCCCCCCCCCCCCCCCC', keys: [key(3)] } },
      { add_signer_key: { id: SIGNER, key: key(4) } },
      { rotate_recovery_key: Buffer.alloc(32, 5).toString('base64') },
      { rotate_recovery_key: null },
      { set_origins: ['http://localhost:3000', 'https://other.example'] },
      { set_threshold: 1 },
    ];
    for (const action of widening) {
      const f = await provisioned(2);
      const { id } = await propose(f, action);
      const second = await f.call('relayer-accounts', ACCOUNT, 'approve', {
        proposal_id: id,
        approval: approval(OTHER, 2),
      });
      expect(
        parseAccountEvents(second.successLogs).map((e) => e.event),
        JSON.stringify(action),
      ).toEqual(['proposal_approved', 'timelock_started']);
      const early = await f.call('relayer-accounts', ACCOUNT, 'execute', { proposal_id: id });
      expect(early.failure).toMatch(/timelocked/);
    }
    const f = await provisioned(1);
    const { events } = await propose(f, { remove_signer: { id: OTHER } });
    expect(events.map((e) => e.event)).toContain('proposal_executed');
  });

  describe('expiry', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('execute past the TTL marks the proposal expired (I3)', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      const f = await provisioned(2);
      const { id } = await propose(f, { set_threshold: 2 });
      vi.setSystemTime(Date.now() + 8 * 24 * 3_600_000);
      expect(await f.view(ACCOUNT, 'get_proposal', { id })).toMatchObject({ status: 'expired' });
      const res = await f.call('relayer-accounts', ACCOUNT, 'execute', { proposal_id: id });
      expect(res.topLevelStatus).toBe('success');
      expect(parseAccountEvents(res.successLogs)).toEqual([
        expect.objectContaining({
          event: 'proposal_failed',
          data: { proposal_id: id, reason: 'expired' },
        }),
      ]);
      const again = await f.call('relayer-accounts', ACCOUNT, 'execute', { proposal_id: id });
      expect(again.failure).toMatch(/proposal is expired/);
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

  it('a shorter simulated timelock (NEAR_FAKE_TIMELOCK_SECONDS, the WooCommerce e2e) lets a refund execute', async () => {
    const f = await provisioned(1, null, 50_000_000n); // 50 ms
    const refund: ActionJson = {
      refund: {
        payment_id: 'pay_1',
        asset: 'nep141:usdc.test',
        amount: '500000',
        destination_chain: 'near',
        destination: 'shopper.testnet',
        route: { poa: { token_contract: 'usdc.test' } },
      },
    };
    const { id, events } = await propose(f, refund);
    // Above the refund cap (0 by default): timelocked, only for the shortened delay.
    expect(events.map((e) => e.event)).toEqual([
      'proposal_created',
      'proposal_approved',
      'timelock_started',
    ]);
    const early = await f.call('relayer-accounts', ACCOUNT, 'execute', { proposal_id: id });
    expect(early.failure).toMatch(/timelocked/);
    await new Promise((r) => setTimeout(r, 80));
    const done = await f.call('relayer-accounts', ACCOUNT, 'execute', { proposal_id: id });
    expect(parseAccountEvents(done.successLogs).map((e) => e.event)).toEqual(['proposal_executed']);
  });

  it('deposits to the mock intents verifier show in its balances (simulated settlements)', async () => {
    const f = await provisioned();
    const balances = () =>
      f.view<string[]>('intents-mock.x', 'mt_batch_balance_of', {
        account_id: ACCOUNT,
        token_ids: ['nep141:usdc.test', 'nep141:other.test'],
      });
    expect(await balances()).toEqual(['0', '0']);
    for (const amount of ['1000000', '250000']) {
      const res = await f.call('relayer-accounts', 'intents-mock.x', 'deposit', {
        account_id: ACCOUNT,
        token_id: 'nep141:usdc.test',
        amount,
      });
      expect(res.topLevelStatus).toBe('success');
    }
    await f.call('relayer-accounts', 'intents-mock.x', 'deposit', {
      account_id: 'someone-else.testnet',
      token_id: 'nep141:usdc.test',
      amount: '7',
    });
    expect(await balances()).toEqual(['1250000', '0']);
  });
});
