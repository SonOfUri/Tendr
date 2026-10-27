import { TENDR_FORWARDER_ABI } from '@tendr/contracts';
import { Interface, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  buildToSign,
  deadlineSeconds,
  gaslessNonce,
  verifySigned,
  type EvmPaymentContext,
  type SignedParts,
  type ToSign,
} from './payment.js';
import { gaslessToken } from './tokens.js';

const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const shopper = new Wallet('0x' + '11'.repeat(32));
const stranger = new Wallet('0x' + '22'.repeat(32));
const DEPOSIT = '0x' + 'ab'.repeat(20);
const FEE_TO = '0x' + 'fe'.repeat(20);
const FORWARDER = '0x19BEBC71495490A99cA6F50F107076967380cf09';
const iface = new Interface(TENDR_FORWARDER_ABI as unknown as string);

function ctx(over: Partial<EvmPaymentContext> = {}): EvmPaymentContext {
  return {
    quoteId: 'quo_01JAAAAAAAAAAAAAAAAAAAAAAA',
    chain: 'base',
    chainId: 8453,
    token: gaslessToken('base', USDC_BASE)!,
    method: 'eip3009',
    wallet: shopper.address.toLowerCase(),
    depositAddress: DEPOSIT,
    amount: 25_150_000n,
    fee: 48_000n,
    feeTo: FEE_TO,
    forwarder: FORWARDER,
    deadline: new Date('2026-10-27T12:12:00.900Z'),
    permitNonce: 3n,
    ...over,
  };
}

async function sign(items: ToSign[], wallet = shopper): Promise<SignedParts> {
  const out: SignedParts = {};
  for (const { kind, typed_data: td } of items) {
    const types = Object.fromEntries(
      Object.entries(td.types).filter(([n]) => n !== 'EIP712Domain'),
    );
    out[kind] = {
      message: { ...td.message },
      signature: await wallet.signTypedData(td.domain, types, td.message),
    };
  }
  return out;
}

describe('EVM gasless payloads', () => {
  it('eip3009, shopper pays: payment and fee legs bound to the deposit and fee addresses, same validBefore', () => {
    const items = buildToSign(ctx());
    expect(items.map((i) => i.kind)).toEqual(['payment', 'fee']);
    const [pay, fee] = items.map((i) => i.typed_data);
    expect(pay!.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(pay!.primaryType).toBe('TransferWithAuthorization');
    expect(pay!.message).toMatchObject({
      value: '25150000',
      validAfter: '0',
      validBefore: String(Math.floor(Date.parse('2026-10-27T12:12:00Z') / 1000)),
    });
    expect(pay!.message.to!.toLowerCase()).toBe(DEPOSIT);
    expect(fee!.message.to!.toLowerCase()).toBe(FEE_TO);
    expect(fee!.message.value).toBe('48000');
    expect(fee!.message.validBefore).toBe(pay!.message.validBefore);
    expect(pay!.message.nonce).not.toBe(fee!.message.nonce);
    expect(pay!.message.nonce).toBe(gaslessNonce(ctx().quoteId, 'payment'));
  });

  it('eip3009, merchant sponsors: one signature, an empty fee leg in the call', async () => {
    const c = ctx({ fee: 0n });
    const items = buildToSign(c);
    expect(items.map((i) => i.kind)).toEqual(['payment']);
    const call = verifySigned(c, await sign(items));
    expect(call.to).toBe(FORWARDER);
    const decoded = iface.decodeFunctionData('payWithAuthorizations', call.data);
    expect(decoded[0].to.toLowerCase()).toBe(DEPOSIT);
    expect(decoded[0].value).toBe(25_150_000n);
    expect(decoded[0].validBefore).toBe(deadlineSeconds(c.deadline));
    expect(decoded[1].value).toBe(0n);
  });

  it('eip3009, shopper pays: the call carries both signed legs', async () => {
    const c = ctx();
    const call = verifySigned(c, await sign(buildToSign(c)));
    const [pay, fee] = iface.decodeFunctionData('payWithAuthorizations', call.data);
    expect(pay.from.toLowerCase()).toBe(c.wallet);
    expect(fee.to.toLowerCase()).toBe(FEE_TO);
    expect(fee.value).toBe(48_000n);
    expect(fee.validBefore).toBe(pay.validBefore);
  });

  it('permit: exactly amount + fee to the forwarder, plus the TendrPayment', async () => {
    const c = ctx({ method: 'permit' });
    const items = buildToSign(c);
    expect(items.map((i) => i.kind)).toEqual(['permit', 'tendr_payment']);
    expect(items[0]!.typed_data.message).toMatchObject({
      spender: FORWARDER,
      value: String(25_150_000 + 48_000),
      nonce: '3',
    });
    expect(items[1]!.typed_data.domain).toEqual({
      name: 'TendrForwarder',
      version: '1',
      chainId: 8453,
      verifyingContract: FORWARDER,
    });
    const call = verifySigned(c, await sign(items));
    const [permit, p, sig] = iface.decodeFunctionData('payWithPermit', call.data);
    expect(permit.value).toBe(25_198_000n);
    expect(permit.owner.toLowerCase()).toBe(c.wallet);
    expect(p.to.toLowerCase()).toBe(DEPOSIT);
    expect(p.feeTo.toLowerCase()).toBe(FEE_TO);
    expect(p.amount).toBe(25_150_000n);
    expect(p.fee).toBe(48_000n);
    expect(p.deadline).toBe(deadlineSeconds(c.deadline));
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  describe('refuses anything that differs from the quote (409 GASLESS_PAYLOAD_MISMATCH)', () => {
    const refused = (fn: () => unknown, field: string) =>
      expect(fn).toThrow(
        expect.objectContaining({
          code: 'GASLESS_PAYLOAD_MISMATCH',
          status: 409,
          details: { field },
        }),
      );

    it('a changed destination, amount, fee recipient or deadline', async () => {
      const c = ctx();
      const good = await sign(buildToSign(c));
      for (const [kind, field, value] of [
        ['payment', 'to', '0x' + 'cd'.repeat(20)],
        ['payment', 'value', '25150001'],
        ['payment', 'validBefore', String(deadlineSeconds(c.deadline) + 1n)],
        ['fee', 'to', '0x' + 'cd'.repeat(20)],
        ['fee', 'value', '1'],
      ] as const) {
        const bad = structuredClone(good);
        bad[kind]!.message[field] = value;
        refused(() => verifySigned(c, bad), `${kind}.${field}`);
      }
    });

    it('nothing signed, or a signature by another wallet', async () => {
      const c = ctx();
      refused(() => verifySigned(c, {}), 'payment');
      // The same messages, signed by someone else.
      const bad = await sign(buildToSign(c), stranger);
      refused(() => verifySigned(c, bad), 'payment.signer');
    });

    it("a payload signed for another session's quote", async () => {
      const other = ctx({
        quoteId: 'quo_01JBBBBBBBBBBBBBBBBBBBBBBB',
        depositAddress: '0x' + 'cd'.repeat(20),
      });
      const signedForOther = await sign(buildToSign(other));
      refused(() => verifySigned(ctx(), signedForOther), 'payment.to');
      // Even with the destination copied, the quote-bound nonce differs.
      const sameDeposit = ctx({ quoteId: 'quo_01JBBBBBBBBBBBBBBBBBBBBBBB' });
      const signedSameDeposit = await sign(buildToSign(sameDeposit));
      refused(() => verifySigned(ctx(), signedSameDeposit), 'payment.nonce');
    });

    it('a missing fee leg, an extra signature, an extra field, a bad signature', async () => {
      const c = ctx();
      const good = await sign(buildToSign(c));
      refused(() => verifySigned(c, { payment: good.payment! }), 'fee');
      refused(() => verifySigned(ctx({ fee: 0n }), good), 'fee');
      const extra = structuredClone(good);
      extra.payment!.message.extra = '1';
      refused(() => verifySigned(c, extra), 'payment.message');
      const junk = structuredClone(good);
      junk.payment!.signature = '0x1234';
      refused(() => verifySigned(c, junk), 'payment.signature');
    });

    it('a permit for more than amount + fee', async () => {
      const c = ctx({ method: 'permit' });
      const good = await sign(buildToSign(c));
      const bad = structuredClone(good);
      bad.permit!.message.value = String(25_198_001);
      refused(() => verifySigned(c, bad), 'permit.value');
    });
  });
});
