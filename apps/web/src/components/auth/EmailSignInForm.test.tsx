// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmailSignInForm } from './EmailSignInForm';
import { api, ApiError } from '@/lib/api';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api).mockReset();
});
afterEach(cleanup);

it('requests an email link with the same-site destination and no merchant context', async () => {
  vi.mocked(api).mockResolvedValue({ ok: true });
  render(<EmailSignInForm next="/dashboard/invoices?store=mer_example&mode=live" />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Sign in with email' }));
  await screen.findByText(/Check/);
  expect(api).toHaveBeenCalledExactlyOnceWith('/v1/auth/email/start', {
    method: 'POST',
    json: { email: 'owner@example.com', next: '/dashboard/invoices?store=mer_example&mode=live' },
    store: false,
  });
  expect(screen.queryByRole('form')).toBeNull();
});

it('shows request failures and allows a deliberate retry', async () => {
  vi.mocked(api).mockRejectedValueOnce(
    new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Email is temporarily unavailable.'),
  );
  render(<EmailSignInForm next="//evil.example" />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
  fireEvent.submit(screen.getByRole('form'));
  await screen.findByText('Email is temporarily unavailable.');
  expect(vi.mocked(api).mock.calls[0]![1]?.json).toEqual({
    email: 'owner@example.com',
    next: '/dashboard',
  });
  vi.mocked(api).mockResolvedValue({ ok: true });
  fireEvent.submit(screen.getByRole('form'));
  await screen.findByText(/Check/);
  expect(api).toHaveBeenCalledTimes(2);
});

it('prevents repeated requests while a link is being sent', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<EmailSignInForm />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(
    (screen.getByRole('button', { name: 'Sending sign-in link…' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.submit(screen.getByRole('form'));
  expect(api).toHaveBeenCalledTimes(1);
  finish({ ok: true });
  await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
});
