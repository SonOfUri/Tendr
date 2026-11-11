// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeWalletSecurity } from './NativeWalletSecurity';
import {
  approveWalletKeyChange,
  reviewKeyOperation,
  walletKeys,
  type WalletKeyState,
  type WalletKeyChallenge,
} from '@/lib/native-wallet-keys';

vi.mock('@/lib/native-wallet-keys', () => ({
  walletKeys: vi.fn(),
  approveWalletKeyChange: vi.fn(),
  reviewKeyOperation: vi.fn(),
  cancelKeyOperation: vi.fn(),
  getKeyOperation: vi.fn(),
  proveWalletKit: vi.fn(),
  continueKeyRegistration: vi.fn(),
  enrollWalletKit: vi.fn(),
  addWalletPasskey: vi.fn(),
  revokeWalletKey: vi.fn(),
}));
const store = { merchantId: 'store', livemode: true };
const key = {
  id: 'key1',
  kind: 'passkey',
  status: 'active',
  label: 'Original laptop',
  publicKey: 'p256:original',
  createdAt: '',
  activatedAt: '',
  revokedAt: null,
};
let data: WalletKeyState;
beforeEach(() => {
  vi.clearAllMocks();
  data = {
    accountId: '0xwallet',
    rpId: 'usetendr.tech',
    contract: 'intents.near',
    keys: [key],
    operations: [],
  };
  vi.mocked(walletKeys).mockImplementation(async () => data);
});
afterEach(cleanup);

it('separates login recovery and wallet recovery, and protects the last passkey', async () => {
  render(<NativeWalletSecurity store={store} />);
  await screen.findByText('Original laptop');
  expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.getByRole('link', { name: 'login passkeys and recovery codes' }).getAttribute('href'),
  ).toBe('/settings/login-recovery');
  expect(screen.getByText(/Tendr cannot restore access/)).toBeTruthy();
  expect(approveWalletKeyChange).not.toHaveBeenCalled();
});

it('shows a cross-device pending request and requires explicit full-control acknowledgement before signing', async () => {
  const op = {
    id: 'op1',
    kind: 'add_passkey',
    label: 'New phone',
    status: 'awaiting_signature',
    candidateKeyId: 'key2',
    recoveryKeyId: null,
    revokeKeyIds: [],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    intentHash: null,
    canCancel: true,
  };
  const added = {
    ...key,
    id: 'key2',
    label: 'New phone',
    publicKey: 'p256:phone',
    status: 'pending',
  };
  data = { ...data, keys: [key, added], operations: [op] };
  vi.mocked(reviewKeyOperation).mockResolvedValue({
    ...op,
    accountId: data.accountId,
    contract: data.contract,
    payload: 'reviewed payload',
    addedKey: added,
    removedKeys: [],
  } as WalletKeyChallenge);
  vi.mocked(approveWalletKeyChange).mockResolvedValue({ ...op, status: 'submitting' });
  render(<NativeWalletSecurity store={store} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review and approve' }));
  const button = await screen.findByRole('button', {
    name: 'Approve with existing wallet passkey',
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(approveWalletKeyChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  await waitFor(() => expect(approveWalletKeyChange).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/Waiting for final on-chain confirmation/)).toBeTruthy();
});

it('never sends the new kit merely by generating or displaying it', async () => {
  render(<NativeWalletSecurity store={store} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create recovery kit' }));
  expect(screen.getByText(/"tendr-native-wallet-recovery"/)).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Continue to wallet approval' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(approveWalletKeyChange).not.toHaveBeenCalled();
});
