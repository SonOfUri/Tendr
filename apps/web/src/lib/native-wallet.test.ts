import { beforeEach, expect, it, vi } from 'vitest';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from './api';
import { signPayout, type NativePayout } from './native-wallet';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock('./api', () => ({ api: vi.fn() }));
vi.mock('./webauthn', () => ({ withStepUp: (fn: () => Promise<unknown>) => fn() }));

beforeEach(() => vi.resetAllMocks());

it('does not sign or submit a challenge belonging to a different invoice', async () => {
  const reviewed: NativePayout = {
    id: 'npay_1',
    status: 'awaiting_signature',
    asset: 'nep141:usdc.near',
    amount: '1200000',
    destinationAsset: 'nep141:usdc.near',
    destinationChain: 'near',
    destination: 'contractor.near',
    invoiceId: 'bill_1',
    proposalId: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    intentHash: null,
    quote: { quote: { amountOut: '1000000' } },
  };
  vi.mocked(api).mockResolvedValue({ ...reviewed, invoiceId: 'bill_2', options: {} });
  await expect(signPayout({ merchantId: 'mer_1', livemode: true }, reviewed)).rejects.toThrow(
    'payout changed',
  );
  expect(startAuthentication).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledTimes(1);
});
