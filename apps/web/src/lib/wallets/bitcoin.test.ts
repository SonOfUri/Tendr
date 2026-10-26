import { describe, expect, it, vi } from 'vitest';
import { createBitcoinAdapter } from './bitcoin';
import { WalletError } from './errors';
import { payTargetFor, type DepositRequest } from './index';

const BTC = 'nep141:btc.omft.near';
const SHOPPER = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const DEPOSIT = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const req: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: BTC,
  amount: '140001',
  decimals: 8,
};

function deps(opts: { onMainnet?: boolean; address?: string } = {}) {
  const sendTransfer = vi.fn(async (_p: { recipient: string; amount: string }) => 'f'.repeat(64));
  return {
    sendTransfer,
    session: {
      connect: vi.fn(async () => ({ address: opts.address ?? SHOPPER })),
      provider: () => ({ sendTransfer }),
      ensureNetwork: vi.fn(async () => opts.onMainnet ?? true),
      disconnect: vi.fn(async () => {}),
    },
  };
}

describe('Bitcoin deposits', () => {
  it('sends the exact satoshis to the deposit address', async () => {
    const d = deps();
    const adapter = createBitcoinAdapter(payTargetFor(BTC)!, { session: d.session });
    await adapter.connect();
    expect(await adapter.sendDeposit(req)).toEqual({ txHash: 'f'.repeat(64) });
    expect(d.sendTransfer).toHaveBeenCalledWith({ recipient: DEPOSIT, amount: '140001' });
  });

  it('a wallet on another Bitcoin network blocks the send', async () => {
    const d = deps({ onMainnet: false });
    const adapter = createBitcoinAdapter(payTargetFor(BTC)!, { session: d.session });
    await adapter.connect();
    const err = await adapter.sendDeposit(req).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('chain_mismatch');
    expect(d.sendTransfer).not.toHaveBeenCalled();
  });

  it('a testnet account blocks the send', async () => {
    const d = deps({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' });
    const adapter = createBitcoinAdapter(payTargetFor(BTC)!, { session: d.session });
    await adapter.connect();
    const err = await adapter.sendDeposit(req).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('chain_mismatch');
    expect(d.sendTransfer).not.toHaveBeenCalled();
  });

  it('rejects a reply that is not a transaction id', async () => {
    const d = deps();
    d.sendTransfer.mockResolvedValueOnce('');
    const adapter = createBitcoinAdapter(payTargetFor(BTC)!, { session: d.session });
    await adapter.connect();
    await expect(adapter.sendDeposit(req)).rejects.toBeInstanceOf(WalletError);
  });

  it('a throw from the wallet send is "possibly sent", except a wallet that cannot send at all', async () => {
    const d = deps();
    const adapter = createBitcoinAdapter(payTargetFor(BTC)!, { session: d.session });
    await adapter.connect();
    d.sendTransfer.mockRejectedValueOnce(new Error('timeout'));
    expect(((await adapter.sendDeposit(req).catch((e: unknown) => e)) as WalletError).kind).toBe(
      'uncertain',
    );
    // AppKit's wallet-standard connector refuses sendTransfer before anything is signed. The
    // real class (the package does not export it, so it is loaded by file path).
    const errorModule =
      '../../../../../node_modules/@reown/appkit-adapter-bitcoin/dist/esm/src/errors/MethodNotSupportedError.js';
    const { MethodNotSupportedError } = (await import(/* @vite-ignore */ errorModule)) as {
      MethodNotSupportedError: new (walletId: string, method: string, log?: string) => Error;
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = new MethodNotSupportedError('wallet-standard', 'sendTransfer', 'Use signPSBT');
    quiet.mockRestore();
    expect(real.name).toBe('MethodNotSupported');
    d.sendTransfer.mockRejectedValueOnce(real);
    expect(((await adapter.sendDeposit(req).catch((e: unknown) => e)) as WalletError).kind).toBe(
      'failed',
    );
  });
});
