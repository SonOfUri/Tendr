import { describe, expect, it } from 'vitest';
import type { Token } from '@/lib/checkout/api';
import { payTargetFor } from '../index';
import {
  GaslessMismatchError,
  assertPrepareMatches,
  defaultFeeMode,
  expectationFor,
  feeChoiceAvailable,
  gaslessMethodOf,
  nativeFeeUnits,
  pickOption,
  quoteFee,
  resolveFeeRecipient,
  unavailableReason,
  type GaslessOption,
  type PreparePayload,
} from './index';

const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const target = payTargetFor(USDC_BASE)!;

const sponsored = (method: GaslessOption['method']): GaslessOption => ({
  method,
  paid_by: 'merchant',
  reason: null,
  fee_modes: [],
  token_fee: null,
});
const shopperPays = (method: GaslessOption['method']): GaslessOption => ({
  method,
  paid_by: 'shopper',
  reason: 'not_sponsored',
  fee_modes: ['token', 'native'],
  token_fee: { amount: '96000', symbol: 'USDC', decimals: 6, usd: '0.096' },
});

const QUOTE = {
  id: 'quo_1',
  deposit_address: DEPOSIT,
  amount_in: '25000000',
  deadline: '2026-10-28T12:12:00.000Z',
  fee_amount: '96000',
  network_fee: {
    method: 'eip3009',
    fee_mode: 'token' as const,
    paid_by: 'shopper' as const,
    amount: '96000',
  },
};
const FEE_TO = '0x3333333333333333333333333333333333333333';
const opts = { livemode: true, feeRecipient: FEE_TO };

function prepared(over: Partial<PreparePayload> = {}): PreparePayload {
  return {
    quote_id: 'quo_1',
    method: 'eip3009',
    chain: 'base',
    chain_id: 8453,
    signer: WALLET.toUpperCase().replace('0X', '0x'),
    deadline: QUOTE.deadline,
    amount: '25000000',
    fee_amount: '96000',
    to_sign: [],
    ...over,
  };
}

describe('method choice', () => {
  it("takes the first of the wallet's methods the API offers", () => {
    const opts = [sponsored('eip3009'), sponsored('permit'), sponsored('paymaster')];
    expect(pickOption(opts, ['eip3009', 'permit', 'paymaster'])!.method).toBe('eip3009');
    // A smart account cannot sign 3009/permit: only the paymaster is left.
    expect(pickOption(opts, ['paymaster'])!.method).toBe('paymaster');
    // A wallet without paymasterService never gets the paymaster.
    expect(pickOption([sponsored('paymaster')], ['eip3009', 'permit'])).toBeNull();
    expect(pickOption(opts, [])).toBeNull();
  });

  it('skips a method the account cannot use, and says why', () => {
    const near: GaslessOption = {
      ...sponsored('meta_tx'),
      unavailable_reason: 'near_account_needs_balance',
    };
    expect(pickOption([near], ['meta_tx'])).toBeNull();
    expect(unavailableReason([near], ['meta_tx'])).toBe('near_account_needs_balance');
    expect(unavailableReason([near], [])).toBeNull();
  });

  it('offers the fee choice only when the shopper pays and both ways exist', () => {
    expect(feeChoiceAvailable(sponsored('eip3009'))).toBe(false);
    expect(feeChoiceAvailable(shopperPays('eip3009'))).toBe(true);
    expect(feeChoiceAvailable({ ...shopperPays('eip3009'), fee_modes: ['token'] })).toBe(false);
    expect(feeChoiceAvailable(null)).toBe(false);
  });

  it('defaults to the token, and to the coin when the wallet holds twice the coin fee', () => {
    expect(defaultFeeMode(null, 100n)).toBe('token');
    expect(defaultFeeMode(199n, 100n)).toBe('token');
    expect(defaultFeeMode(200n, 100n)).toBe('native');
    expect(defaultFeeMode(10n ** 18n, null)).toBe('token');
  });

  it('prices the coin fee from USD, rounded up', () => {
    const eth: Token = {
      asset_id: 'nep141:base.omft.near',
      symbol: 'ETH',
      blockchain: 'base',
      decimals: 18,
      price_usd: '2500',
      popular: true,
    };
    // $0.096 / $2500 = 0.0000384 ETH
    expect(nativeFeeUnits('0.096', eth)).toBe(38_400_000_000_000n);
    expect(nativeFeeUnits('0.1', { ...eth, price_usd: 3 })).toBe(33_333_333_333_333_334n);
    expect(nativeFeeUnits('0.1', { ...eth, price_usd: null })).toBeNull();
    expect(nativeFeeUnits(null, eth)).toBeNull();
    expect(nativeFeeUnits('0.1', null)).toBeNull();
  });
});

describe('the quote → what may be signed', () => {
  it('a gasless quote binds the method, amounts and deadline; a native one is not gasless', () => {
    const e = expectationFor(QUOTE, target, WALLET, opts)!;
    expect(e).toMatchObject({ method: 'eip3009', amount: 25_000_000n, fee: 96_000n });
    expect(e.feeRecipient).toBe(FEE_TO);
    expect(gaslessMethodOf({ network_fee: { method: 'eip3009', fee_mode: 'native' } })).toBeNull();
    expect(gaslessMethodOf({ network_fee: { method: 'native', fee_mode: 'native' } })).toBeNull();
    expect(gaslessMethodOf({ network_fee: null })).toBeNull();
    expect(gaslessMethodOf({ network_fee: { method: 'paymaster', fee_mode: null } })).toBe(
      'paymaster',
    );
    expect(
      expectationFor({ ...QUOTE, fee_amount: null, network_fee: null }, target, WALLET, opts),
    ).toBeNull();
  });

  it('accepts a matching payload (addresses compared without case on EVM)', () => {
    const e = expectationFor(QUOTE, target, WALLET, opts)!;
    expect(() => assertPrepareMatches(prepared(), e)).not.toThrow();
  });

  it.each([
    ['quote_id', { quote_id: 'quo_2' }],
    ['method', { method: 'permit' as const }],
    ['chain', { chain: 'arb' }],
    ['chain_id', { chain_id: 1 }],
    ['signer', { signer: DEPOSIT }],
    ['amount', { amount: '25000001' }],
    ['fee_amount', { fee_amount: '0' }],
    ['deadline', { deadline: '2026-10-28T12:12:01.000Z' }],
  ])('refuses a payload with another %s', (field, over) => {
    const e = expectationFor(QUOTE, target, WALLET, opts)!;
    const err = (() => {
      try {
        assertPrepareMatches(prepared(over as Partial<PreparePayload>), e);
      } catch (x) {
        return x;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(GaslessMismatchError);
    expect((err as GaslessMismatchError).field).toBe(field);
  });
});

describe('the fee signed is the fee shown (I1)', () => {
  const field = (fn: () => unknown) => {
    try {
      fn();
    } catch (x) {
      expect(x).toBeInstanceOf(GaslessMismatchError);
      return (x as GaslessMismatchError).field;
    }
    return null;
  };
  const sponsored = {
    ...QUOTE,
    fee_amount: null,
    network_fee: { method: 'eip3009', fee_mode: null, paid_by: 'merchant' as const, amount: null },
  };

  it('merchant sponsors: the fee is 0', () => {
    expect(expectationFor(sponsored, target, WALLET, opts)!.fee).toBe(0n);
    expect(quoteFee(sponsored)).toBe(0n);
  });

  it('"paid by {merchant}" with a fee_amount anyway: refused, never signed', () => {
    expect(
      field(() => expectationFor({ ...sponsored, fee_amount: '500000' }, target, WALLET, opts)),
    ).toBe('fee_amount');
  });

  it('the shopper pays in the token: fee_amount must equal the fee line amount', () => {
    expect(quoteFee(QUOTE)).toBe(96_000n);
    const shown = (amount: string | null) => ({
      ...QUOTE,
      network_fee: { ...QUOTE.network_fee, amount },
    });
    expect(field(() => expectationFor(shown('95999'), target, WALLET, opts))).toBe('fee_amount');
    expect(field(() => expectationFor(shown(null), target, WALLET, opts))).toBe('fee_amount');
    expect(field(() => expectationFor({ ...QUOTE, fee_amount: null }, target, WALLET, opts))).toBe(
      'fee_amount',
    );
    expect(field(() => expectationFor({ ...QUOTE, fee_amount: '0' }, target, WALLET, opts))).toBe(
      'fee_amount',
    );
  });
});

describe("the fee recipient (T10-g): the API's value, pinned in config", () => {
  const API = '0x3333333333333333333333333333333333333333';
  const OTHER = '0x4444444444444444444444444444444444444444';
  const UPPER = '0x' + API.slice(2).toUpperCase();
  it.each<[string, string | null, string | undefined, boolean, string | null]>([
    ['live, pinned and equal (case-insensitive on EVM)', API, UPPER, true, API],
    ['live, pinned and different', API, OTHER, true, null],
    ['live, not pinned', API, undefined, true, null],
    ['test mode, not pinned: the API value', API, undefined, false, API],
    ['test mode, pinned and different', API, OTHER, false, null],
    ['no API value', null, API, true, null],
  ])('%s', (_n, api, pinned, livemode, want) => {
    expect(resolveFeeRecipient(api, pinned, 'evm', livemode)).toBe(want);
  });

  it('other chains compare exactly', () => {
    expect(resolveFeeRecipient('alice.near', 'alice.near', 'near', true)).toBe('alice.near');
    expect(resolveFeeRecipient('Abc', 'abc', 'solana', true)).toBeNull();
  });
});
