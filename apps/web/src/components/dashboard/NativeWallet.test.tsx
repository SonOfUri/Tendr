// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeWalletPanel, NativeWalletSetup } from './NativeWallet';
import { api, type AccountView, type GoLiveStatus } from '@/lib/api';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { signPayout, type NativePayout } from '@/lib/native-wallet';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock('@/lib/webauthn', () => ({ withStepUp: <T,>(fn: () => Promise<T>) => fn() }));
const store = { merchantId: 'mer_test', livemode: true };
const wallet: AccountView = {
  livemode: true,
  account: {
    id: 'acct',
    kind: 'native_intents',
    nearAccountId: '0xwallet',
    status: 'active',
    threshold: 1,
    signerEpoch: '0',
  },
  signers: [],
  nativeWallet: { ownerUserId: 'owner', credentialId: 'cred', publicKey: 'p256:key' },
};
const status: GoLiveStatus = {
  accountKind: 'native_intents',
  checklist: { ok: true, missing: [], signerCount: 1, recoveryKeySet: false },
  live: { status: 'active', nearAccountId: '0xwallet' },
};
const token = { asset: 'nep141:usdc', symbol: 'USDC', chain: 'base', decimals: 6 };
const options = {
  challenge: 'challenge',
  allowCredentials: [{ id: 'cred', type: 'public-key' as const }],
};
const payout: NativePayout = {
  id: 'npay_1',
  status: 'awaiting_signature',
  asset: token.asset,
  amount: '1000000',
  destinationAsset: token.asset,
  destinationChain: 'base',
  destination: '0x1111111111111111111111111111111111111111',
  proposalId: null,
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  intentHash: null,
  quote: { quote: { amountOut: '990000', minAmountOut: '980000' } },
};
let payouts: NativePayout[];
beforeEach(() => {
  payouts = [];
  vi.clearAllMocks();
  vi.mocked(startAuthentication).mockResolvedValue({ id: 'signed' } as never);
  vi.mocked(startRegistration).mockResolvedValue({ id: 'new-wallet' } as never);
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/v1/account') return wallet as never;
    if (path === '/v1/account/native/keys')
      return {
        accountId: '0xwallet',
        rpId: 'localhost',
        contract: 'intents.near',
        keys: [],
        operations: [],
      } as never;
    if (path === '/v1/account/go-live') return status as never;
    if (path === '/v1/account/balances')
      return {
        accountId: '0xwallet',
        balances: [{ asset: token.asset, amount: '10000000' }],
      } as never;
    if (path === '/v1/payment_links/settlement-options')
      return { livemode: true, tokens: [token], store_default: { asset: token.asset } } as never;
    if (path === '/v1/account/native/payouts') {
      if (init?.method === 'POST') {
        payouts = [payout];
        return payout as never;
      }
      return { payouts } as never;
    }
    if (path.endsWith('/challenge')) return { ...payout, options } as never;
    if (path.endsWith('/submit')) {
      payouts = [{ ...payout, status: 'submitted' }];
      return payouts[0] as never;
    }
    return {} as never;
  });
});
afterEach(cleanup);

it('quotes, reviews exact amounts and destination, then signs only on an explicit click', async () => {
  render(<NativeWalletPanel merchantId={store.merchantId} userId="owner" isOwner />);
  await screen.findByLabelText('Token to send');
  fireEvent.change(screen.getByLabelText('Token to send'), { target: { value: token.asset } });
  fireEvent.change(screen.getByLabelText('Amount to send'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Token and chain to receive'), {
    target: { value: token.asset },
  });
  fireEvent.change(screen.getByLabelText('Destination address'), {
    target: { value: payout.destination },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Get payout quote' }));
  const confirm = await screen.findByRole('button', {
    name: 'Confirm and sign with wallet passkey',
  });
  expect(startAuthentication).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'Review payout' }).textContent).toContain(
    payout.destination,
  );
  expect(screen.getByRole('region', { name: 'Review payout' }).textContent).toContain('0.98 USDC');
  expect(api).toHaveBeenCalledWith(
    '/v1/account/native/payouts',
    expect.objectContaining({
      store,
      json: {
        asset: token.asset,
        amount: '1000000',
        destinationAsset: token.asset,
        destination: payout.destination,
      },
    }),
  );
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
  await screen.findByText('Payout submitted. Follow its status below.');
  expect(startAuthentication).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith(
    '/v1/account/native/payouts/npay_1/submit',
    expect.objectContaining({ store, json: { response: { id: 'signed' } } }),
  );
});

it('keeps co-owners read-only and respects the disabled live gate during setup', async () => {
  render(<NativeWalletPanel merchantId={store.merchantId} userId="other-owner" isOwner />);
  await screen.findByText(/Only its designated owner/);
  expect(screen.queryByRole('button', { name: 'Get payout quote' })).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Save settlement' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  cleanup();
  render(
    <NativeWalletSetup
      view={{ ...wallet, account: null, nativeWallet: null }}
      status={{
        ...status,
        checklist: { ...status.checklist, missing: ['live_mode_unavailable', 'wallet_passkey'] },
      }}
      store={store}
      userId="owner"
      isOwner
      onDone={async () => {}}
    />,
  );
  expect(
    (
      screen.getByRole('button', {
        name: 'Create wallet passkey and activate',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(startRegistration).not.toHaveBeenCalled();
});

it('does not sign a challenge whose payout differs from the reviewed destination', async () => {
  vi.mocked(api).mockResolvedValueOnce({ ...payout, destination: 'changed', options });
  await expect(signPayout(store, payout)).rejects.toThrow(/payout changed/);
  expect(startAuthentication).not.toHaveBeenCalled();
});
