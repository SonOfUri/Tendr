import { describe, expect, it, vi } from 'vitest';
import { WalletError } from '../errors';
import type { Eip1193 } from '../evm';
import { encodeErc20Transfer } from '../evm';
import { payTargetFor } from '../index';
import { createEvmGasless } from './evm';
import {
  GaslessMismatchError,
  gaslessNonce,
  type GaslessExpectation,
  type PreparePayload,
} from './index';

const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const FEE_TO = '0x3333333333333333333333333333333333333333';
const FORWARDER = '0x19BEBC71495490A99cA6F50F107076967380cf09';
const OTHER = '0x4444444444444444444444444444444444444444';
const SENTINEL = '0x7E57000000000000000000000000000000007E57';
const DEADLINE = '2026-10-28T12:12:00.000Z';
const DEADLINE_S = String(Date.parse(DEADLINE) / 1000);
const PREFIX = 'https://api.tendr.test/v1/checkout/paymaster/';
const SIG = '0x' + 'ab'.repeat(65);
const target = payTargetFor(USDC_BASE)!;

const DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const TWA = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

function expectation(fee: bigint, method: GaslessExpectation['method'] = 'eip3009') {
  return {
    quoteId: 'quo_1',
    method,
    target,
    wallet: WALLET,
    depositAddress: DEPOSIT,
    amount: 25_000_000n,
    fee,
    deadline: DEADLINE,
    livemode: true,
    feeRecipient: FEE_TO,
  } satisfies GaslessExpectation;
}

const tokenDomain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: TOKEN };

function auth(kind: 'payment' | 'fee', to: string, value: string) {
  return {
    kind,
    typed_data: {
      domain: { ...tokenDomain },
      types: { EIP712Domain: DOMAIN_TYPE, TransferWithAuthorization: TWA },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: WALLET,
        to,
        value,
        validAfter: '0',
        validBefore: DEADLINE_S,
        nonce: gaslessNonce('quo_1', kind),
      },
    },
  };
}

function prepared3009(fee: bigint): PreparePayload {
  return {
    quote_id: 'quo_1',
    method: 'eip3009',
    chain: 'base',
    chain_id: 8453,
    signer: WALLET,
    deadline: DEADLINE,
    amount: '25000000',
    fee_amount: fee.toString(),
    to_sign:
      fee > 0n
        ? [auth('payment', DEPOSIT, '25000000'), auth('fee', FEE_TO, fee.toString())]
        : [auth('payment', DEPOSIT, '25000000')],
  };
}

function preparedPermit(fee: bigint): PreparePayload {
  return {
    ...prepared3009(fee),
    method: 'permit',
    to_sign: [
      {
        kind: 'permit',
        typed_data: {
          domain: { ...tokenDomain },
          types: {
            EIP712Domain: DOMAIN_TYPE,
            Permit: [
              { name: 'owner', type: 'address' },
              { name: 'spender', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          primaryType: 'Permit',
          message: {
            owner: WALLET,
            spender: FORWARDER,
            value: (25_000_000n + fee).toString(),
            nonce: '0',
            deadline: DEADLINE_S,
          },
        },
      },
      {
        kind: 'tendr_payment',
        typed_data: {
          domain: {
            name: 'TendrForwarder',
            version: '1',
            chainId: 8453,
            verifyingContract: FORWARDER,
          },
          types: {
            EIP712Domain: DOMAIN_TYPE,
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
            token: TOKEN,
            from: WALLET,
            to: DEPOSIT,
            amount: '25000000',
            fee: fee.toString(),
            feeTo: FEE_TO,
            deadline: DEADLINE_S,
            nonce: gaslessNonce('quo_1', 'tendr_payment'),
          },
        },
      },
    ],
  };
}

function preparedPaymaster(fee: bigint): PreparePayload {
  return {
    ...prepared3009(fee),
    method: 'paymaster',
    to_sign: [],
    calls: [
      { to: TOKEN, value: '0x0', data: encodeErc20Transfer(DEPOSIT, 25_000_000n) },
      ...(fee > 0n ? [{ to: TOKEN, value: '0x0', data: encodeErc20Transfer(FEE_TO, fee) }] : []),
    ],
    paymaster_url: `${PREFIX}${'A'.repeat(43)}`,
  };
}

function wallet(
  opts: {
    code?: string;
    caps?: unknown;
    accounts?: string[];
    status?: unknown;
    chainId?: number;
  } = {},
) {
  const calls: { method: string; params?: unknown }[] = [];
  const provider: Eip1193 = {
    request: vi.fn(async ({ method, params }) => {
      calls.push({ method, params });
      switch (method) {
        case 'eth_chainId':
          return '0x' + (opts.chainId ?? 8453).toString(16);
        case 'eth_accounts':
          return opts.accounts ?? [WALLET];
        case 'eth_getCode':
          return opts.code ?? '0x';
        case 'wallet_getCapabilities':
          if (opts.caps === undefined) throw new Error('Method not supported');
          return opts.caps;
        case 'eth_getBalance':
          return '0xde0b6b3a7640000';
        case 'eth_signTypedData_v4':
          return SIG;
        case 'wallet_sendCalls':
          return { id: 'calls-1' };
        case 'wallet_getCallsStatus':
          return (
            opts.status ?? { status: 200, receipts: [{ transactionHash: '0x' + 'cd'.repeat(32) }] }
          );
        default:
          throw new Error('unexpected ' + method);
      }
    }),
  };
  const signer = createEvmGasless(target, {
    provider: () => provider,
    address: () => WALLET,
    forwarder: FORWARDER,
    paymasterUrlPrefix: PREFIX,
    sleep: async () => {},
  });
  return { signer, calls };
}

const signed = (calls: { method: string; params?: unknown }[]) =>
  calls.filter((c) => c.method === 'eth_signTypedData_v4' || c.method === 'wallet_sendCalls');

async function refused(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GaslessMismatchError);
  return (err as GaslessMismatchError).field;
}

describe('EVM gasless: which methods this wallet can sign for', () => {
  it('an ordinary wallet: 3009 then permit, no paymaster without the capability', async () => {
    const { signer, calls } = wallet();
    expect(await signer.methods()).toEqual(['eip3009', 'permit']);
    // Never asks the wallet to delegate itself (EIP-7702).
    expect(calls.some((c) => /7702|authori[sz]ation|delegat/i.test(c.method))).toBe(false);
  });

  it('a wallet reporting paymasterService for this chain also gets the paymaster, last', async () => {
    const { signer } = wallet({ caps: { '0x2105': { paymasterService: { supported: true } } } });
    expect(await signer.methods()).toEqual(['eip3009', 'permit', 'paymaster']);
  });

  it('paymasterService on another chain only does not count', async () => {
    const { signer } = wallet({ caps: { '0x1': { paymasterService: { supported: true } } } });
    expect(await signer.methods()).toEqual(['eip3009', 'permit']);
  });

  it('a smart account cannot sign 3009/permit (no ECDSA): the paymaster only, if offered', async () => {
    const code = '0x6080604052';
    expect(
      await wallet({
        code,
        caps: { '0x2105': { paymasterService: { supported: true } } },
      }).signer.methods(),
    ).toEqual(['paymaster']);
    expect(await wallet({ code }).signer.methods()).toEqual([]);
  });

  it('an EOA with an EIP-7702 delegation its wallet manages still signs 3009', async () => {
    const code = '0xef0100' + '44'.repeat(20);
    expect(await wallet({ code }).signer.methods()).toEqual(['eip3009', 'permit']);
  });

  it('reads the native balance', async () => {
    expect(await wallet().signer.nativeBalance()).toBe(10n ** 18n);
  });
});

describe('EVM gasless: EIP-3009', () => {
  it('sponsored: signs exactly the payment authorization', async () => {
    const { signer, calls } = wallet();
    const p = prepared3009(0n);
    const r = await signer.sign(p, expectation(0n));
    expect(r).toEqual({
      kind: 'submit',
      body: {
        signatures: {
          payment: {
            message:
              p.to_sign[0]!.typed_data &&
              (p.to_sign[0]!.typed_data as { message: unknown }).message,
            signature: SIG,
          },
        },
      },
    });
    const sig = signed(calls);
    expect(sig).toHaveLength(1);
    expect(sig[0]!.params).toEqual([WALLET, JSON.stringify(p.to_sign[0]!.typed_data)]);
  });

  it('shopper pays: the payment and the fee leg', async () => {
    const { signer, calls } = wallet();
    const r = await signer.sign(prepared3009(96_000n), expectation(96_000n));
    expect(r.kind === 'submit' && Object.keys(r.body.signatures!)).toEqual(['payment', 'fee']);
    expect(signed(calls)).toHaveLength(2);
  });

  const tamper = (fee: bigint, f: (p: PreparePayload) => void) => {
    const p = prepared3009(fee);
    f(p);
    return p;
  };
  const msg = (p: PreparePayload, i: number) =>
    (p.to_sign[i]!.typed_data as { message: Record<string, string> }).message;
  const dom = (p: PreparePayload, i: number) =>
    (p.to_sign[i]!.typed_data as { domain: Record<string, unknown> }).domain;

  it.each<[string, bigint, (p: PreparePayload) => void, string]>([
    ['another destination', 0n, (p) => (msg(p, 0).to = FEE_TO), 'payment.to'],
    ['another amount', 0n, (p) => (msg(p, 0).value = '25000001'), 'payment.value'],
    ['another signer', 0n, (p) => (msg(p, 0).from = DEPOSIT), 'payment.from'],
    ['another token', 0n, (p) => (dom(p, 0).verifyingContract = FEE_TO), 'payment.domain'],
    ['another chain', 0n, (p) => (dom(p, 0).chainId = 1), 'payment.domain'],
    [
      'a later deadline',
      0n,
      (p) => (msg(p, 0).validBefore = String(Number(DEADLINE_S) + 1)),
      'payment.validBefore',
    ],
    ['an extra field', 0n, (p) => (msg(p, 0).memo = 'x'), 'payment.message'],
    ['a fee leg nobody quoted', 0n, (p) => p.to_sign.push(auth('fee', FEE_TO, '1')), 'to_sign'],
    ['a missing fee leg', 96_000n, (p) => p.to_sign.pop(), 'to_sign'],
    ['another fee', 96_000n, (p) => (msg(p, 1).value = '96001'), 'fee.value'],
    ['the fee to the deposit address', 96_000n, (p) => (msg(p, 1).to = DEPOSIT), 'fee.to'],
    ['the fee back to the wallet', 96_000n, (p) => (msg(p, 1).to = WALLET), 'fee.to'],
    // Ruling T10-g: the fee goes exactly to Tendr's gas-fee account.
    ['the fee to anyone else', 96_000n, (p) => (msg(p, 1).to = OTHER), 'fee.to'],
    // m6: one nonce per quote and leg.
    ['a fresh nonce', 0n, (p) => (msg(p, 0).nonce = '0x' + '01'.repeat(32)), 'payment.nonce'],
    // Ruling T10-f: live never signs the test-mode domain.
    [
      'the test-mode domain in live mode',
      0n,
      (p) => (dom(p, 0).name = 'Tendr test payment'),
      'payment.domain',
    ],
    [
      'a different primary type',
      0n,
      (p) => ((p.to_sign[0]!.typed_data as { primaryType: string }).primaryType = 'Permit'),
      'payment.primaryType',
    ],
  ])('refuses %s before the wallet is asked', async (_name, fee, f, field) => {
    const { signer, calls } = wallet();
    expect(await refused(signer.sign(tamper(fee, f), expectation(fee)))).toBe(field);
    expect(signed(calls)).toEqual([]);
  });

  it('refuses when the wallet switched accounts', async () => {
    const { signer, calls } = wallet({ accounts: [FEE_TO] });
    const err = await signer.sign(prepared3009(0n), expectation(0n)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).kind).toBe('account_changed');
    expect(signed(calls)).toEqual([]);
  });
});

describe('EVM gasless: permit + TendrPayment', () => {
  it('signs the permit to the forwarder for amount + fee, then the TendrPayment', async () => {
    const { signer, calls } = wallet();
    const r = await signer.sign(preparedPermit(96_000n), expectation(96_000n, 'permit'));
    expect(r.kind === 'submit' && Object.keys(r.body.signatures!)).toEqual([
      'permit',
      'tendr_payment',
    ]);
    expect(signed(calls)).toHaveLength(2);
  });

  const m = (p: PreparePayload, i: number) =>
    (p.to_sign[i]!.typed_data as { message: Record<string, string> }).message;

  it.each<[string, (p: PreparePayload) => void, string]>([
    ['a spender that is not the forwarder', (p) => (m(p, 0).spender = FEE_TO), 'permit.spender'],
    ['an allowance above amount + fee', (p) => (m(p, 0).value = '26000000'), 'permit.value'],
    ['another destination', (p) => (m(p, 1).to = FEE_TO), 'tendr_payment.to'],
    ['another fee', (p) => (m(p, 1).fee = '1'), 'tendr_payment.fee'],
    ['the fee to the deposit address', (p) => (m(p, 1).feeTo = DEPOSIT), 'tendr_payment.feeTo'],
    ['the fee to anyone else', (p) => (m(p, 1).feeTo = OTHER), 'tendr_payment.feeTo'],
    ['a fresh nonce', (p) => (m(p, 1).nonce = '0x' + '03'.repeat(32)), 'tendr_payment.nonce'],
    ['another token', (p) => (m(p, 1).token = FEE_TO), 'tendr_payment.token'],
    [
      'another forwarder domain',
      (p) =>
        ((
          p.to_sign[1]!.typed_data as { domain: Record<string, unknown> }
        ).domain.verifyingContract = FEE_TO),
      'tendr_payment.domain',
    ],
  ])('refuses %s', async (_n, f, field) => {
    const p = preparedPermit(96_000n);
    f(p);
    const { signer, calls } = wallet();
    expect(await refused(signer.sign(p, expectation(96_000n, 'permit')))).toBe(field);
    expect(signed(calls)).toEqual([]);
  });
});

describe('EVM gasless: EIP-5792 paymaster', () => {
  const caps = { '0x2105': { paymasterService: { supported: true } } };

  it('sends exactly the quoted calls with the quote paymaster URL and waits for the receipt', async () => {
    const { signer, calls } = wallet({ caps });
    const p = preparedPaymaster(96_000n);
    const r = await signer.sign(p, expectation(96_000n, 'paymaster'));
    expect(r).toEqual({ kind: 'wallet_sent', txHash: '0x' + 'cd'.repeat(32), state: 'sent' });
    const send = calls.find((c) => c.method === 'wallet_sendCalls')!;
    expect(send.params).toEqual([
      {
        version: '2.0.0',
        chainId: '0x2105',
        from: WALLET,
        atomicRequired: true,
        calls: p.calls,
        capabilities: { paymasterService: { url: p.paymaster_url } },
      },
    ]);
  });

  it('a failed batch is reported as failed on chain', async () => {
    const { signer } = wallet({ caps, status: { status: 500, receipts: [] } });
    const err = await signer
      .sign(preparedPaymaster(0n), expectation(0n, 'paymaster'))
      .catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('onchain_failed');
  });

  it.each<[string, (p: PreparePayload) => void, string]>([
    [
      'another destination',
      (p) => (p.calls![0]!.data = encodeErc20Transfer(FEE_TO, 25_000_000n)),
      'calls',
    ],
    ['another amount', (p) => (p.calls![0]!.data = encodeErc20Transfer(DEPOSIT, 1n)), 'calls'],
    ['an extra call', (p) => p.calls!.push({ ...p.calls![0]! }), 'calls'],
    ['a call with value', (p) => (p.calls![0]!.value = '0x1'), 'calls'],
    ['another token', (p) => (p.calls![0]!.to = FEE_TO), 'calls'],
    [
      'a foreign paymaster URL',
      (p) => (p.paymaster_url = 'https://evil.example/pm'),
      'paymaster_url',
    ],
  ])('refuses %s', async (_n, f, field) => {
    const p = preparedPaymaster(0n);
    f(p);
    const { signer, calls } = wallet({ caps });
    expect(await refused(signer.sign(p, expectation(0n, 'paymaster')))).toBe(field);
    expect(signed(calls)).toEqual([]);
  });
});

describe('EVM gasless: test mode (ruling T10-f)', () => {
  const testDomain = {
    name: 'Tendr test payment',
    version: '1',
    chainId: 8453,
    verifyingContract: SENTINEL,
  };
  const testMode = (fee: bigint, method: GaslessExpectation['method'] = 'eip3009') => ({
    ...expectation(fee, method),
    livemode: false,
  });
  const onTestDomain = (p: PreparePayload) => {
    for (const t of p.to_sign) (t.typed_data as { domain: unknown }).domain = { ...testDomain };
    return p;
  };

  it('signs only the test domain at the code-less sentinel (3009 and permit)', async () => {
    const { signer, calls } = wallet();
    await signer.sign(onTestDomain(prepared3009(96_000n)), testMode(96_000n));
    await signer.sign(onTestDomain(preparedPermit(96_000n)), testMode(96_000n, 'permit'));
    expect(signed(calls)).toHaveLength(4);
  });

  it('refuses a real-chain payload in test mode, before the wallet is asked', async () => {
    const { signer, calls } = wallet();
    expect(await refused(signer.sign(prepared3009(0n), testMode(0n)))).toBe('payment.domain');
    expect(await refused(signer.sign(preparedPermit(0n), testMode(0n, 'permit')))).toBe(
      'permit.domain',
    );
    expect(signed(calls)).toEqual([]);
  });

  it('refuses the test domain in live mode', async () => {
    const { signer, calls } = wallet();
    expect(await refused(signer.sign(onTestDomain(prepared3009(0n)), expectation(0n)))).toBe(
      'payment.domain',
    );
    expect(signed(calls)).toEqual([]);
  });

  it('never uses the paymaster in test mode', async () => {
    const { signer, calls } = wallet({
      caps: { '0x2105': { paymasterService: { supported: true } } },
    });
    expect(await refused(signer.sign(preparedPaymaster(0n), testMode(0n, 'paymaster')))).toBe(
      'method',
    );
    expect(signed(calls)).toEqual([]);
  });

  it('the paymaster fee transfer goes exactly to the fee recipient', async () => {
    const { signer } = wallet({ caps: { '0x2105': { paymasterService: { supported: true } } } });
    const p = preparedPaymaster(96_000n);
    p.calls![1]!.data = encodeErc20Transfer(OTHER, 96_000n);
    expect(await refused(signer.sign(p, expectation(96_000n, 'paymaster')))).toBe('calls.1');
  });

  it('a shopper-paid fee with no known recipient is refused', async () => {
    const { signer } = wallet();
    expect(
      await refused(
        signer.sign(prepared3009(96_000n), { ...expectation(96_000n), feeRecipient: null }),
      ),
    ).toBe('fee.to');
  });
});
