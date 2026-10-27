import { describe, expect, it } from 'vitest';
import {
  TENDR_FORWARDER_ABI,
  TENDR_PAYMENT_TYPE,
  TENDR_PAYMENT_TYPES,
  TendrPaymentSchema,
  forwarderDomain,
} from './forwarder.js';

describe('TendrForwarder types', () => {
  it('renders the same encoded type string the contract hashes', () => {
    const fields = TENDR_PAYMENT_TYPES.TendrPayment.map((f) => `${f.type} ${f.name}`).join(',');
    expect(`TendrPayment(${fields})`).toBe(TENDR_PAYMENT_TYPE);
  });

  it('matches the TendrPayment struct in the generated ABI', () => {
    const fn = TENDR_FORWARDER_ABI.find(
      (item) => item.type === 'function' && item.name === 'payWithApproval',
    );
    const struct = fn && 'inputs' in fn ? fn.inputs[0] : undefined;
    const components = struct && 'components' in struct ? struct.components : [];
    expect(components.map((c) => ({ name: c.name, type: c.type }))).toEqual(
      TENDR_PAYMENT_TYPES.TendrPayment,
    );
  });

  it('exposes the three payment entry points', () => {
    const names = TENDR_FORWARDER_ABI.filter((i) => i.type === 'function').map((i) =>
      'name' in i ? i.name : '',
    );
    expect(names).toEqual(
      expect.arrayContaining(['payWithAuthorizations', 'payWithPermit', 'payWithApproval']),
    );
  });

  it('builds the domain', () => {
    const address = '0x' + 'ab'.repeat(20);
    expect(forwarderDomain(8453, address)).toEqual({
      name: 'TendrForwarder',
      version: '1',
      chainId: 8453n,
      verifyingContract: address,
    });
    expect(() => forwarderDomain(1, 'TXYZ')).toThrow();
    expect(() => forwarderDomain(0, address)).toThrow();
  });

  it('validates a message', () => {
    const addr = '0x' + '11'.repeat(20);
    const ok = {
      token: addr,
      from: addr,
      to: addr,
      amount: '100000000',
      fee: '0',
      feeTo: addr,
      deadline: '1800000600',
      nonce: '0x' + '00'.repeat(32),
    };
    expect(TendrPaymentSchema.parse(ok)).toEqual(ok);
    expect(() => TendrPaymentSchema.parse({ ...ok, amount: '1.5' })).toThrow();
  });
});
