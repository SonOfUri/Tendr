import { describe, expect, it, vi } from 'vitest';
import { WalletError } from './errors';
import { payTargetFor, type DepositRequest } from './index';
import { createNearAdapter, planNearDeposit, type NearView } from './near';

const USDT = 'nep141:usdt.tether-token.near';
const WNEAR = 'nep141:wrap.near';
const SHOPPER = 'alice.near';
const DEPOSIT = 'a'.repeat(64);
const MIN = '1250000000000000000000';

const usdt: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: USDT,
  amount: '84000000',
  decimals: 6,
};
const wnear: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: WNEAR,
  amount: '28000000000000000000000001',
  decimals: 24,
};

/** A mocked contract view: who is registered, and wNEAR balances. */
function view(state: { registered: string[]; balances?: Record<string, string> }): NearView {
  return vi.fn(async (_contract: string, method: string, args: Record<string, unknown>) => {
    if (method === 'storage_balance_of')
      return state.registered.includes(String(args.account_id))
        ? { total: MIN, available: '0' }
        : null;
    if (method === 'storage_balance_bounds') return { min: MIN, max: MIN };
    if (method === 'ft_balance_of') return state.balances?.[String(args.account_id)] ?? '0';
    throw new Error('unexpected ' + method);
  });
}

describe('NEAR deposits', () => {
  it('registers the deposit address with storage_deposit first when it is unregistered', async () => {
    const plan = await planNearDeposit(
      view({ registered: [SHOPPER] }),
      SHOPPER,
      payTargetFor(USDT)!,
      usdt,
    );
    expect(plan.receiverId).toBe('usdt.tether-token.near');
    expect(plan.actions).toEqual([
      {
        type: 'FunctionCall',
        params: {
          methodName: 'storage_deposit',
          args: { account_id: DEPOSIT, registration_only: true },
          gas: '30000000000000',
          deposit: MIN,
        },
      },
      {
        type: 'FunctionCall',
        params: {
          methodName: 'ft_transfer',
          args: { receiver_id: DEPOSIT, amount: '84000000' },
          gas: '30000000000000',
          deposit: '1',
        },
      },
    ]);
  });

  it('skips storage_deposit when the deposit address is registered', async () => {
    const plan = await planNearDeposit(
      view({ registered: [SHOPPER, DEPOSIT] }),
      SHOPPER,
      payTargetFor(USDT)!,
      usdt,
    );
    expect(plan.actions.map((a) => a.params.methodName)).toEqual(['ft_transfer']);
  });

  it('wNEAR: wraps exactly the shortfall from NEAR in the same transaction', async () => {
    const plan = await planNearDeposit(
      view({ registered: [SHOPPER, DEPOSIT], balances: { [SHOPPER]: '1' } }),
      SHOPPER,
      payTargetFor(WNEAR)!,
      wnear,
    );
    expect(plan.receiverId).toBe('wrap.near');
    expect(plan.actions.map((a) => [a.params.methodName, a.params.deposit])).toEqual([
      ['near_deposit', '28000000000000000000000000'],
      ['ft_transfer', '1'],
    ]);
    expect(plan.actions[1]!.params.args).toEqual({ receiver_id: DEPOSIT, amount: wnear.amount });
  });

  it('wNEAR: an unregistered sender also pays its own registration in near_deposit', async () => {
    const plan = await planNearDeposit(
      view({ registered: [] }),
      SHOPPER,
      payTargetFor(WNEAR)!,
      wnear,
    );
    expect(plan.actions.map((a) => [a.params.methodName, a.params.deposit])).toEqual([
      ['storage_deposit', MIN],
      ['near_deposit', (BigInt(wnear.amount) + BigInt(MIN)).toString()],
      ['ft_transfer', '1'],
    ]);
  });

  it('wNEAR: no wrapping when the balance covers it', async () => {
    const plan = await planNearDeposit(
      view({ registered: [SHOPPER, DEPOSIT], balances: { [SHOPPER]: wnear.amount } }),
      SHOPPER,
      payTargetFor(WNEAR)!,
      wnear,
    );
    expect(plan.actions.map((a) => a.params.methodName)).toEqual(['ft_transfer']);
  });

  it('signs one transaction through the chosen wallet and returns its hash', async () => {
    const signAndSendTransaction = vi.fn(async (_p: unknown) => ({
      transaction: { hash: 'BxP4YpWnuBg8mUgyp2bYhNLXUnPvZSmhcW8TztVEMSpy' },
    }));
    const wallet = {
      signIn: vi.fn(async () => [{ accountId: SHOPPER }]),
      getAccounts: vi.fn(async () => [{ accountId: SHOPPER }]),
      signOut: vi.fn(async () => {}),
      signAndSendTransaction,
    };
    const adapter = createNearAdapter(payTargetFor(USDT)!, {
      wallets: async () => [{ id: 'meteor-wallet', name: 'Meteor' }],
      pickWallet: async () => 'meteor-wallet',
      wallet: async () => wallet,
      view: view({ registered: [SHOPPER] }),
    });
    expect(await adapter.connect()).toEqual({ address: SHOPPER });
    expect(await adapter.sendDeposit(usdt)).toEqual({
      txHash: 'BxP4YpWnuBg8mUgyp2bYhNLXUnPvZSmhcW8TztVEMSpy',
    });
    const p = signAndSendTransaction.mock.calls[0]![0] as {
      receiverId: string;
      actions: unknown[];
    };
    expect(p.receiverId).toBe('usdt.tether-token.near');
    expect(p.actions).toHaveLength(2);
  });

  it('a testnet account blocks the send', async () => {
    const wallet = {
      signIn: vi.fn(async () => [{ accountId: 'alice.testnet' }]),
      getAccounts: vi.fn(async () => [{ accountId: 'alice.testnet' }]),
      signOut: vi.fn(async () => {}),
      signAndSendTransaction: vi.fn(),
    };
    const adapter = createNearAdapter(payTargetFor(USDT)!, {
      wallets: async () => [{ id: 'meteor-wallet', name: 'Meteor' }],
      pickWallet: async () => 'meteor-wallet',
      wallet: async () => wallet,
      view: view({ registered: [] }),
    });
    await adapter.connect();
    const err = await adapter.sendDeposit(usdt).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('chain_mismatch');
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it('closing the wallet picker is a cancellation', async () => {
    const adapter = createNearAdapter(payTargetFor(USDT)!, {
      wallets: async () => [{ id: 'meteor-wallet', name: 'Meteor' }],
      pickWallet: async () => null,
      wallet: vi.fn(),
      view: view({ registered: [] }),
    });
    const err = await adapter.connect().catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('rejected');
  });

  function walletReturning(outcome: unknown) {
    return {
      signIn: vi.fn(async () => [{ accountId: SHOPPER }]),
      getAccounts: vi.fn(async () => [{ accountId: SHOPPER }]),
      signOut: vi.fn(async () => {}),
      signAndSendTransaction: vi.fn(async () => outcome),
    };
  }
  const nearDeps = (wallet: ReturnType<typeof walletReturning>) => ({
    wallets: async () => [{ id: 'meteor-wallet', name: 'Meteor' }],
    pickWallet: async () => 'meteor-wallet',
    wallet: async () => wallet,
    view: view({ registered: [SHOPPER, DEPOSIT] }),
  });
  const HASH = 'BxP4YpWnuBg8mUgyp2bYhNLXUnPvZSmhcW8TztVEMSpy';

  it('a transaction that failed on chain is reported as failed, with its hash', async () => {
    const adapter = createNearAdapter(
      payTargetFor(USDT)!,
      nearDeps(
        walletReturning({
          transaction: { hash: HASH },
          status: { Failure: { ActionError: { index: 0 } } },
        }),
      ),
    );
    await adapter.connect();
    const err = await adapter.sendDeposit(usdt).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('onchain_failed');
    expect((err as WalletError).txHash).toBe(HASH);
  });

  it('an outcome without a recognisable hash is "possibly sent", never a retry', async () => {
    const adapter = createNearAdapter(
      payTargetFor(USDT)!,
      nearDeps(walletReturning({ odd: true })),
    );
    await adapter.connect();
    const err = await adapter.sendDeposit(usdt).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('uncertain');
  });

  it('a planning error (a view failed) is retryable; a throw from the wallet send is "possibly sent"', async () => {
    const wallet = walletReturning({ transaction: { hash: HASH } });
    const failingView: NearView = async () => {
      throw new Error('RPC unavailable');
    };
    const planFails = createNearAdapter(payTargetFor(USDT)!, {
      ...nearDeps(wallet),
      view: failingView,
    });
    await planFails.connect();
    const e1 = await planFails.sendDeposit(usdt).catch((e: unknown) => e);
    expect((e1 as WalletError).kind).toBe('failed');
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();

    const sendThrows = walletReturning(null);
    sendThrows.signAndSendTransaction.mockRejectedValueOnce(new Error('Failed to fetch'));
    const a2 = createNearAdapter(payTargetFor(USDT)!, nearDeps(sendThrows));
    await a2.connect();
    const e2 = await a2.sendDeposit(usdt).catch((e: unknown) => e);
    expect((e2 as WalletError).kind).toBe('uncertain');

    sendThrows.signAndSendTransaction.mockRejectedValueOnce(
      new Error('User rejected the transaction'),
    );
    const e3 = await a2.sendDeposit(usdt).catch((e: unknown) => e);
    expect((e3 as WalletError).kind).toBe('rejected');
  });
});
