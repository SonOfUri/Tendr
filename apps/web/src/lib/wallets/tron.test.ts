import { describe, expect, it, vi } from 'vitest';
import { WalletError } from './errors';
import { payTargetFor, type DepositRequest } from './index';
import { createTronAdapter, type TronWindow } from './tron';

const TRX = 'nep141:tron.omft.near';
const USDT = 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near';
const SHOPPER = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const DEPOSIT = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const TXID = 'c'.repeat(64);

const trx: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: TRX,
  amount: '25000001',
  decimals: 6,
};
const usdt: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: USDT,
  amount: '84000000',
  decimals: 6,
};

function fakeTron(opts: { host?: string; approve?: boolean } = {}) {
  const tronWeb = {
    defaultAddress: { base58: SHOPPER },
    fullNode: { host: opts.host ?? 'https://api.trongrid.io' },
    transactionBuilder: {
      sendTrx: vi.fn(async (to: string, amount: number, from: string) => ({
        raw: 'trx',
        to,
        amount,
        from,
      })),
      triggerSmartContract: vi.fn(async (..._args: unknown[]) => ({
        result: { result: true },
        transaction: { raw: 'trc20' },
      })),
    },
    trx: {
      sign: vi.fn(async (tx: object) => ({ ...tx, signature: ['s'], txID: TXID })),
      sendRawTransaction: vi.fn(
        async (_tx: object): Promise<{ result?: boolean; txid?: string; code?: string }> => ({
          result: true,
          txid: TXID,
        }),
      ),
    },
  };
  const win: TronWindow = {
    tronLink: {
      request: vi.fn(async () => (opts.approve === false ? { code: 4001 } : { code: 200 })),
      tronWeb,
    },
  };
  return { win, tronWeb };
}

describe('Tron deposits (TronLink)', () => {
  it('TRX: sendTrx with the exact sun', async () => {
    const { win, tronWeb } = fakeTron();
    const adapter = createTronAdapter(payTargetFor(TRX)!, { win });
    expect(await adapter.connect()).toEqual({ address: SHOPPER });
    expect(await adapter.sendDeposit(trx)).toEqual({ txHash: TXID });
    expect(tronWeb.transactionBuilder.sendTrx).toHaveBeenCalledWith(DEPOSIT, 25000001, SHOPPER);
    expect(tronWeb.transactionBuilder.triggerSmartContract).not.toHaveBeenCalled();
  });

  it('USDT: TRC-20 transfer(address,uint256) with the amount as an exact string', async () => {
    const { win, tronWeb } = fakeTron();
    const adapter = createTronAdapter(payTargetFor(USDT)!, { win });
    await adapter.connect();
    await adapter.sendDeposit(usdt);
    const call = tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]!;
    expect(call[0]).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(call[1]).toBe('transfer(address,uint256)');
    expect(call[3]).toEqual([
      { type: 'address', value: DEPOSIT },
      { type: 'uint256', value: '84000000' },
    ]);
    expect(call[4]).toBe(SHOPPER);
    expect(tronWeb.transactionBuilder.sendTrx).not.toHaveBeenCalled();
  });

  it('a TronLink on a test network blocks the send', async () => {
    const { win, tronWeb } = fakeTron({ host: 'https://nile.trongrid.io' });
    const adapter = createTronAdapter(payTargetFor(TRX)!, { win });
    await adapter.connect();
    const err = await adapter.sendDeposit(trx).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('chain_mismatch');
    expect((err as WalletError).network).toBe('Tron');
    expect(tronWeb.trx.sign).not.toHaveBeenCalled();
  });

  it('no TronLink in this window → unavailable', async () => {
    const adapter = createTronAdapter(payTargetFor(TRX)!, { win: {} });
    const err = await adapter.connect().catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('unavailable');
  });

  it('a refused connection is a cancellation', async () => {
    const { win } = fakeTron({ approve: false });
    const err = await createTronAdapter(payTargetFor(TRX)!, { win })
      .connect()
      .catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('rejected');
  });

  it('refuses TRX amounts a JS number cannot hold exactly', async () => {
    const { win, tronWeb } = fakeTron();
    const adapter = createTronAdapter(payTargetFor(TRX)!, { win });
    await adapter.connect();
    await expect(
      adapter.sendDeposit({ ...trx, amount: '9007199254740993' }),
    ).rejects.toBeInstanceOf(WalletError);
    expect(tronWeb.transactionBuilder.sendTrx).not.toHaveBeenCalled();
  });

  it('signed, then the broadcast failed: possibly sent, with the signed tx id kept', async () => {
    const { win, tronWeb } = fakeTron();
    tronWeb.trx.sendRawTransaction.mockRejectedValueOnce(new Error('network down'));
    const adapter = createTronAdapter(payTargetFor(USDT)!, { win });
    await adapter.connect();
    const err = await adapter.sendDeposit(usdt).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('uncertain');
    expect((err as WalletError).txHash).toBe(TXID);
  });

  it('a broadcast the network refused is a failed payment, with its tx id kept', async () => {
    const { win, tronWeb } = fakeTron();
    tronWeb.trx.sendRawTransaction.mockResolvedValueOnce({ result: false, code: 'BANDWITH_ERROR' });
    const adapter = createTronAdapter(payTargetFor(TRX)!, { win });
    await adapter.connect();
    const err = await adapter.sendDeposit(trx).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('onchain_failed');
    expect((err as WalletError).txHash).toBe(TXID);
  });

  it('onSigned records the signed tx id BEFORE the broadcast', async () => {
    const { win, tronWeb } = fakeTron();
    const order: string[] = [];
    tronWeb.trx.sendRawTransaction.mockImplementationOnce(async () => {
      order.push('broadcast');
      return { result: true, txid: TXID };
    });
    const adapter = createTronAdapter(payTargetFor(USDT)!, { win });
    await adapter.connect();
    await adapter.sendDeposit(usdt, {
      onSigned: (id) => {
        order.push('signed:' + id);
      },
    });
    expect(order).toEqual(['signed:' + TXID, 'broadcast']);
  });

  it('a duplicate-transaction refusal is "possibly sent"; a sign error is too, a refusal is not', async () => {
    const { win, tronWeb } = fakeTron();
    const adapter = createTronAdapter(payTargetFor(TRX)!, { win });
    await adapter.connect();
    tronWeb.trx.sendRawTransaction.mockResolvedValueOnce({
      result: false,
      code: 'DUP_TRANSACTION_ERROR',
    });
    const dup = (await adapter.sendDeposit(trx).catch((e: unknown) => e)) as WalletError;
    expect(dup.kind).toBe('uncertain');
    expect(dup.txHash).toBe(TXID);
    tronWeb.trx.sign.mockRejectedValueOnce(new Error('extension disconnected'));
    expect(((await adapter.sendDeposit(trx).catch((e: unknown) => e)) as WalletError).kind).toBe(
      'uncertain',
    );
    tronWeb.trx.sign.mockRejectedValueOnce(new Error('Confirmation declined by user'));
    expect(((await adapter.sendDeposit(trx).catch((e: unknown) => e)) as WalletError).kind).toBe(
      'rejected',
    );
  });
});
