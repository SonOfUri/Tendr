import { describe, expect, it, vi } from 'vitest';
import { WalletError } from './errors';
import type { WalletAdapter } from './index';
import { runWalletPay, type WalletSendResult } from './pay';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const quote = {
  id: 'quo_01JAAAAAAAAAAAAAAAAAAAAAAA',
  deadline: '2026-10-26T12:05:00Z',
  deposit_address: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
  amount_in: '84000000',
  origin_asset: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
};

function adapter(send: WalletAdapter['sendDeposit']): WalletAdapter {
  return {
    chainFamily: 'tron',
    connect: async () => ({ address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' }),
    sendDeposit: vi.fn(send),
    disconnect: async () => {},
  };
}

function run(a: WalletAdapter, over: Partial<Parameters<typeof runWalletPay>[0]> = {}) {
  const recorded: WalletSendResult[] = [];
  const p = runWalletPay({
    quote,
    decimals: 6,
    now: () => NOW,
    adapter: a,
    checkBeforeSend: async () => 'ok',
    record: (r) => recorded.push(r),
    ...over,
  });
  return { p, recorded };
}

describe('runWalletPay', () => {
  it('a sent payment is recorded with the quote bound before the wallet opened', async () => {
    const a = adapter(async () => ({ txHash: 'c'.repeat(64) }));
    const { p, recorded } = run(a);
    expect(await p).toEqual({ kind: 'sent' });
    expect(recorded).toEqual([{ txHash: 'c'.repeat(64), quoteId: quote.id, state: 'sent' }]);
    expect(a.sendDeposit).toHaveBeenCalledWith(
      {
        depositAddress: quote.deposit_address,
        assetId: quote.origin_asset,
        amount: quote.amount_in,
        decimals: 6,
      },
      expect.objectContaining({ onSigned: expect.any(Function) }),
    );
  });

  it('a price about to run out is renewed; the wallet is never opened', async () => {
    const a = adapter(async () => ({ txHash: 'x' }));
    const { p } = run(a, { now: () => Date.parse(quote.deadline) - 5000 });
    expect(await p).toEqual({ kind: 'requote' });
    expect(a.sendDeposit).not.toHaveBeenCalled();
  });

  it("the session is re-fetched before sending: another tab's deposit aborts into the block", async () => {
    const a = adapter(async () => ({ txHash: 'x' }));
    const blocked = run(a, { checkBeforeSend: async () => 'blocked' });
    expect(await blocked.p).toEqual({ kind: 'blocked' });
    const failed = run(a, { checkBeforeSend: async () => 'error' });
    expect(await failed.p).toEqual({ kind: 'check_failed' });
    expect(a.sendDeposit).not.toHaveBeenCalled();
  });

  it('onSigned persists the tx id as possibly sent before the broadcast; success upgrades it', async () => {
    const order: string[] = [];
    const a = adapter(async (_q, hooks) => {
      hooks?.onSigned?.('d'.repeat(64));
      order.push('broadcast');
      return { txHash: 'd'.repeat(64) };
    });
    const { p, recorded } = run(a, {
      record: (r) => {
        order.push('record:' + r.state);
        recorded.push(r);
      },
    });
    await p;
    expect(order).toEqual(['record:uncertain', 'broadcast', 'record:sent']);
    expect(recorded[0]).toEqual({
      txHash: 'd'.repeat(64),
      quoteId: quote.id,
      state: 'uncertain',
      persistOnly: true,
    });
  });

  it('after the wallet signed, a failure is recorded (possibly sent / failed), never a retry', async () => {
    const u = run(
      adapter(async () => Promise.reject(new WalletError('uncertain', { txHash: 'e'.repeat(64) }))),
    );
    expect(await u.p).toEqual({ kind: 'recorded' });
    expect(u.recorded).toEqual([{ txHash: 'e'.repeat(64), quoteId: quote.id, state: 'uncertain' }]);
    const f = run(
      adapter(async () =>
        Promise.reject(new WalletError('onchain_failed', { txHash: 'f'.repeat(64) })),
      ),
    );
    expect(await f.p).toEqual({ kind: 'recorded' });
    expect(f.recorded[0]!.state).toBe('failed');
  });

  it('before signing: an account switch re-quotes, anything else is a plain error', async () => {
    const acc = run(
      adapter(async () => Promise.reject(new WalletError('account_changed', { address: '0xabc' }))),
    );
    expect(await acc.p).toEqual({ kind: 'account_changed', address: '0xabc' });
    expect(acc.recorded).toEqual([]);
    const err = new WalletError('rejected');
    const rej = run(adapter(async () => Promise.reject(err)));
    expect(await rej.p).toEqual({ kind: 'error', error: err });
    expect(rej.recorded).toEqual([]);
  });
});
