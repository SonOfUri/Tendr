import { isTerminalSession, SessionStatusValues } from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import type { SessionPayment, SessionRefund, SessionView } from './api';
import { POLL_MS, screenFor, SLOW_POLL_MS } from './status';
import { tendrShopperTheme } from '@/lib/checkout/brand';

const NOW = new Date('2026-10-26T12:00:00Z');
const LATER = '2026-10-26T12:20:00Z';
const EARLIER = '2026-10-26T11:50:00Z';

function view(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0',
    livemode: false,
    merchant: { name: 'Bean Shop' },
    theme: tendrShopperTheme('Bean Shop'),
    line_items: [],
    checkout_domains: [],
    amount: '25',
    amount_currency: 'USD',
    settlement_asset: 'nep141:usdc.test',
    status: 'PENDING_DEPOSIT',
    expires_at: LATER,
    fee_payer: 'merchant',
    gas_payer: 'merchant',
    success_url: 'https://shop.example/thanks',
    cancel_url: 'https://shop.example/cart',
    quote: null,
    payments: [],
    refunds: [],
    needs_email: false,
    topup: null,
    ...over,
  };
}

function payment(state: string, over: Partial<SessionPayment> = {}): SessionPayment {
  return {
    id: 'pay_1',
    state,
    amount_received: '1',
    overpaid_amount: null,
    refunded_amount: null,
    kept_small_overpayment: false,
    origin_tx_hash: '0xabc',
    created_at: EARLIER,
    ...over,
  };
}

const refund = (over: Partial<SessionRefund> = {}): SessionRefund => ({
  id: 'ref_1',
  payment_id: 'pay_1',
  asset: 'nep141:eth.test',
  amount: '100',
  needs_address: false,
  state: 'processing',
  ...over,
});

const TOPUP = {
  payment_id: 'pay_1',
  origin_asset: 'nep141:eth.test',
  deposit_address: '0xdep',
  remaining_amount: '5',
  deadline: LATER,
  message: 'Send the remaining 0.000000000000000005 ETH to the same address',
};

describe('screenFor', () => {
  it('awaiting payment: the pay flow, polling, bridge status pending', () => {
    const s = screenFor(view(), NOW);
    expect(s).toMatchObject({
      kind: 'pay',
      terminal: false,
      bridgeStatus: 'pending',
      action: null,
    });
    expect(s.notice).toBeNull();
  });

  it('awaiting payment past expires_at: expired, still polling (slowly) for a late deposit', () => {
    expect(screenFor(view({ expires_at: EARLIER }), NOW)).toMatchObject({
      kind: 'expired',
      terminal: false,
      pollMs: SLOW_POLL_MS,
      bridgeStatus: 'expired',
    });
  });

  it('reopened after an underpay was returned: pay again, with a notice', () => {
    const s = screenFor(view({ payments: [payment('refunded')] }), NOW);
    expect(s).toMatchObject({ kind: 'pay', notice: 'previous_returned' });
  });

  it('detected → converting', () => {
    expect(
      screenFor(view({ status: 'PROCESSING', payments: [payment('detected')] }), NOW),
    ).toMatchObject({ kind: 'detected', terminal: false, bridgeStatus: 'detected' });
    for (const state of ['converting', 'processing']) {
      expect(
        screenFor(view({ status: 'PROCESSING', payments: [payment(state)] }), NOW),
      ).toMatchObject({ kind: 'converting', terminal: false, bridgeStatus: 'converting' });
    }
  });

  it('SCREENING_PENDING looks like converting to the shopper', () => {
    expect(
      screenFor(view({ status: 'SCREENING_PENDING', payments: [payment('converting')] }), NOW),
    ).toMatchObject({ kind: 'converting', terminal: false, bridgeStatus: 'converting' });
  });

  it('underpaid with a live top-up offer: topup; without one: underpaid', () => {
    expect(
      screenFor(
        view({ status: 'PROCESSING', payments: [payment('underpaid')], topup: TOPUP }),
        NOW,
      ),
    ).toMatchObject({ kind: 'topup', terminal: false, bridgeStatus: 'detected' });
    expect(
      screenFor(view({ status: 'PROCESSING', payments: [payment('underpaid')] }), NOW),
    ).toMatchObject({ kind: 'underpaid', terminal: false, bridgeStatus: 'refunded' });
  });

  it('settled is complete, terminal, and posts settled', () => {
    expect(
      screenFor(view({ status: 'SETTLED', payments: [payment('settled')] }), NOW),
    ).toMatchObject({ kind: 'complete', terminal: true, bridgeStatus: 'settled' });
  });

  it('only SETTLED and REFUNDED are terminal (the contracts state machine)', () => {
    for (const status of SessionStatusValues) {
      const s = screenFor(view({ status, payments: [payment('converting')] }), NOW);
      expect(s.terminal, status).toBe(isTerminalSession(status));
    }
    expect(
      screenFor(view({ status: 'REFUNDED', payments: [payment('refunded')] }), NOW),
    ).toMatchObject({ kind: 'refunded', terminal: true, bridgeStatus: 'refunded' });
  });

  it('expired and held keep polling, slowly', () => {
    expect(screenFor(view({ status: 'EXPIRED' }), NOW)).toMatchObject({
      kind: 'expired',
      terminal: false,
      pollMs: SLOW_POLL_MS,
      bridgeStatus: 'expired',
    });
    expect(screenFor(view({ status: 'HELD', payments: [payment('held')] }), NOW)).toMatchObject({
      kind: 'held',
      terminal: false,
      pollMs: SLOW_POLL_MS,
      bridgeStatus: 'held',
    });
    expect(screenFor(view(), NOW).pollMs).toBe(POLL_MS);
  });

  it('expired → a late deposit lands: the late screen, asking for an email when needed', () => {
    const expired = screenFor(view({ expires_at: EARLIER }), NOW);
    expect(expired.kind).toBe('expired');
    const late = screenFor(
      view({
        status: 'LATE_DEPOSIT',
        expires_at: EARLIER,
        payments: [payment('late')],
        refunds: [refund({ needs_address: true })],
        needs_email: true,
      }),
      NOW,
    );
    expect(late).toMatchObject({ kind: 'late', action: 'email', terminal: false, pollMs: POLL_MS });
  });

  it('held → refunded: polling stops once the refund completes', () => {
    const held = screenFor(view({ status: 'HELD', payments: [payment('held')] }), NOW);
    expect(held).toMatchObject({ kind: 'held', terminal: false });
    const refunded = screenFor(
      view({
        status: 'REFUNDED',
        payments: [payment('refunded')],
        refunds: [refund({ state: 'sent' })],
      }),
      NOW,
    );
    expect(refunded).toMatchObject({ kind: 'refunded', terminal: true });
  });

  it('a payment refunding inside a processing session shows refunded (not yet terminal)', () => {
    expect(
      screenFor(view({ status: 'PROCESSING', payments: [payment('refunding')] }), NOW),
    ).toMatchObject({ kind: 'refunded', terminal: false });
  });

  it('late: still the late screen once the session is REFUNDED (the return is under way or done)', () => {
    const late = screenFor(
      view({ status: 'REFUNDED', expires_at: EARLIER, payments: [payment('late')] }),
      NOW,
    );
    expect(late).toMatchObject({ kind: 'late', terminal: true });
    // A refund of a payment that was not late keeps the refunded screen.
    expect(screenFor(view({ status: 'REFUNDED', payments: [payment('refunded')] }), NOW).kind).toBe(
      'refunded',
    );
  });

  it('late: arrived after expiry, being returned', () => {
    expect(
      screenFor(view({ status: 'LATE_DEPOSIT', payments: [payment('late')] }), NOW),
    ).toMatchObject({ kind: 'late', terminal: false, bridgeStatus: 'expired' });
  });

  it('a return waiting for an address asks for it (and keeps polling until given)', () => {
    const s = screenFor(
      view({
        status: 'REFUNDED',
        payments: [payment('refunding')],
        refunds: [refund({ needs_address: true, chains: ['near', 'eth'] })],
      }),
      NOW,
    );
    expect(s).toMatchObject({ kind: 'refunded', action: 'needs_address', terminal: false });
    expect(s.refundNeedingAddress?.id).toBe('ref_1');
  });

  it('asks for an email when one is needed (before the address form)', () => {
    const s = screenFor(
      view({
        status: 'LATE_DEPOSIT',
        payments: [payment('late')],
        refunds: [refund({ needs_address: true })],
        needs_email: true,
      }),
      NOW,
    );
    expect(s.action).toBe('email');
    expect(s.terminal).toBe(false);
  });

  it('every known session status maps to a real screen', () => {
    for (const status of SessionStatusValues) {
      const s = screenFor(
        view({ status, payments: status === 'PENDING_DEPOSIT' ? [] : [payment('converting')] }),
        NOW,
      );
      expect(s.kind, status).not.toBe('checking');
    }
  });

  it('an unknown session or payment state is a safe "checking" screen, never a crash', () => {
    expect(screenFor(view({ status: 'SOMETHING_NEW' }), NOW)).toMatchObject({
      kind: 'checking',
      terminal: false,
      bridgeStatus: null,
      action: null,
    });
    expect(
      screenFor(view({ status: 'PROCESSING', payments: [payment('mystery')] }), NOW),
    ).toMatchObject({ kind: 'checking', terminal: false });
    // Missing or malformed fields do not throw either.
    expect(screenFor({} as SessionView, NOW).kind).toBe('checking');
    expect(screenFor(view({ payments: undefined as unknown as [] }), NOW).kind).toBe('pay');
  });
});
