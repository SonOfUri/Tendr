// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startRegistration } from '@simplewebauthn/browser';
import { api, setCsrfToken } from '@/lib/api';
import RecoverLogin from './page';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
  setCsrfToken: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => ({ startRegistration: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/recover/login');
});
afterEach(cleanup);

it('requests an email only on submit and uses a generic confirmation', async () => {
  vi.mocked(api).mockResolvedValue({ ok: true });
  render(<RecoverLogin />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Account email'), {
    target: { value: 'person@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Email a recovery link' }));
  await screen.findByText(/If recovery codes are enabled/);
  expect(api).toHaveBeenCalledExactlyOnceWith('/v1/auth/login-recovery/start', {
    method: 'POST',
    json: { email: 'person@example.com' },
    store: false,
  });
  expect(startRegistration).not.toHaveBeenCalled();
});

it('strips the private fragment, waits for consent and both factors, then requires a new login', async () => {
  window.history.replaceState(null, '', '/recover/login#token=private-test-token');
  const stored = vi.spyOn(Storage.prototype, 'setItem');
  const options = { challenge: 'example' };
  const response = { id: 'new-login-key' };
  vi.mocked(api).mockResolvedValueOnce(options).mockResolvedValueOnce({ recovered: true });
  vi.mocked(startRegistration).mockResolvedValue(response as never);
  render(<RecoverLogin />);
  expect(window.location.hash).toBe('');
  expect(api).not.toHaveBeenCalled();
  expect(startRegistration).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Saved recovery code'), {
    target: { value: 'saved-code' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Replace lost login passkeys' }));
  await screen.findByRole('link', { name: 'Sign in with your new passkey' });
  expect(api).toHaveBeenNthCalledWith(1, '/v1/auth/login-recovery/options', {
    method: 'POST',
    store: false,
    json: { token: 'private-test-token', recoveryCode: 'saved-code' },
  });
  expect(api).toHaveBeenNthCalledWith(2, '/v1/auth/login-recovery/verify', {
    method: 'POST',
    store: false,
    json: { token: 'private-test-token', recoveryCode: 'saved-code', response },
  });
  expect(startRegistration).toHaveBeenCalledExactlyOnceWith({ optionsJSON: options });
  expect(setCsrfToken).toHaveBeenCalledWith(null);
  expect(api).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText('Saved recovery code')).toBeNull();
  expect(stored).not.toHaveBeenCalled();
  stored.mockRestore();
});

it('retains the recovery form when the authenticator cancels and never submits verification', async () => {
  window.history.replaceState(null, '', '/recover/login#token=test-token');
  vi.mocked(api).mockResolvedValue({ challenge: 'example' });
  vi.mocked(startRegistration).mockRejectedValue(new Error('Passkey creation was cancelled'));
  render(<RecoverLogin />);
  fireEvent.change(screen.getByLabelText('Saved recovery code'), {
    target: { value: 'saved-code' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Replace lost login passkeys' }));
  await waitFor(() => expect(screen.getByText(/Passkey creation was cancelled/)).toBeTruthy());
  expect(api).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('link', { name: 'Sign in with your new passkey' })).toBeNull();
});
