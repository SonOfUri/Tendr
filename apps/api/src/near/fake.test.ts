import { describe, expect, it } from 'vitest';
import type { InitConfigJson } from './client.js';
import { FakeNearClient } from './fake.js';

const init: InitConfigJson = {
  signers: [{ id: 'per_01', keys: [{ ed25519: Buffer.alloc(32, 1).toString('base64') }] }],
  threshold: 1,
  recovery_key: null,
  rp_id: 'localhost',
  origins: ['http://localhost:3000'],
  intents_contract: 'intents-mock.tendr.testnet',
  poa_suffix: null,
  testnet_admin: 'tendr.testnet',
};

const fake = () =>
  new FakeNearClient({
    livemode: false,
    parentAccountId: 'tendr.testnet',
    intentsContractId: 'intents-mock.tendr.testnet',
  });

describe('FakeNearClient', () => {
  it('fake_client_records_calls', async () => {
    const f = fake();
    f.scriptLogs('shop.tendr.testnet', 'propose', ['EVENT_JSON:{"event":"proposed"}']);
    f.scriptView('shop.tendr.testnet', 'get_signers', (args) => ({ echo: args }));

    const res = await f.call(
      'relayer-accounts',
      'shop.tendr.testnet',
      'propose',
      { x: 1 },
      {
        deposit: 1n,
      },
    );
    expect(res).toMatchObject({ status: 'success', logs: ['EVENT_JSON:{"event":"proposed"}'] });
    expect(res.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(await f.view('shop.tendr.testnet', 'get_signers', { a: 2 })).toEqual({ echo: { a: 2 } });

    expect(f.calls).toEqual([
      {
        kind: 'call',
        signer: 'relayer-accounts',
        contractId: 'shop.tendr.testnet',
        method: 'propose',
        args: { x: 1 },
        gas: 100_000_000_000_000n,
        deposit: 1n,
      },
      { kind: 'view', contractId: 'shop.tendr.testnet', method: 'get_signers', args: { a: 2 } },
    ]);
    expect(f.callsTo('propose')).toHaveLength(1);
  });

  it('tracks provisioned accounts, with zero access keys, and refuses duplicates', async () => {
    const f = fake();
    const p = {
      merchantId: 'mer_x',
      livemode: false,
      accountId: 'shop.tendr.testnet',
      init,
      initialBalanceYocto: 10n ** 23n,
    };
    expect((await f.provisionAccount(p)).status).toBe('success');
    expect(f.accounts.get('shop.tendr.testnet')).toEqual({ init, balanceYocto: 10n ** 23n });
    expect(await f.accessKeys('shop.tendr.testnet')).toEqual([]);
    expect(f.calls.at(-1)).toMatchObject({ kind: 'provision', accountId: 'shop.tendr.testnet' });

    const again = await f.provisionAccount(p);
    expect(again).toMatchObject({ status: 'failure', failure: expect.stringMatching(/exists/) });
    await expect(f.accessKeys('nobody.tendr.testnet')).rejects.toThrow(/does not exist/);
  });

  it('applies the same provisioning validation as the RPC client', async () => {
    await expect(
      fake().provisionAccount({
        merchantId: 'mer_x',
        livemode: false,
        accountId: 'shop.tendr.near',
        init,
        initialBalanceYocto: 1n,
      }),
    ).rejects.toThrow(/account/);
  });

  it('records a deep copy of args, so later mutation does not rewrite history', async () => {
    const f = fake();
    const args = { nested: { n: 1 } };
    await f.call('relayer-accounts', 'a.tendr.testnet', 'm', args);
    args.nested.n = 2;
    expect(f.calls[0]).toMatchObject({ args: { nested: { n: 1 } } });
  });

  it('failNextProvision, throwNext and scriptAccessKeys', async () => {
    const f = fake();
    const p = {
      merchantId: 'mer_x',
      livemode: false,
      accountId: 'shop.tendr.testnet',
      init,
      initialBalanceYocto: 1n,
    };
    f.failNextProvision('boom');
    expect(await f.provisionAccount(p)).toMatchObject({ status: 'failure', failure: 'boom' });
    expect(f.accounts.size).toBe(0);

    const err = new Error('rpc down');
    f.throwNext('provision', err);
    await expect(f.provisionAccount(p)).rejects.toBe(err);
    f.throwNext('call', err);
    await expect(f.call('relayer-accounts', 'a.tendr.testnet', 'm', {})).rejects.toBe(err);
    f.throwNext('view', err);
    await expect(f.view('a.tendr.testnet', 'v', {})).rejects.toBe(err);
    expect(f.calls.map((c) => c.kind)).toEqual(['provision', 'provision', 'call', 'view']);

    expect((await f.provisionAccount(p)).status).toBe('success');
    f.scriptAccessKeys('shop.tendr.testnet', ['ed25519:abc']);
    expect(await f.accessKeys('shop.tendr.testnet')).toEqual(['ed25519:abc']);
  });

  it('can script a failure for the next call', async () => {
    const f = fake();
    f.failNext('m', 'Smart contract panicked: nope');
    expect(await f.call('relayer-accounts', 'a.tendr.testnet', 'm', {})).toMatchObject({
      status: 'failure',
      topLevelStatus: 'failure',
      failure: 'Smart contract panicked: nope',
    });
    expect(await f.call('relayer-accounts', 'a.tendr.testnet', 'm', {})).toMatchObject({
      status: 'success',
      topLevelStatus: 'success',
    });
  });

  it('can script a downstream failure: the call lands, a later receipt fails', async () => {
    const f = fake();
    f.scriptLogs('a.tendr.testnet', 'approve', ['EVENT_JSON:{}']);
    f.failDownstreamNext('approve', 'ft_withdraw failed');
    expect(await f.call('relayer-accounts', 'a.tendr.testnet', 'approve', {})).toMatchObject({
      status: 'failure',
      topLevelStatus: 'success',
      logs: ['EVENT_JSON:{}'],
      failure: 'ft_withdraw failed',
    });
  });
});
