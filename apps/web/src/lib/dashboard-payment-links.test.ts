import { describe, expect, it } from 'vitest';
import { linkBody, linkFields, type DashboardPaymentLink } from './dashboard-payment-links';

const existing: DashboardPaymentLink = {
  id: 'pl_test',
  title: 'Coffee',
  description: 'Monthly',
  slug: 'coffee',
  url: 'http://localhost:3300/store/coffee?mode=test',
  qr_url: 'http://localhost:3300/store/coffee/qr?mode=test',
  livemode: false,
  amount_type: 'fixed',
  amount: '25.00',
  currency: 'USD',
  min_amount: null,
  note: 'optional',
  status: 'active',
  archived: false,
  availability: 'available',
  expires_at: '2020-01-01T12:00:21.123Z',
  max_uses: 10,
  use_count: 0,
  settlement_asset: null,
  settlement_symbol: null,
  settlement_chain: null,
};

describe('dashboard payment-link payloads', () => {
  it('saves an exact asset id and clears it when switching back to the store default', () => {
    const fields = {
      ...linkFields(),
      title: 'Coffee',
      amount: '5.00',
      settlementAsset: 'nep141:base.omft.near',
    };
    expect(linkBody(fields)).toMatchObject({ settlement_asset: 'nep141:base.omft.near' });
    expect(linkBody({ ...fields, settlementAsset: '' }, existing)).toMatchObject({
      settlement_asset: null,
    });
    expect(() => linkBody({ ...fields, settlementAsset: 'USDC' })).toThrow('settlement_asset');
  });
  it('preserves decimal precision and lets the API generate the URL name', () => {
    const body = linkBody({
      ...linkFields(),
      title: ' Coffee ',
      amount: '9007199254740993.01',
      currency: 'usd',
    });
    expect(body).toMatchObject({ title: 'Coffee', amount: '9007199254740993.01', currency: 'USD' });
    expect(body).not.toHaveProperty('slug');
    expect(body).not.toHaveProperty('min_amount');
  });

  it('switches to open amount without leaking the previous fixed amount or changing the slug', () => {
    const body = linkBody(
      { ...linkFields(existing), amountType: 'open', minimum: '2.50' },
      existing,
    );
    expect(body).toMatchObject({ amount_type: 'open', min_amount: '2.50' });
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('slug');
  });

  it('clears optional fields and an open minimum explicitly on edit', () => {
    expect(
      linkBody(
        {
          ...linkFields(existing),
          amountType: 'open',
          minimum: '',
          description: '',
          expires: '',
          maxUses: '',
        },
        existing,
      ),
    ).toMatchObject({ min_amount: null, description: null, expires_at: null, max_uses: null });
  });

  it('does not resend an unchanged past expiry when editing other fields', () => {
    expect(linkBody({ ...linkFields(existing), title: 'New name' }, existing)).not.toHaveProperty(
      'expires_at',
    );
  });

  it('rejects invalid amounts, unsafe use counts, and reserved URL names before sending', () => {
    const fields = { ...linkFields(), title: 'Coffee', amount: '25.00' };
    expect(() => linkBody({ ...fields, amount: '1e3' })).toThrow('amount');
    expect(() => linkBody({ ...fields, maxUses: '1.5' })).toThrow('whole number');
    expect(() => linkBody({ ...fields, maxUses: '9007199254740993' })).toThrow('whole number');
    expect(() => linkBody({ ...fields, slug: 'dashboard' })).toThrow('reserved');
  });
});
