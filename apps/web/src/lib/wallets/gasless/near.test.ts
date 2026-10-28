import { describe, expect, it, vi } from 'vitest';
import { payTargetFor } from '../index';
import { createNearGasless } from './near';
import { GaslessMismatchError, type GaslessExpectation, type PreparePayload } from './index';

const USDT = 'nep141:usdt.tether-token.near';
const target = payTargetFor(USDT)!;
const WALLET = 'alice.near';
const DEPOSIT = 'a'.repeat(64);
const FEE_TO = 'b'.repeat(64);
const DEADLINE = new Date(Date.now() + 10 * 60_000).toISOString();

const transfer = (to: string, amount: string, gas = '15000000000000') => ({
  type: 'FunctionCall',
  params: { methodName: 'ft_transfer', args: { receiver_id: to, amount }, gas, deposit: '1' },
});

function prepared(
  fee: bigint,
  actions?: unknown[],
  over: Record<string, unknown> = {},
): PreparePayload {
  return {
    quote_id: 'quo_1',
    method: 'meta_tx',
    chain: 'near',
    chain_id: null,
    signer: WALLET,
    deadline: DEADLINE,
    amount: '25000000',
    fee_amount: fee.toString(),
    to_sign: [
      {
        kind: 'near_delegate_action',
        typed_data: {
          sender_id: WALLET,
          receiver_id: 'usdt.tether-token.near',
          actions: actions ?? [
            transfer(DEPOSIT, '25000000'),
            ...(fee > 0n ? [transfer(FEE_TO, fee.toString())] : []),
          ],
          max_block_height: '120000600',
          block_height_ttl: 570,
          relayer_id: 'c'.repeat(64),
          expires_at: DEADLINE,
          ...over,
        },
      },
    ],
  };
}

const expectation = (fee: bigint): GaslessExpectation => ({
  quoteId: 'quo_1',
  method: 'meta_tx',
  target,
  wallet: WALLET,
  depositAddress: DEPOSIT,
  amount: 25_000_000n,
  fee,
  deadline: DEADLINE,
  livemode: true,
  feeRecipient: FEE_TO,
});

function signer(supported = true) {
  const signDelegate = vi.fn(async () => 'AAECAw==');
  const s = createNearGasless(target, {
    address: () => WALLET,
    signDelegate: () => (supported ? signDelegate : null),
  });
  return { s, signDelegate };
}

describe('NEAR gasless (delegate actions)', () => {
  it('is offered only for wallets that sign delegate actions', async () => {
    expect(await signer().s.methods()).toEqual(['meta_tx']);
    expect(await signer(false).s.methods()).toEqual([]);
  });

  it('signs exactly the quoted ft_transfer(s) with the TTL given', async () => {
    const { s, signDelegate } = signer();
    const p = prepared(96_000n);
    const r = await s.sign(p, expectation(96_000n));
    const td = p.to_sign[0]!.typed_data as { actions: unknown[] };
    expect(signDelegate).toHaveBeenCalledWith({
      receiverId: 'usdt.tether-token.near',
      actions: td.actions,
      blockHeightTtl: 570,
    });
    expect(r).toEqual({ kind: 'submit', body: { signed_delegate: 'AAECAw==' } });
  });

  it.each<[string, bigint, () => PreparePayload, string]>([
    ['another destination', 0n, () => prepared(0n, [transfer(FEE_TO, '25000000')]), 'actions[0]'],
    ['another amount', 0n, () => prepared(0n, [transfer(DEPOSIT, '25000001')]), 'actions[0]'],
    [
      'a fee leg nobody quoted',
      0n,
      () => prepared(0n, [transfer(DEPOSIT, '25000000'), transfer(FEE_TO, '1')]),
      'actions',
    ],
    [
      'the fee to the deposit address',
      96_000n,
      () => prepared(96_000n, [transfer(DEPOSIT, '25000000'), transfer(DEPOSIT, '96000')]),
      'actions[1]',
    ],
    [
      'another token contract',
      0n,
      () => prepared(0n, undefined, { receiver_id: 'evil.near' }),
      'receiver_id',
    ],
    ['another sender', 0n, () => prepared(0n, undefined, { sender_id: 'bob.near' }), 'sender_id'],
    [
      'a different method',
      0n,
      () =>
        prepared(0n, [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'ft_transfer_call',
              args: { receiver_id: DEPOSIT, amount: '25000000' },
              gas: '15000000000000',
              deposit: '1',
            },
          },
        ]),
      'actions[0]',
    ],
    [
      'more than 1 yocto attached',
      0n,
      () =>
        prepared(0n, [
          {
            ...transfer(DEPOSIT, '25000000'),
            params: { ...transfer(DEPOSIT, '25000000').params, deposit: '2' },
          },
        ]),
      'actions[0]',
    ],
    [
      'a memo',
      0n,
      () =>
        prepared(0n, [
          {
            ...transfer(DEPOSIT, '25000000'),
            params: {
              ...transfer(DEPOSIT, '25000000').params,
              args: { receiver_id: DEPOSIT, amount: '25000000', memo: 'x' },
            },
          },
        ]),
      'actions[0]',
    ],
    ['no TTL', 0n, () => prepared(0n, undefined, { block_height_ttl: 0 }), 'block_height_ttl'],
    [
      'a TTL far past the deadline',
      0n,
      () => prepared(0n, undefined, { block_height_ttl: 100_000 }),
      'block_height_ttl',
    ],
    [
      'the fee to anyone else',
      96_000n,
      () => prepared(96_000n, [transfer(DEPOSIT, '25000000'), transfer('c'.repeat(64), '96000')]),
      'actions[1]',
    ],
    [
      'the test-mode receiver in live mode',
      0n,
      () => prepared(0n, undefined, { receiver_id: 'tendr-test-payment.test.invalid' }),
      'receiver_id',
    ],
  ])('refuses %s before the wallet is asked', async (_n, fee, make, field) => {
    const { s, signDelegate } = signer();
    const err = await s.sign(make(), expectation(fee)).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(GaslessMismatchError);
    expect((err as GaslessMismatchError).field).toBe(field);
    expect(signDelegate).not.toHaveBeenCalled();
  });
});

describe('NEAR gasless: test mode (T10-f)', () => {
  const test = { ...expectation(0n), livemode: false };

  it('delegates only to the test receiver, which cannot exist', async () => {
    const { s, signDelegate } = signer();
    await s.sign(prepared(0n, undefined, { receiver_id: 'tendr-test-payment.test.invalid' }), test);
    expect(signDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ receiverId: 'tendr-test-payment.test.invalid' }),
    );
    const err = await s.sign(prepared(0n), test).catch((x: unknown) => x);
    expect((err as GaslessMismatchError).field).toBe('receiver_id');
    expect(signDelegate).toHaveBeenCalledTimes(1);
  });
});
