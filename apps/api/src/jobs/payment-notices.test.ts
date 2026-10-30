import type { Event, Merchant } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryMailer, setMailer, type MailMessage } from '../auth/mailer.js';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';
import { handlerNamesFor } from './handlers.js';
import {
  onPaymentReceivedNotice,
  onRefundSentNotice,
  registerPaymentNotices,
} from './payment-notices.js';

const TOKENS: Record<string, TokenInfo> = {
  'nep141:usdc.test': {
    assetId: 'nep141:usdc.test',
    decimals: 6,
    blockchain: 'near',
    symbol: 'USDC',
  },
  'nep141:eth.test': { assetId: 'nep141:eth.test', decimals: 18, blockchain: 'eth', symbol: 'ETH' },
};
/** A token lookup that never calls 1Click (live mode included). */
const deps = {
  token: async (_livemode: boolean, assetId: string) => {
    const t = TOKENS[assetId];
    if (!t) throw new Error(`unknown asset ${assetId}`);
    return t;
  },
};

/** No merchant copy may use internal words (ruling 4). */
const BANNED = /\b(gas|intents?|solvers?)\b/i;
const copy = (m: MailMessage) => `${m.subject ?? ''}\n${m.text ?? ''}`;

describe('merchant payment and refund emails', () => {
  let merchant: Merchant;
  let mailer: MemoryMailer;
  let ownerEmail: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mailer = new MemoryMailer();
    setMailer(mailer);
    merchant = await createMerchant({ name: 'Bean Shop' });
    const owner = await createUser({ emailVerifiedAt: new Date() });
    ownerEmail = owner.email;
    await createRow('MerchantUser', merchant.id, false, { userId: owner.id, role: 'owner' });
    // Never mailed: an owner whose email is not verified, and an admin.
    const unverified = await createUser();
    await createRow('MerchantUser', merchant.id, false, { userId: unverified.id, role: 'owner' });
    const admin = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: admin.id, role: 'admin' });
  });
  afterEach(() => {
    setMailer(null);
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A settled 49 USD payment paid in ETH, settled as 48.75 USDC on NEAR. */
  async function settledPayment(
    opts: {
      livemode?: boolean;
      session?: Record<string, unknown>;
      quote?: Record<string, unknown>;
    } = {},
  ) {
    const livemode = opts.livemode ?? false;
    const session = await createRow('Session', merchant.id, livemode, {
      externalRef: 'order-1001',
      amount: '49.00',
      amountCurrency: 'USD',
      ...opts.session,
    });
    const quote = await createRow('Quote', merchant.id, livemode, {
      sessionId: session.id,
      originAssetId: 'nep141:eth.test',
      amountIn: '20000000000000000', // 0.02 ETH
      amountOut: '48750000',
      amountInUsd: '50.00',
      amountOutUsd: '49.50',
      ...opts.quote,
    });
    const payment = await prisma.payment.create({
      data: {
        id: newId('pay'),
        merchantId: merchant.id,
        livemode,
        sessionId: session.id,
        quoteId: quote.id,
        amountReceived: '20000000000000000',
        senderChain: 'eth',
        originTxHash: '0xorigin',
        status: 'SETTLED',
        amountOut: '48750000',
        settleTx: 'SettleTxHash111',
        settledAt: new Date(),
      },
    });
    for (const [source, amount, amountUsd] of [
      ['app_fee', '100000000000000', '0.25'],
      ['oneclick_fee', '200000000000000', '0.50'],
      ['network_fee', '40000000000000', '0.10'],
    ] as const) {
      await createRow('RevenueEntry', merchant.id, livemode, {
        paymentId: payment.id,
        source,
        assetId: 'nep141:eth.test',
        amount,
        amountUsd,
      });
    }
    return payment;
  }

  const event = (type: string, aggregateId: string, payload: object, livemode = false) =>
    prisma.event.create({
      data: {
        id: newId('evt'),
        merchantId: merchant.id,
        livemode,
        aggregateType: type.startsWith('refund') ? 'refund' : 'payment',
        aggregateId,
        type,
        payload,
      },
    });
  const succeeded = (paymentId: string, livemode = false, payload: object = {}): Promise<Event> =>
    event('payment.succeeded', paymentId, { payment_id: paymentId, ...payload }, livemode);
  const received = () => mailer.sent.filter((m) => m.template === 'payment_received');

  it('registers its handlers once', () => {
    registerPaymentNotices();
    registerPaymentNotices();
    expect(handlerNamesFor('payment.succeeded')).toContain('notify-payment-received');
    expect(handlerNamesFor('refund.sent')).toContain('notify-refund-sent');
  });

  it('payment_received sent once per event even on replay', async () => {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { notificationEmail: 'orders@shop.example' },
    });
    const p = await settledPayment();
    // The event payload is never trusted for amounts: these are ignored.
    const e = await succeeded(p.id, false, { amount_out: '999999999', settlement_asset: 'x' });
    await onPaymentReceivedNotice(e, deps);
    await onPaymentReceivedNotice(e, deps); // a replayed job
    expect(received()).toHaveLength(1);
    const m = received()[0]!;
    expect(m.to).toBe('orders@shop.example');
    expect(m.subject).toBe('[Test] You got paid 48.75 USDC for order order-1001');
    expect(m.data).toMatchObject({
      payment_id: p.id,
      amount_received: '48.75',
      settlement_symbol: 'USDC',
      order_total: '49.00 USD',
      paid_with: '0.02 ETH on Ethereum',
    });
    // The link carries the store and mode, so the dashboard opens the right one.
    const dash = new URL(String(m.data.dashboard_url));
    expect(dash.pathname).toBe(`/dashboard/payments/${p.id}`);
    expect(dash.searchParams.get('store')).toBe(merchant.id);
    expect(dash.searchParams.get('mode')).toBe('test');
    expect(m.text).toContain(String(m.data.dashboard_url));
    expect(m.data.tx_url).toBe('https://testnet.nearblocks.io/txns/SettleTxHash111');
    expect(m.text).toContain('Tendr fee');
    expect(m.text).toContain('1Click fee and spread');
    expect(m.text).toContain('Network fee (estimated)');
    expect(m.text).toContain('$0.25');
    expect(m.text).not.toContain('999999999');
    // A different event is its own notice.
    await onPaymentReceivedNotice(await succeeded(p.id), deps);
    expect(received()).toHaveLength(2);
  });

  it('paymentEmailsEnabled=false → no email', async () => {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { paymentEmailsEnabled: false, notificationEmail: 'orders@shop.example' },
    });
    const p = await settledPayment();
    await onPaymentReceivedNotice(await succeeded(p.id), deps);
    expect(received()).toHaveLength(0);
  });

  it('null notificationEmail → owners', async () => {
    const p = await settledPayment();
    await onPaymentReceivedNotice(await succeeded(p.id), deps);
    expect(received().map((m) => m.to)).toEqual([ownerEmail]);
  });

  it('payment_received says who paid the network fee', async () => {
    const sponsored = await settledPayment({
      quote: {
        networkFeePaidBy: 'merchant',
        networkFeeUsd: '0.036',
        networkFeeMethod: 'eip3009',
      },
    });
    await onPaymentReceivedNotice(await succeeded(sponsored.id), deps);
    expect(received()[0]!.text).toContain('Network fee: paid by you ($0.04)');
    expect(received()[0]!.data.network_fee).toBe('paid by you ($0.04)');

    const shopper = await settledPayment({
      session: { externalRef: 'order-1002' },
      quote: { networkFeePaidBy: 'buyer', networkFeeMode: 'native', networkFeeUsd: '0.5' },
    });
    await onPaymentReceivedNotice(await succeeded(shopper.id), deps);
    expect(received()[1]!.text).toContain('Network fee: paid by the shopper');

    // A payment quoted before gasless payments has no line.
    const old = await settledPayment({ session: { externalRef: 'order-1003' } });
    await onPaymentReceivedNotice(await succeeded(old.id), deps);
    expect(received()[2]!.text).not.toContain('Network fee: paid');
  });

  it('payment_received lists original currency and fx rate for an NGN payment', async () => {
    const p = await settledPayment({
      session: {
        originalAmount: '78500.00',
        originalCurrency: 'NGN',
        fxRate: '1602.04',
        fxSource: 'fixed (test rates)',
        fxAsOf: new Date('2026-10-26T10:00:00Z'),
      },
    });
    await onPaymentReceivedNotice(await succeeded(p.id), deps);
    const m = received()[0]!;
    expect(m.data.order_total).toBe('78500.00 NGN (49.00 USD)');
    expect(m.data.fx_rate).toBe('1 USD = 1602.04 NGN');
    expect(m.text).toContain('78500.00 NGN');
    expect(m.text).toContain('1 USD = 1602.04 NGN');
  });

  it('labels test mode in the subject, not live mode; copy never says gas', async () => {
    const test = await settledPayment();
    await onPaymentReceivedNotice(await succeeded(test.id), deps);
    const live = await settledPayment({ livemode: true });
    await onPaymentReceivedNotice(await succeeded(live.id, true), deps);
    const [t, l] = received();
    expect(t!.subject).toMatch(/^\[Test\] /);
    expect(l!.subject).not.toMatch(/\[Test\]/);
    expect(l!.data.tx_url).toBe('https://nearblocks.io/txns/SettleTxHash111');
    for (const m of [t!, l!]) {
      expect(m.text!.length).toBeGreaterThan(50);
      expect(copy(m)).not.toMatch(BANNED);
    }
  });

  it('refund_sent goes to the same address, once per event, from the refund row', async () => {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { notificationEmail: 'orders@shop.example', paymentEmailsEnabled: false },
    });
    const p = await settledPayment();
    const r = await createRow('Refund', merchant.id, false, {
      paymentId: p.id,
      reason: 'merchant',
      assetId: 'nep141:usdc.test',
      amount: '10250000',
      returnFee: '250000',
      externalRef: 'wc-refund-77',
      status: 'confirmed',
      refundTxHash: 'RefundTx222',
      destination: 'buyer.testnet',
      destinationChain: 'near',
    });
    const e = await event('refund.sent', r.id, { refund_id: r.id, amount: '1' });
    await onRefundSentNotice(e, deps);
    await onRefundSentNotice(e, deps);
    const sent = mailer.sent.filter((m) => m.template === 'refund_sent');
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe('orders@shop.example');
    expect(m.subject).toBe('[Test] Refund sent: 10 USDC for order order-1001');
    expect(m.data).toMatchObject({
      refund_id: r.id,
      refund_external_ref: 'wc-refund-77',
      amount_to_customer: '10',
      network_fee: '0.25',
      symbol: 'USDC',
      tx_url: 'https://testnet.nearblocks.io/txns/RefundTx222',
    });
    expect(copy(m)).not.toMatch(BANNED);
  });

  it('refund_sent links the NEAR proposal tx even when the customer is on another chain', async () => {
    const p = await settledPayment({ livemode: true });
    const r = await createRow('Refund', merchant.id, true, {
      paymentId: p.id,
      reason: 'merchant',
      assetId: 'nep141:usdc.test',
      amount: '5000000',
      externalRef: 'wc-refund-78',
      status: 'confirmed',
      refundTxHash: 'NearProposalTx333',
      destination: '0x1111111111111111111111111111111111111111',
      destinationChain: 'eth',
    });
    await onRefundSentNotice(await event('refund.sent', r.id, { refund_id: r.id }, true), deps);
    const m = mailer.sent.find((x) => x.template === 'refund_sent')!;
    expect(m.data.tx_url).toBe('https://nearblocks.io/txns/NearProposalTx333');
    const dash = new URL(String(m.data.dashboard_url));
    expect(dash.pathname).toBe(`/dashboard/payments/${p.id}`);
    expect(dash.searchParams.get('store')).toBe(merchant.id);
    expect(dash.searchParams.get('mode')).toBe('live');
    expect(m.text).not.toContain('etherscan');
    expect(m.text).toContain("sent 5 USDC to your customer's Ethereum address");
  });

  it('strips line breaks from store-supplied names and refs in subjects', async () => {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { name: 'Bean\nShop', notificationEmail: 'orders@shop.example' },
    });
    const p = await settledPayment({ session: { externalRef: 'o-1\r\nBcc: x@evil.example' } });
    await onPaymentReceivedNotice(await succeeded(p.id), deps);
    const m = received()[0]!;
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe('[Test] You got paid 48.75 USDC for order o-1 Bcc: x@evil.example');
    expect(m.text!.split('\n')[0]).toBe(
      'Bean Shop received 48.75 USDC for order o-1 Bcc: x@evil.example.',
    );
  });

  it('a failed send is retried for that recipient only', async () => {
    const p = await settledPayment();
    const e = await succeeded(p.id);
    let fail = true;
    setMailer({
      send: async (msg) => {
        if (fail) throw new Error('smtp down');
        await mailer.send(msg);
      },
    });
    await expect(onPaymentReceivedNotice(e, deps)).rejects.toThrow(/smtp down/);
    fail = false;
    await onPaymentReceivedNotice(e, deps);
    expect(received()).toHaveLength(1);
  });
});
