import { describe, expect, it } from 'vitest';
import { linkedStore, withoutStoreLink } from './store-link';

const stores = [{ id: 'mer_A' }, { id: 'mer_B' }];

describe('linkedStore (?store=&mode= on dashboard links)', () => {
  it('does nothing without a store parameter', () => {
    expect(linkedStore('', stores)).toEqual({ kind: 'none' });
    expect(linkedStore('?mode=live', stores)).toEqual({ kind: 'none' });
  });

  it('switches to a store the person is a member of, in the linked mode', () => {
    expect(linkedStore('?store=mer_B&mode=live', stores)).toEqual({
      kind: 'switch',
      ctx: { merchantId: 'mer_B', livemode: true },
    });
    expect(linkedStore('?store=mer_A&mode=test', stores)).toEqual({
      kind: 'switch',
      ctx: { merchantId: 'mer_A', livemode: false },
    });
  });

  it('is not found for a store the person is not a member of, or a bad mode', () => {
    expect(linkedStore('?store=mer_Z&mode=live', stores)).toEqual({ kind: 'not-found' });
    expect(linkedStore('?store=mer_A&mode=prod', stores)).toEqual({ kind: 'not-found' });
    expect(linkedStore('?store=mer_A', stores)).toEqual({ kind: 'not-found' });
  });

  it('drops only the link parameters from the address', () => {
    expect(withoutStoreLink('/dashboard/payments/pay_1', '?store=mer_A&mode=live&x=1')).toBe(
      '/dashboard/payments/pay_1?x=1',
    );
    expect(withoutStoreLink('/dashboard/payments/pay_1', '?store=mer_A&mode=live')).toBe(
      '/dashboard/payments/pay_1',
    );
  });
});
