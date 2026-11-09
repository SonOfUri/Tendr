// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VerifyPage from './page';
import { api } from '@/lib/api';
import { registerPasskey } from '@/lib/webauthn';

const { replace, search } = vi.hoisted(() => ({ replace: vi.fn(), search: { value: '' } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('@/lib/webauthn', () => ({ registerPasskey: vi.fn() }));
vi.mock('@/lib/navigation', async (original) => ({
  ...(await original<typeof import('@/lib/navigation')>()),
  takePendingInvite: () => null,
}));
vi.mock('@/lib/connect', () => ({
  loadConnectParams: () => null,
  takeConnectWaiting: () => false,
}));
beforeEach(() => {
  vi.clearAllMocks();
  search.value =
    'token=example&next=' + encodeURIComponent('/dashboard/invoices?store=mer_example&mode=live');
});
afterEach(cleanup);

it('only verifies after a click and returns an existing person without registering another key', async () => {
  vi.mocked(api).mockResolvedValue({
    user: { id: 'per_existing', email: 'owner@example.com' },
    hasPasskey: true,
  });
  render(<VerifyPage />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm my email' }));
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith('/dashboard/invoices?store=mer_example&mode=live'),
  );
  expect(api).toHaveBeenCalledExactlyOnceWith('/v1/auth/email/verify', {
    method: 'POST',
    json: { token: 'example' },
    store: false,
  });
  expect(screen.queryByRole('button', { name: 'Create my passkey' })).toBeNull();
  expect(registerPasskey).not.toHaveBeenCalled();
});

it('keeps first-passkey onboarding for a new person and rejects an external next path', async () => {
  search.value = 'token=example&next=' + encodeURIComponent('//evil.example');
  vi.mocked(api).mockResolvedValue({
    user: { id: 'per_new', email: 'new@example.com' },
    hasPasskey: false,
  });
  vi.mocked(registerPasskey).mockResolvedValue({} as never);
  render(<VerifyPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm my email' }));
  await screen.findByRole('button', { name: 'Create my passkey' });
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Create my passkey' }));
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  expect(registerPasskey).toHaveBeenCalledTimes(1);
});

it('keeps an expired-link error visible without starting registration or navigation', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Invalid or expired link'));
  render(<VerifyPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm my email' }));
  await screen.findByText(/Invalid or expired link/);
  expect(replace).not.toHaveBeenCalled();
  expect(registerPasskey).not.toHaveBeenCalled();
});
