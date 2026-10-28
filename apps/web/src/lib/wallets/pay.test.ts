import { describe, expect, it, vi } from 'vitest';
import { WalletError } from './errors';
import { payTargetFor, type WalletAdapter } from './index';
import { runGaslessPay, runWalletPay, type WalletSendResult } from './pay';
import { CheckoutApiError } from '@/lib/checkout/api';
import {
  GaslessExpiredError,
  GaslessMismatchError,
  type GaslessExpectation,
  type GaslessSigner,
  type PreparePayload,
  type SubmissionView,
  type SubmitResponse,
} from './gasless/index';

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

// ---------------------------------------------------------------------------------------------
// Gasless: prepare → check → sign → submit → poll (ruling T10-d)
// ---------------------------------------------------------------------------------------------

const EVM_QUOTE = {
  id: 'quo_1',
  deadline: '2026-10-26T12:05:00Z',
};
const target = payTargetFor('nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near')!;
const expect3009: GaslessExpectation = {
  quoteId: 'quo_1',
  method: 'eip3009',
  target,
  wallet: '0x1111111111111111111111111111111111111111',
  depositAddress: '0x2222222222222222222222222222222222222222',
  amount: 25_000_000n,
  fee: 0n,
  deadline: EVM_QUOTE.deadline,
  livemode: true,
  feeRecipient: '0x3333333333333333333333333333333333333333',
};
const PREPARED: PreparePayload = {
  quote_id: 'quo_1',
  method: 'eip3009',
  chain: 'base',
  chain_id: 8453,
  signer: expect3009.wallet,
  deadline: EVM_QUOTE.deadline,
  amount: '25000000',
  fee_amount: '0',
  to_sign: [{ kind: 'payment', typed_data: {} }],
};
const HASH = '0x' + 'ab'.repeat(32);
const apiError = (status: number, code: string, details?: unknown) =>
  new CheckoutApiError(status, code, code, details);

function gaslessApi(o: {
  prepare?: (n: number) => Promise<PreparePayload>;
  submit?: (n: number) => Promise<SubmitResponse>;
  submissions?: SubmissionView[];
}) {
  let p = 0;
  let s = 0;
  const polls = [...(o.submissions ?? [])];
  return {
    gaslessOptions: vi.fn(),
    gaslessPrepare: vi.fn(async () => (o.prepare ? o.prepare(p++) : PREPARED)),
    gaslessSubmit: vi.fn(async (): Promise<SubmitResponse> =>
      o.submit ? o.submit(s++) : { submission_id: 'gas_1', status: 'confirmed', tx_hash: HASH },
    ),
    gaslessSubmission: vi.fn(async (id: string): Promise<SubmissionView> => {
      const next = polls.shift();
      if (!next) return { id, quote_id: 'quo_1', status: 'submitted', tx_hash: null };
      return next;
    }),
  };
}

function gaslessSigner(sign?: GaslessSigner['sign']): GaslessSigner {
  return {
    methods: async () => ['eip3009'],
    nativeBalance: async () => null,
    sign: vi.fn(sign ?? (async () => ({ kind: 'submit' as const, body: { signatures: {} } }))),
  };
}

function runGasless(
  api: ReturnType<typeof gaslessApi>,
  signer: GaslessSigner,
  over: Partial<Parameters<typeof runGaslessPay>[0]> = {},
) {
  const recorded: WalletSendResult[] = [];
  const progress: string[] = [];
  const p = runGaslessPay({
    quote: EVM_QUOTE,
    expect: expect3009,
    api,
    signer,
    now: () => NOW,
    checkBeforeSend: async () => 'ok',
    record: (r) => recorded.push(r),
    onProgress: (x) => progress.push(x),
    sleep: async () => {},
    pollTimeoutMs: 10_000,
    pollMs: 1000,
    ...over,
  });
  return { p, recorded, progress };
}

describe('runGaslessPay', () => {
  it('sponsored: prepares, signs, submits, and records the relay as sent (already reported)', async () => {
    const api = gaslessApi({});
    const signer = gaslessSigner();
    const { p, recorded, progress } = runGasless(api, signer);
    expect(await p).toEqual({ kind: 'sent' });
    expect(api.gaslessPrepare).toHaveBeenCalledWith({ quote_id: 'quo_1' });
    expect(signer.sign).toHaveBeenCalledWith(PREPARED, expect3009);
    expect(api.gaslessSubmit).toHaveBeenCalledWith({ quote_id: 'quo_1', signatures: {} });
    expect(recorded).toEqual([
      { txHash: HASH, quoteId: 'quo_1', state: 'sent', alreadyReported: true },
    ]);
    expect(progress).toEqual(['preparing', 'signing', 'confirming']);
  });

  it('a payload that does not match the quote is never signed or submitted', async () => {
    const api = gaslessApi({ prepare: async () => ({ ...PREPARED, amount: '1' }) });
    const signer = gaslessSigner();
    const { p, recorded } = runGasless(api, signer);
    expect(await p).toEqual({ kind: 'mismatch' });
    expect(signer.sign).not.toHaveBeenCalled();
    expect(api.gaslessSubmit).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    // The family check (inside sign) refuses the same way.
    const api2 = gaslessApi({});
    const s2 = gaslessSigner(async () => {
      throw new GaslessMismatchError('payment.to');
    });
    expect(await runGasless(api2, s2).p).toEqual({ kind: 'mismatch' });
    expect(api2.gaslessSubmit).not.toHaveBeenCalled();
  });

  it('polls a submitted relay until confirmed', async () => {
    const api = gaslessApi({
      submit: async () => ({ submission_id: 'gas_1', status: 'submitted', tx_hash: HASH }),
      submissions: [
        { id: 'gas_1', quote_id: 'quo_1', status: 'submitted', tx_hash: HASH },
        { id: 'gas_1', quote_id: 'quo_1', status: 'confirmed', tx_hash: HASH },
      ],
    });
    const { p, recorded } = runGasless(api, gaslessSigner());
    expect(await p).toEqual({ kind: 'sent' });
    expect(api.gaslessSubmission).toHaveBeenCalledTimes(2);
    expect(recorded[0]!.state).toBe('sent');
  });

  it('a relay that failed records nothing and can be tried again', async () => {
    const api = gaslessApi({
      submit: async () => ({ submission_id: 'gas_1', status: 'submitted', tx_hash: HASH }),
      submissions: [{ id: 'gas_1', quote_id: 'quo_1', status: 'failed', tx_hash: HASH }],
    });
    const { p, recorded } = runGasless(api, gaslessSigner());
    expect(await p).toEqual({ kind: 'relay_failed', reason: null });
    expect(recorded).toEqual([]);
  });

  it('a relay still unresolved after the wait is recorded as possibly sent', async () => {
    let t = NOW;
    const api = gaslessApi({
      submit: async () => ({ submission_id: 'gas_1', status: 'submitted', tx_hash: HASH }),
    });
    const { p, recorded } = runGasless(api, gaslessSigner(), {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(await p).toEqual({ kind: 'recorded' });
    expect(recorded).toEqual([
      { txHash: HASH, quoteId: 'quo_1', state: 'uncertain', alreadyReported: true },
    ]);
  });

  it('CONFLICT: an earlier attempt is still being confirmed — it is polled, not re-signed', async () => {
    const api = gaslessApi({
      prepare: async () => {
        throw apiError(409, 'CONFLICT', { submission_id: 'gas_0' });
      },
      submissions: [
        { id: 'gas_0', quote_id: 'quo_1', status: 'submitted', tx_hash: HASH },
        { id: 'gas_0', quote_id: 'quo_1', status: 'confirmed', tx_hash: HASH },
      ],
    });
    const signer = gaslessSigner();
    const { p, recorded, progress } = runGasless(api, signer);
    expect(await p).toEqual({ kind: 'sent' });
    expect(progress).toContain('previous_attempt');
    expect(signer.sign).not.toHaveBeenCalled();
    expect(api.gaslessSubmission).toHaveBeenCalledWith('gas_0');
    expect(recorded[0]!.txHash).toBe(HASH);
  });

  it('CONFLICT whose earlier attempt failed: prepares again and signs', async () => {
    const api = gaslessApi({
      prepare: async (n) => {
        if (n === 0) throw apiError(409, 'CONFLICT', { submission_id: 'gas_0' });
        return PREPARED;
      },
      submissions: [{ id: 'gas_0', quote_id: 'quo_1', status: 'failed', tx_hash: null }],
    });
    const signer = gaslessSigner();
    expect(await runGasless(api, signer).p).toEqual({ kind: 'sent' });
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });

  it('GASLESS_EXPIRED: prepares again and asks the wallet again (once), then asks the shopper', async () => {
    const api = gaslessApi({
      submit: async (n) => {
        if (n === 0) throw apiError(409, 'GASLESS_EXPIRED');
        return { submission_id: 'gas_1', status: 'confirmed', tx_hash: HASH };
      },
    });
    const signer = gaslessSigner();
    expect(await runGasless(api, signer).p).toEqual({ kind: 'sent' });
    expect(api.gaslessPrepare).toHaveBeenCalledTimes(2);
    expect(signer.sign).toHaveBeenCalledTimes(2);

    const always = gaslessApi({
      submit: async () => {
        throw apiError(409, 'GASLESS_EXPIRED');
      },
    });
    expect(await runGasless(always, gaslessSigner()).p).toEqual({ kind: 'sign_again' });
  });

  it('a payload past its own signing window is prepared again before the wallet is asked', async () => {
    const api = gaslessApi({});
    let n = 0;
    const signer = gaslessSigner(async () => {
      if (n++ === 0) throw new GaslessExpiredError();
      return { kind: 'submit', body: { transaction: 'AA==' } };
    });
    expect(await runGasless(api, signer).p).toEqual({ kind: 'sent' });
    expect(api.gaslessPrepare).toHaveBeenCalledTimes(2);
  });

  it.each<[string, number, { kind: string; gasless?: boolean }]>([
    ['QUOTE_EXPIRED', 409, { kind: 'requote', gasless: true }],
    ['QUOTE_PRICE_MOVED', 409, { kind: 'requote', gasless: true }],
    ['SPONSORSHIP_RELEASED', 409, { kind: 'requote', gasless: true }],
    ['GASLESS_NOT_AVAILABLE', 409, { kind: 'requote', gasless: false }],
    ['PROVIDER_UNAVAILABLE', 503, { kind: 'retry' }],
    ['NETWORK_ERROR', 0, { kind: 'retry' }],
    ['RATE_LIMITED', 429, { kind: 'rate_limited' }],
    ['GASLESS_PAYLOAD_MISMATCH', 409, { kind: 'refused_signed' }],
  ])('%s from the API → %o', async (code, status, want) => {
    const atPrepare = gaslessApi({
      prepare: async () => {
        throw apiError(status, code);
      },
    });
    expect(await runGasless(atPrepare, gaslessSigner()).p).toEqual(want);
    const atSubmit = gaslessApi({
      submit: async () => {
        throw apiError(status, code);
      },
    });
    expect(await runGasless(atSubmit, gaslessSigner()).p).toEqual(want);
  });

  it('GASLESS_SUBMIT_FAILED: nothing moved; the reason is kept', async () => {
    const api = gaslessApi({
      submit: async () => {
        throw apiError(409, 'GASLESS_SUBMIT_FAILED', { reason: 'insufficient_token_balance' });
      },
    });
    expect(await runGasless(api, gaslessSigner()).p).toEqual({
      kind: 'relay_failed',
      reason: 'insufficient_token_balance',
    });
  });

  it('Tron: the approve is submitted and confirmed, then the TendrPayment', async () => {
    const approve = { ...PREPARED, method: 'forwarder' as const, step: 'approve' as const };
    const payment = { ...approve, step: 'payment' as const };
    const api = gaslessApi({
      prepare: async (n) => (n === 0 ? approve : payment),
      submit: async (n) =>
        n === 0
          ? { submission_id: 'tap_1', status: 'pending', tx_hash: 'f'.repeat(64), step: 'approve' }
          : {
              submission_id: 'gas_2',
              status: 'confirmed',
              tx_hash: 'e'.repeat(64),
              step: 'payment',
            },
      submissions: [
        {
          id: 'tap_1',
          quote_id: 'quo_1',
          status: 'submitted',
          tx_hash: 'f'.repeat(64),
          step: 'approve',
        },
        {
          id: 'tap_1',
          quote_id: 'quo_1',
          status: 'confirmed',
          tx_hash: 'f'.repeat(64),
          step: 'approve',
        },
      ],
    });
    const signer = gaslessSigner();
    const { p, recorded } = runGasless(api, signer, {
      expect: { ...expect3009, method: 'forwarder' },
    });
    expect(await p).toEqual({ kind: 'sent' });
    expect(signer.sign).toHaveBeenCalledTimes(2);
    expect(api.gaslessSubmit).toHaveBeenCalledTimes(2);
    // Only the payment is the deposit; the approve is never recorded as one.
    expect(recorded).toEqual([
      { txHash: 'e'.repeat(64), quoteId: 'quo_1', state: 'sent', alreadyReported: true },
    ]);
  });

  it('Tron: an approve still in flight (CONFLICT, step approve) is waited for, then the payment', async () => {
    const payment = { ...PREPARED, method: 'forwarder' as const, step: 'payment' as const };
    const api = gaslessApi({
      prepare: async (n) => {
        if (n === 0) throw apiError(409, 'CONFLICT', { step: 'approve', submission_id: 'tap_1' });
        return payment;
      },
      submissions: [
        {
          id: 'tap_1',
          quote_id: 'quo_1',
          status: 'confirmed',
          tx_hash: 'f'.repeat(64),
          step: 'approve',
        },
      ],
    });
    const signer = gaslessSigner();
    expect(
      await runGasless(api, signer, { expect: { ...expect3009, method: 'forwarder' } }).p,
    ).toEqual({ kind: 'sent' });
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });

  it('EIP-5792: the wallet sent the calls itself; nothing is submitted', async () => {
    const api = gaslessApi({});
    const signer = gaslessSigner(async () => ({
      kind: 'wallet_sent',
      txHash: HASH,
      state: 'sent',
    }));
    const { p, recorded } = runGasless(api, signer);
    expect(await p).toEqual({ kind: 'sent' });
    expect(api.gaslessSubmit).not.toHaveBeenCalled();
    expect(recorded).toEqual([
      { txHash: HASH, quoteId: 'quo_1', state: 'sent', alreadyReported: true },
    ]);
  });

  it('wallet outcomes: a refusal is a plain error, an account switch re-quotes', async () => {
    const err = new WalletError('rejected');
    const rej = runGasless(
      gaslessApi({}),
      gaslessSigner(async () => Promise.reject(err)),
    );
    expect(await rej.p).toEqual({ kind: 'error', error: err });
    const acc = runGasless(
      gaslessApi({}),
      gaslessSigner(async () =>
        Promise.reject(new WalletError('account_changed', { address: '0x9' })),
      ),
    );
    expect(await acc.p).toEqual({ kind: 'account_changed', address: '0x9' });
    const failed = runGasless(
      gaslessApi({}),
      gaslessSigner(async () => Promise.reject(new WalletError('onchain_failed'))),
    );
    expect(await failed.p).toEqual({ kind: 'relay_failed', reason: null });
  });

  it('near the deadline, or when another tab paid, nothing is prepared', async () => {
    const api = gaslessApi({});
    expect(
      await runGasless(api, gaslessSigner(), {
        now: () => Date.parse(EVM_QUOTE.deadline) - 5000,
      }).p,
    ).toEqual({ kind: 'requote', gasless: true });
    expect(
      await runGasless(api, gaslessSigner(), { checkBeforeSend: async () => 'blocked' }).p,
    ).toEqual({ kind: 'blocked' });
    expect(api.gaslessPrepare).not.toHaveBeenCalled();
  });
});
