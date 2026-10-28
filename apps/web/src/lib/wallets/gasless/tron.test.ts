import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it, vi } from 'vitest';
import { base58Encode } from '@/lib/base58';
import { payTargetFor } from '../index';
import { createTronGasless, tronAddressHex } from './tron';
import { GaslessMismatchError, type GaslessExpectation, type PreparePayload } from './index';

const USDT = 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near';
const target = payTargetFor(USDT)!;

/** A base58check Tron address from 20 bytes. */
function tronAddress(fill: number): string {
  const body = new Uint8Array([0x41, ...new Array<number>(20).fill(fill)]);
  const check = sha256(sha256(body)).slice(0, 4);
  return base58Encode(new Uint8Array([...body, ...check]));
}
const WALLET = tronAddress(0x11);
const DEPOSIT = tronAddress(0x22);
const FEE_TO = tronAddress(0x33);
const FORWARDER = tronAddress(0x44);
const TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEADLINE = '2026-10-28T12:12:00.000Z';
const DEADLINE_MS = Date.parse(DEADLINE);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const evmHex = (a: string) => '0x' + tronAddressHex(a).slice(2);

// Minimal protobuf writer for Transaction.raw.
function varint(n: bigint): number[] {
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return out;
}
const fieldVarint = (f: number, v: bigint) => [...varint(BigInt((f << 3) | 0)), ...varint(v)];
const fieldBytes = (f: number, b: Uint8Array | number[]) => [
  ...varint(BigInt((f << 3) | 2)),
  ...varint(BigInt(b.length)),
  ...b,
];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

function approveData(spender: string, value: bigint): string {
  return (
    '095ea7b3' +
    tronAddressHex(spender).slice(2).padStart(64, '0') +
    value.toString(16).padStart(64, '0')
  );
}

function raw(opts: {
  owner?: string;
  contract?: string;
  data?: string;
  expiration?: number;
  feeLimit?: number;
  callValue?: bigint;
  extraContract?: boolean;
}) {
  const trigger = [
    ...fieldBytes(1, unhex(tronAddressHex(opts.owner ?? WALLET))),
    ...fieldBytes(2, unhex(tronAddressHex(opts.contract ?? TOKEN))),
    ...(opts.callValue ? fieldVarint(3, opts.callValue) : []),
    ...fieldBytes(4, unhex(opts.data ?? approveData(FORWARDER, 25_096_000n))),
  ];
  const any = [
    ...fieldBytes(1, utf8('type.googleapis.com/protocol.TriggerSmartContract')),
    ...fieldBytes(2, trigger),
  ];
  const contract = [...fieldVarint(1, 31n), ...fieldBytes(2, any)];
  return new Uint8Array([
    ...fieldBytes(1, [0xab, 0xcd]),
    ...fieldBytes(4, new Array<number>(8).fill(7)),
    ...fieldVarint(8, BigInt(opts.expiration ?? DEADLINE_MS)),
    ...fieldBytes(11, contract),
    ...(opts.extraContract ? fieldBytes(11, contract) : []),
    ...fieldVarint(14, 1_700_000_000_000n),
    ...fieldVarint(18, BigInt(opts.feeLimit ?? 30_000_000)),
  ]);
}

function approvePayload(
  bytes: Uint8Array = raw({}),
  over: Record<string, unknown> = {},
): PreparePayload {
  return {
    quote_id: 'quo_1',
    method: 'forwarder',
    chain: 'tron',
    chain_id: 728126428,
    signer: WALLET,
    deadline: DEADLINE,
    amount: '25000000',
    fee_amount: '96000',
    step: 'approve',
    to_sign: [
      {
        kind: 'tron_approve',
        typed_data: {
          transaction: {
            txID: hex(sha256(bytes)),
            raw_data: {},
            raw_data_hex: hex(bytes),
            visible: false,
          },
          owner: WALLET,
          token: TOKEN,
          spender: FORWARDER,
          value: '25096000',
          fee_limit: '30000000',
          expiration: DEADLINE,
          ...over,
        },
      },
    ],
  };
}

function paymentPayload(
  over: Record<string, string> = {},
  domainOver: Record<string, unknown> = {},
): PreparePayload {
  return {
    ...approvePayload(),
    step: 'payment',
    to_sign: [
      {
        kind: 'tendr_payment',
        typed_data: {
          domain: {
            name: 'TendrForwarder',
            version: '1',
            chainId: 728126428,
            verifyingContract: evmHex(FORWARDER),
            ...domainOver,
          },
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
            TendrPayment: [
              { name: 'token', type: 'address' },
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'fee', type: 'uint256' },
              { name: 'feeTo', type: 'address' },
              { name: 'deadline', type: 'uint256' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
          primaryType: 'TendrPayment',
          message: {
            token: evmHex(TOKEN),
            from: evmHex(WALLET),
            to: evmHex(DEPOSIT),
            amount: '25000000',
            fee: '96000',
            feeTo: evmHex(FEE_TO),
            deadline: String(DEADLINE_MS / 1000),
            nonce: '0x' + '05'.repeat(32),
            ...over,
          },
        },
      },
    ],
  };
}

const expectation: GaslessExpectation = {
  quoteId: 'quo_1',
  method: 'forwarder',
  target,
  wallet: WALLET,
  depositAddress: DEPOSIT,
  amount: 25_000_000n,
  fee: 96_000n,
  deadline: DEADLINE,
  livemode: true,
};
const SIG = 'ab'.repeat(65);

function signer(opts: { typed?: boolean; forwarder?: string | null } = {}) {
  const sign = vi.fn(async (tx: { txID: string }) => ({ ...tx, signature: [SIG] }));
  const sendRawTransaction = vi.fn();
  const signTypedData = vi.fn(async () => '0x' + SIG);
  const tronWeb = {
    defaultAddress: { base58: WALLET },
    trx: {
      sign,
      sendRawTransaction,
      getBalance: async () => 42_000_000,
      ...(opts.typed === false ? {} : { signTypedData }),
    },
  };
  const s = createTronGasless(target, {
    win: { tronLink: { request: async () => ({ code: 200 }), tronWeb } } as never,
    address: () => WALLET,
    forwarder: opts.forwarder === undefined ? FORWARDER : opts.forwarder,
  });
  return { s, sign, sendRawTransaction, signTypedData };
}

async function refused(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GaslessMismatchError);
  return (err as GaslessMismatchError).field;
}

describe('Tron gasless (approve + TendrPayment)', () => {
  it('offers the forwarder only with TIP-712 signing and a configured forwarder', async () => {
    expect(await signer().s.methods()).toEqual(['forwarder']);
    expect(await signer({ typed: false }).s.methods()).toEqual([]);
    expect(await signer({ forwarder: null }).s.methods()).toEqual([]);
    expect(await signer().s.nativeBalance()).toBe(42_000_000n);
  });

  it('step 1: signs the exact approve and hands it back unbroadcast', async () => {
    const { s, sign, sendRawTransaction } = signer();
    const p = approvePayload();
    const r = await s.sign(p, expectation);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(r).toEqual({
      kind: 'submit',
      body: {
        tron_approve: {
          raw_data_hex: (p.to_sign[0]!.typed_data as { transaction: { raw_data_hex: string } })
            .transaction.raw_data_hex,
          signature: SIG,
        },
      },
    });
  });

  it.each<[string, () => PreparePayload, string]>([
    [
      'an allowance above amount + fee',
      () => approvePayload(raw({ data: approveData(FORWARDER, 25_096_001n) })),
      'approve.data',
    ],
    [
      'another spender',
      () => approvePayload(raw({ data: approveData(FEE_TO, 25_096_000n) })),
      'approve.data',
    ],
    ['another token', () => approvePayload(raw({ contract: DEPOSIT })), 'approve.contract'],
    ['another owner', () => approvePayload(raw({ owner: DEPOSIT })), 'approve.owner'],
    ['TRX attached', () => approvePayload(raw({ callValue: 1n })), 'approve.call_value'],
    ['a second contract', () => approvePayload(raw({ extraContract: true })), 'approve.contract'],
    [
      'a later expiration',
      () => approvePayload(raw({ expiration: DEADLINE_MS + 1 })),
      'approve.expiration',
    ],
    ['a high fee limit', () => approvePayload(raw({ feeLimit: 31_000_000 })), 'approve.fee_limit'],
    [
      'a txID that is not the raw data',
      () => {
        const p = approvePayload();
        (p.to_sign[0]!.typed_data as { transaction: { txID: string } }).transaction.txID =
          'ff'.repeat(32);
        return p;
      },
      'approve.txID',
    ],
  ])('refuses %s before the wallet is asked', async (_n, make, field) => {
    const { s, sign } = signer();
    expect(await refused(s.sign(make(), expectation))).toBe(field);
    expect(sign).not.toHaveBeenCalled();
  });

  it('step 2: signs the TendrPayment with TIP-712', async () => {
    const { s, signTypedData } = signer();
    const p = paymentPayload();
    const r = await s.sign(p, expectation);
    const td = p.to_sign[0]!.typed_data as {
      domain: unknown;
      types: { TendrPayment: unknown };
      message: Record<string, string>;
    };
    expect(signTypedData).toHaveBeenCalledWith(
      td.domain,
      { TendrPayment: td.types.TendrPayment },
      td.message,
    );
    expect(r).toEqual({
      kind: 'submit',
      body: { signatures: { tendr_payment: { message: td.message, signature: '0x' + SIG } } },
    });
  });

  it.each<[string, () => PreparePayload, string]>([
    ['another destination', () => paymentPayload({ to: evmHex(FEE_TO) }), 'tendr_payment.to'],
    ['another amount', () => paymentPayload({ amount: '1' }), 'tendr_payment.amount'],
    [
      'the fee to the deposit address',
      () => paymentPayload({ feeTo: evmHex(DEPOSIT) }),
      'tendr_payment.feeTo',
    ],
    ['another token', () => paymentPayload({ token: evmHex(DEPOSIT) }), 'tendr_payment.token'],
    [
      'another forwarder',
      () => paymentPayload({}, { verifyingContract: evmHex(FEE_TO) }),
      'tendr_payment.domain',
    ],
    ['another chain', () => paymentPayload({}, { chainId: 3448148188 }), 'tendr_payment.domain'],
  ])('refuses %s', async (_n, make, field) => {
    const { s, signTypedData } = signer();
    expect(await refused(s.sign(make(), expectation))).toBe(field);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('test mode signs for Nile', async () => {
    const { s } = signer();
    await expect(
      s.sign(paymentPayload({}, { chainId: 3448148188 }), { ...expectation, livemode: false }),
    ).resolves.toMatchObject({ kind: 'submit' });
  });
});
