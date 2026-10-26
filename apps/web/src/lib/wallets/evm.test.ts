import { describe, expect, it, vi } from 'vitest';
import { buildEvmDeposit, createEvmAdapter, encodeErc20Transfer, type Eip1193 } from './evm';
import { payTargetFor, type DepositRequest } from './index';
import { WalletError } from './errors';

const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ETH = 'nep141:eth.omft.near';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const SHOPPER = '0x1111111111111111111111111111111111111111';

const usdc: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: USDC_BASE,
  amount: '84000000',
  decimals: 6,
};
const eth: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: ETH,
  amount: '33600000000000001',
  decimals: 18,
};

/** A fake wallet: records calls; chain switching is accepted or refused. */
function fakeProvider(opts: {
  chainId: number;
  acceptSwitch: boolean;
  hash?: string;
  accounts?: string[];
}) {
  let chainId = opts.chainId;
  const calls: { method: string; params?: unknown }[] = [];
  const provider: Eip1193 = {
    request: vi.fn(async ({ method, params }) => {
      calls.push({ method, params });
      if (method === 'eth_chainId') return '0x' + chainId.toString(16);
      if (method === 'wallet_switchEthereumChain') {
        if (!opts.acceptSwitch) throw Object.assign(new Error('User rejected'), { code: 4001 });
        chainId = parseInt((params as [{ chainId: string }])[0].chainId, 16);
        return null;
      }
      if (method === 'eth_accounts')
        return opts.accounts ?? [SHOPPER.toUpperCase().replace('0X', '0x')];
      if (method === 'eth_sendTransaction') return opts.hash ?? '0x' + 'ab'.repeat(32);
      throw new Error('unexpected ' + method);
    }),
  };
  return { provider, calls };
}

function session(provider: Eip1193) {
  return {
    connect: vi.fn(async () => ({ address: SHOPPER })),
    provider: () => provider,
    disconnect: vi.fn(async () => {}),
  };
}

describe('EVM deposits', () => {
  it('encodes ERC-20 transfer(to, amount) exactly', () => {
    expect(encodeErc20Transfer(DEPOSIT, 84000000n)).toBe(
      '0xa9059cbb' +
        '0000000000000000000000002222222222222222222222222222222222222222' +
        '000000000000000000000000000000000000000000000000000000000501bd00',
    );
    const big = 2n ** 255n + 1n;
    expect(encodeErc20Transfer(DEPOSIT, big).slice(-64)).toBe(big.toString(16).padStart(64, '0'));
  });

  it('a token payment calls the contract with value 0; a native payment sends value', () => {
    const token = buildEvmDeposit(payTargetFor(USDC_BASE)!, usdc, SHOPPER);
    expect(token).toEqual({
      from: SHOPPER,
      to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      value: '0x0',
      data: encodeErc20Transfer(DEPOSIT, 84000000n),
      chainId: '0x2105',
    });
    const native = buildEvmDeposit(payTargetFor(ETH)!, eth, SHOPPER);
    expect(native).toEqual({
      from: SHOPPER,
      to: DEPOSIT,
      value: '0x775f05a0740001',
      chainId: '0x1',
    });
    expect(BigInt(native.value)).toBe(33600000000000001n);
  });

  it('switches to the quote chain, then sends', async () => {
    const { provider, calls } = fakeProvider({ chainId: 1, acceptSwitch: true });
    const adapter = createEvmAdapter(payTargetFor(USDC_BASE)!, session(provider));
    await adapter.connect();
    const { txHash } = await adapter.sendDeposit(usdc);
    expect(txHash).toBe('0x' + 'ab'.repeat(32));
    expect(calls.map((c) => c.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
      'eth_accounts',
      'eth_sendTransaction',
    ]);
    expect(calls[1]!.params).toEqual([{ chainId: '0x2105' }]);
    // The transaction names the quote's chain.
    expect((calls[4]!.params as [{ chainId: string }])[0].chainId).toBe('0x2105');
  });

  it('a refused chain switch blocks the send', async () => {
    const { provider, calls } = fakeProvider({ chainId: 1, acceptSwitch: false });
    const adapter = createEvmAdapter(payTargetFor(USDC_BASE)!, session(provider));
    await adapter.connect();
    const err = await adapter.sendDeposit(usdc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).kind).toBe('chain_mismatch');
    expect((err as WalletError).network).toBe('Base');
    expect(calls.some((c) => c.method === 'eth_sendTransaction')).toBe(false);
  });

  it('never sends a different asset than the adapter was made for', async () => {
    const { provider, calls } = fakeProvider({ chainId: 8453, acceptSwitch: true });
    const adapter = createEvmAdapter(payTargetFor(USDC_BASE)!, session(provider));
    await adapter.connect();
    await expect(adapter.sendDeposit({ ...usdc, assetId: ETH })).rejects.toBeInstanceOf(
      WalletError,
    );
    expect(calls).toEqual([]);
  });

  it('refuses to send before connecting; a non-hash reply after signing is "possibly sent"', async () => {
    const { provider } = fakeProvider({ chainId: 8453, acceptSwitch: true, hash: 'nope' });
    const adapter = createEvmAdapter(payTargetFor(USDC_BASE)!, session(provider));
    await expect(adapter.sendDeposit(usdc)).rejects.toBeInstanceOf(WalletError);
    await adapter.connect();
    const err = await adapter.sendDeposit(usdc).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('uncertain');
  });

  it('an account switched in the wallet is not paid from: re-quote for it instead', async () => {
    const other = '0x3333333333333333333333333333333333333333';
    const { provider, calls } = fakeProvider({
      chainId: 8453,
      acceptSwitch: true,
      accounts: [other],
    });
    const adapter = createEvmAdapter(payTargetFor(USDC_BASE)!, session(provider));
    await adapter.connect();
    const err = await adapter.sendDeposit(usdc).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('account_changed');
    expect((err as WalletError).address).toBe(other);
    expect(calls.some((c) => c.method === 'eth_sendTransaction')).toBe(false);
  });
});
