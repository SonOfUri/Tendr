import { describe, expect, it } from 'vitest';
import {
  afterApproval,
  defaultChoice,
  payoutStep,
  settlementAction,
  type SettlementView,
} from './payout';

const view = (over: Partial<SettlementView> = {}): SettlementView => ({
  livemode: false,
  account_status: 'active',
  settlement: null,
  pending: null,
  choices: [
    { asset: 'nep141:usdc.fakes.testnet', symbol: 'USDC', chain: 'near', default: true },
    { asset: 'nep141:wrap.testnet', symbol: 'wNEAR', chain: 'near', default: false },
  ],
  ...over,
});

describe('choose payout', () => {
  it('asks only when the store has no payout and no change waiting', () => {
    expect(payoutStep(view())).toBe('choose');
    expect(
      payoutStep(
        view({
          settlement: {
            asset: 'nep141:usdc.fakes.testnet',
            symbol: 'USDC',
            chain: 'near',
            payout_mode: 'intents',
          },
        }),
      ),
    ).toBe('set');
    expect(payoutStep(view({ pending: { id: 'prop_1', status: 'pending' } }))).toBe('waiting');
    expect(payoutStep(view({ pending: { id: 'prop_1', status: 'draft' } }))).toBe('waiting');
  });

  it('waits for the account while it is being created', () => {
    expect(payoutStep(view({ account_status: 'provisioning' }))).toBe('account-pending');
    expect(payoutStep(view({ account_status: null }))).toBe('account-pending');
    expect(payoutStep(view({ account_status: 'failed' }))).toBe('account-failed');
  });

  it('defaults to USDC', () => {
    expect(defaultChoice(view())?.symbol).toBe('USDC');
  });

  it('drafts an intents settlement into the store account (the existing proposal kind)', () => {
    expect(settlementAction('nep141:usdc.fakes.testnet')).toEqual({
      set_settlement: {
        dest_asset: 'nep141:usdc.fakes.testnet',
        payout_mode: 'intents',
        saved_address_id: null,
      },
    });
  });

  it('after the passkey approval: done, or more signers needed', () => {
    expect(afterApproval('executed')).toBe('done');
    expect(afterApproval('executing')).toBe('done');
    expect(afterApproval('pending')).toBe('needs-signers');
    expect(afterApproval('timelocked')).toBe('needs-signers');
    expect(afterApproval('draft')).toBe('needs-signers');
    expect(afterApproval('failed')).toBe('failed');
    expect(afterApproval('cancelled')).toBe('failed');
  });
});
