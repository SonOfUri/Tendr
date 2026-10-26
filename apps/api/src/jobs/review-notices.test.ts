import type { Event, Merchant } from '@prisma/client';
import { HOLD_NOTICE } from '@tendr/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryMailer, setMailer } from '../auth/mailer.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';
import { clearEventHandlers, handlerNamesFor } from './handlers.js';
import {
  onPaymentHeldNotice,
  onRefundNeedsReviewNotice,
  onScreeningUnresolvedNotice,
  registerReviewNotices,
} from './review-notices.js';

describe('signer notices for review items (Ruling C23)', () => {
  let merchant: Merchant;
  let mailer: MemoryMailer;
  let signerA: string;
  let signerB: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mailer = new MemoryMailer();
    setMailer(mailer);
    merchant = await createMerchant({ name: 'Bean Shop' });
    const member = async (isSigner: boolean) => {
      const u = await createUser();
      await createRow('MerchantUser', merchant.id, false, {
        userId: u.id,
        role: 'admin',
        isSigner,
      });
      return u.email;
    };
    signerA = await member(true);
    signerB = await member(true);
    await member(false); // not a signer: never mailed
  });
  afterEach(() => {
    setMailer(null);
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const event = (type: string, payload: object, livemode = false): Promise<Event> =>
    prisma.event.create({
      data: {
        id: newId('evt'),
        merchantId: merchant.id,
        livemode,
        aggregateType: type.startsWith('refund') ? 'refund' : 'payment',
        aggregateId: 'pay_x',
        type,
        payload,
      },
    });

  it('payment.held mails every signer the verbatim notice, once per event', async () => {
    const e = await event('payment.held', {
      payment_id: 'pay_1',
      session_id: 'ses_1',
      external_ref: 'order-1',
      held_reason: 'sanctions',
      notice: HOLD_NOTICE,
    });
    await onPaymentHeldNotice(e);
    await onPaymentHeldNotice(e); // a replayed job
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([signerA, signerB].sort());
    for (const m of mailer.sent) {
      expect(m.template).toBe('payment_held');
      expect(m.data.notice).toBe(HOLD_NOTICE);
      expect(m.data.payment_id).toBe('pay_1');
      expect(m.data.url).toMatch(/\/dashboard\/review$/);
    }
    // A different event for the same payment is its own notice.
    await onPaymentHeldNotice(await event('payment.held', { payment_id: 'pay_1' }));
    expect(mailer.sent).toHaveLength(4);
  });

  it('screening_unresolved and refund.needs_review mail signers once per event', async () => {
    const s = await event('payment.screening_unresolved', { payment_id: 'pay_2', attempts: 7 });
    await onScreeningUnresolvedNotice(s);
    await onScreeningUnresolvedNotice(s);
    const r = await event('refund.needs_review', {
      refund_id: 'ref_1',
      payment_id: 'pay_3',
      review_reason: 'proposal_cancelled',
    });
    await onRefundNeedsReviewNotice(r);
    await onRefundNeedsReviewNotice(r);
    expect(mailer.sent.map((m) => m.template).sort()).toEqual([
      'payment_screening_unresolved',
      'payment_screening_unresolved',
      'refund_needs_review',
      'refund_needs_review',
    ]);
    const review = mailer.sent.find((m) => m.template === 'refund_needs_review')!;
    expect(review.data).toMatchObject({ refund_id: 'ref_1', review_reason: 'proposal_cancelled' });
  });

  it('a failed send is retried for that signer only', async () => {
    const e = await event('payment.held', { payment_id: 'pay_4' });
    let fail = true;
    setMailer({
      send: async (msg) => {
        if (fail && msg.to === signerB) throw new Error('smtp down');
        await mailer.send(msg);
      },
    });
    await expect(onPaymentHeldNotice(e)).rejects.toThrow(/smtp down/);
    fail = false;
    await onPaymentHeldNotice(e);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([signerA, signerB].sort());
  });

  it('registers one handler per internal event type (they are never webhooks)', () => {
    clearEventHandlers();
    registerReviewNotices();
    registerReviewNotices(); // idempotent
    expect(handlerNamesFor('payment.held')).toEqual(['notify-payment-held']);
    expect(handlerNamesFor('payment.screening_unresolved')).toEqual([
      'notify-screening-unresolved',
    ]);
    expect(handlerNamesFor('refund.needs_review')).toEqual(['notify-refund-needs-review']);
    clearEventHandlers();
  });
});
