import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_DEFAULTS_SCOPE_NOTE,
  explorerTxUrl,
  feeLines,
  formatUsd,
  heldReturnForms,
  type FeeLine,
  type Refund,
} from './payments';

const USDC_TEST = 'nep141:usdc.fakes.testnet';

describe('formatUsd (no floats)', () => {
  it('rounds half up to cents with string arithmetic', () => {
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd('0.125')).toBe('$0.13');
    expect(formatUsd('0.124999')).toBe('$0.12');
    expect(formatUsd('12.5')).toBe('$12.50');
    expect(formatUsd('1234567.995')).toBe('$1,234,568.00');
    // Beyond what a float can hold exactly.
    expect(formatUsd('90071992547409931.01')).toBe('$90,071,992,547,409,931.01');
  });

  it('shows tiny non-zero values as under a cent, and passes junk through', () => {
    expect(formatUsd('0.004')).toBe('< $0.01');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd('1e5')).toBe('1e5');
  });
});

describe('feeLines', () => {
  const line = (o: Partial<FeeLine>): FeeLine => ({
    kind: 'tendr_fee',
    asset: USDC_TEST,
    amount: '125000',
    amount_usd: '0.125',
    estimated: false,
    ...o,
  });

  it('labels each fee, formats registered amounts by decimals and marks estimates', () => {
    const out = feeLines(
      [
        line({}),
        line({ kind: 'oneclick_fee', amount: '1000000', amount_usd: '1' }),
        line({ kind: 'network_fee', amount: '500000', amount_usd: '0.5', estimated: true }),
        line({ kind: 'gas_reimbursement', amount: '10000', amount_usd: '0.01', estimated: true }),
      ],
      false,
    );
    expect(out).toEqual([
      { label: 'Tendr fee', amount: '0.125 USDC', usd: '$0.13', estimated: false },
      { label: '1Click fee and spread', amount: '1 USDC', usd: '$1.00', estimated: false },
      {
        label: 'Network fee (estimated)',
        amount: '0.5 USDC',
        usd: '$0.50',
        estimated: true,
      },
      {
        label: 'Gas reimbursement (estimated)',
        amount: '0.01 USDC',
        usd: '$0.01',
        estimated: true,
      },
    ]);
  });

  it('an unregistered asset stays in raw base units with its full id', () => {
    const [l] = feeLines(
      [line({ asset: 'nep141:x.near', amount: '123456789012345678901234567890' })],
      false,
    );
    expect(l!.amount).toBe('123456789012345678901234567890 smallest units of nep141:x.near');
    expect(l!.usd).toBe('$0.13');
  });

  it('an unknown fee kind is labelled "Other fee"', () => {
    expect(feeLines([line({ kind: 'other' })], false)[0]!.label).toBe('Other fee');
  });

  it('an unknown USD value shows a dash', () => {
    expect(feeLines([line({ amount_usd: null })], false)[0]!.usd).toBe('—');
  });
});

describe('explorerTxUrl', () => {
  it('links NEAR and EVM transactions per mode; unknown chains get no link', () => {
    expect(explorerTxUrl('near', 'abc', true)).toBe('https://nearblocks.io/txns/abc');
    expect(explorerTxUrl('near', 'abc', false)).toBe('https://testnet.nearblocks.io/txns/abc');
    expect(explorerTxUrl('eth', '0x1', true)).toBe('https://etherscan.io/tx/0x1');
    expect(explorerTxUrl('mystery', '0x1', true)).toBeNull();
    expect(explorerTxUrl(null, '0x1', true)).toBeNull();
  });
});

describe('checkout settings copy (M-6)', () => {
  it('labels the fee and gas payer defaults as applying to test and live', () => {
    expect(CHECKOUT_DEFAULTS_SCOPE_NOTE).toMatch(/fee and gas/i);
    expect(CHECKOUT_DEFAULTS_SCOPE_NOTE).toMatch(/applies to test and live/i);
  });
});

describe('held review card: one destination form per open return (C41)', () => {
  const refund = (over: Partial<Refund>): Refund => ({
    id: 'ref_1',
    payment_id: 'pay_1',
    reason: 'sanctions',
    status: 'pending',
    asset: 'nep141:usdc.test',
    amount: '1',
    return_fee: null,
    destination: null,
    destination_chain: null,
    needs_address: false,
    review_reason: null,
    proposal_id: null,
    refund_tx_hash: null,
    acknowledged_legal_at: null,
    created_at: '2026-10-26T00:00:00Z',
    ...over,
  });

  it('an order-amount return and an excess return each get a form with their own refund_id', () => {
    const forms = heldReturnForms({
      status: 'HELD',
      kept_small_reasons: [],
      refunds: [
        refund({ id: 'ref_s', reason: 'sanctions' }),
        refund({ id: 'ref_o', reason: 'overpaid', review_reason: 'sanctions' }),
      ],
    });
    expect(forms).toEqual([
      { refundId: 'ref_s', label: 'Order amount' },
      { refundId: 'ref_o', label: 'Extra paid' },
    ]);
  });

  it('a return with a proposal (or sent, or kept) has no form; the others keep theirs', () => {
    const forms = heldReturnForms({
      status: 'REFUNDED',
      kept_small_reasons: [],
      refunds: [
        refund({ id: 'ref_s', reason: 'sanctions', proposal_id: 'prop_1' }),
        refund({ id: 'ref_c', reason: 'late', status: 'confirmed' }),
        refund({ id: 'ref_k', reason: 'underpaid', status: 'failed', review_reason: 'kept_small' }),
        refund({ id: 'ref_o', reason: 'overpaid', review_reason: 'sanctions' }),
      ],
    });
    expect(forms).toEqual([{ refundId: 'ref_o', label: 'Extra paid' }]);
  });

  it('a held payment whose order-amount return is not queued yet gets a form without refund_id', () => {
    expect(
      heldReturnForms({
        status: 'HELD',
        kept_small_reasons: [],
        refunds: [refund({ id: 'ref_o', reason: 'overpaid', review_reason: 'sanctions' })],
      }),
    ).toEqual([
      { refundId: null, label: 'Order amount' },
      { refundId: 'ref_o', label: 'Extra paid' },
    ]);
    // Kept small: nothing to queue for the order amount.
    expect(
      heldReturnForms({ status: 'HELD', kept_small_reasons: ['sanctions'], refunds: [] }),
    ).toEqual([]);
  });
});
