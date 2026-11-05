import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentLinkView } from './payment-link-types';
import {
  buildLinkPatch,
  formFromLink,
  linkAmountLabel,
  linkUsesLabel,
  type LinkForm,
} from './payment-link-form';

function link(over: Partial<PaymentLinkView> = {}): PaymentLinkView {
  return {
    id: 'plink_1',
    object: 'payment_link',
    livemode: false,
    title: 'Coffee',
    description: 'Fresh brew',
    slug: 'coffee',
    url: 'https://pay.test/coffee',
    qr_url: 'https://pay.test/coffee/qr',
    amount_type: 'fixed',
    amount: '25.00',
    currency: 'USD',
    min_amount: null,
    note: 'off',
    fee_payer: null,
    gas_payer: null,
    gas_max_usd: null,
    theme_id: null,
    status: 'active',
    archived: false,
    availability: 'available',
    expires_at: null,
    max_uses: null,
    use_count: 3,
    total_paid: '75.00',
    total_refunded: '0',
    total_paid_usd: '75.00',
    total_refunded_usd: '0',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...over,
  };
}

function withForm(base: PaymentLinkView, patch: Partial<LinkForm>): LinkForm {
  return { ...formFromLink(base), ...patch };
}

describe('buildLinkPatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an empty body when nothing changed', () => {
    const l = link();
    expect(buildLinkPatch(l, formFromLink(l))).toEqual({ body: {} });
  });

  it('sends only changed scalar fields', () => {
    const l = link();
    const out = buildLinkPatch(l, withForm(l, { title: '  Espresso  ', note: 'optional' }));
    expect(out).toEqual({ body: { title: 'Espresso', note: 'optional' } });
  });

  it('pairs currency and amount when a fixed link currency changes', () => {
    const l = link({ amount: '25.00', currency: 'USD' });
    const out = buildLinkPatch(l, withForm(l, { currency: 'eur', amount: '25.00' }));
    expect(out).toEqual({ body: { currency: 'EUR', amount: '25.00' } });
  });

  it('resends amount when switching to fixed even if the amount string is unchanged', () => {
    const l = link({ amount_type: 'open', amount: null, min_amount: '5.00' });
    const f = withForm(l, { amountType: 'fixed', amount: '10.00' });
    const out = buildLinkPatch(l, f);
    expect(out).toEqual({ body: { amount_type: 'fixed', amount: '10.00' } });
  });

  it('clears nullable fields with null when emptied', () => {
    const l = link({
      description: 'Note',
      max_uses: 5,
      theme_id: 'thm_1',
      fee_payer: 'merchant',
      gas_max_usd: '0.50',
    });
    const out = buildLinkPatch(
      l,
      withForm(l, {
        description: '   ',
        maxUses: '',
        themeId: '',
        feePayer: '',
        gasMaxUsd: '',
      }),
    );
    expect(out).toEqual({
      body: {
        description: null,
        max_uses: null,
        theme_id: null,
        fee_payer: null,
        gas_max_usd: null,
      },
    });
  });

  it('clears min_amount on an open link when the minimum is removed', () => {
    const l = link({ amount_type: 'open', amount: null, min_amount: '5.00' });
    const out = buildLinkPatch(l, withForm(l, { minAmount: '' }));
    expect(out).toEqual({ body: { min_amount: null } });
  });

  it('clears expiry with expires_at null', () => {
    const l = link({ expires_at: '2026-12-01T00:00:00Z' });
    const f = formFromLink(l);
    const out = buildLinkPatch(l, { ...f, expiresAt: '' });
    expect(out).toEqual({ body: { expires_at: null } });
  });

  it('validates title, decimals, and future expiry', () => {
    const l = link();
    expect(buildLinkPatch(l, withForm(l, { title: '  ' }))).toEqual({ error: 'Title is required' });
    expect(buildLinkPatch(l, withForm(l, { amount: 'x' }))).toEqual({
      error: 'Amount must be a decimal like 25.00',
    });
    expect(buildLinkPatch(l, withForm(l, { expiresAt: '2026-01-01T00:00' }))).toEqual({
      error: 'Expiry must be in the future',
    });
  });
});

describe('link display helpers', () => {
  it('formats amount and use labels', () => {
    expect(linkAmountLabel(link())).toBe('25.00 USD');
    expect(
      linkAmountLabel(link({ amount_type: 'open', amount: null, min_amount: '5.00' })),
    ).toBe('Open · min 5.00 USD');
    expect(linkUsesLabel(link({ use_count: 1, max_uses: null }))).toBe('1 use');
    expect(linkUsesLabel(link({ use_count: 3, max_uses: 10 }))).toBe('3 / 10');
  });
});
