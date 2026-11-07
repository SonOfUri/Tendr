// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectFlow } from './ConnectFlow';
import { api, setStoreContext } from '@/lib/api';
import { withStepUp } from '@/lib/webauthn';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('@/lib/webauthn', () => ({
  loginWithPasskey: vi.fn(),
  registerPasskey: vi.fn(),
  withStepUp: vi.fn(<T,>(fn: () => Promise<T>) => fn()),
}));

const params = {
  site_url: 'https://shop.example.com',
  return_url: 'https://shop.example.com/wp-admin/admin.php?page=tendr-connect-callback',
  state: 'connect-state',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  platform: 'woocommerce',
  plugin_version: '0.3.0',
};
let role: 'owner' | 'admin';

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', `/connect?${new URLSearchParams(params)}`);
  role = 'owner';
  // The dashboard tab's selection must not retarget the connection chosen in the popup.
  setStoreContext({ merchantId: 'mer_unrelated', livemode: true });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/v1/me') {
      return {
        user: { id: 'usr_owner' },
        passkeys: [{ id: 'passkey' }],
        stores: [{ id: 'mer_shop', name: 'Existing shop', slug: 'existing-shop', role }],
      } as never;
    }
    // This is the reported failure: test provisioning failed, independently of a live wallet.
    if (path === '/v1/account/settlement') {
      return {
        livemode: false,
        account: { status: 'failed', nearAccountId: 'existing-shop.tendr.testnet' },
        settlement: null,
        pending: null,
        choices: [],
      } as never;
    }
    if (path === '/v1/connect/authorize') throw new Error('Approval fixture: no redirect');
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(cleanup);

it.each(['owner', 'admin'] as const)(
  'lets an existing store %s reach explicit approval despite failed test provisioning',
  async (memberRole) => {
    role = memberRole;
    render(<ConnectFlow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect shop.example.com to Existing shop?' });
    expect(screen.queryByText(/test account could not be created/)).toBeNull();
    expect(screen.getByText(/Live payment readiness is checked separately/)).toBeTruthy();
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(['/v1/me']);
    expect(withStepUp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approval fixture: no redirect');
    expect(withStepUp).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/v1/connect/authorize', {
      method: 'POST',
      json: params,
      store: { merchantId: 'mer_shop', livemode: false },
    });
  },
);

it('allows changing the store without starting payout setup or authorizing a connection', async () => {
  render(<ConnectFlow />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose another store' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy());
  expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(['/v1/me']);
  expect(withStepUp).not.toHaveBeenCalled();
});
