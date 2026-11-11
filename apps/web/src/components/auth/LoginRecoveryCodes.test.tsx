// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { withStepUp } from '@/lib/webauthn';
import LoginRecoveryCodes from './LoginRecoveryCodes';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('@/lib/webauthn', () => ({
  withStepUp: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('shows codes once after step-up, requires save acknowledgment, and never persists them in browser storage', async () => {
  const stored = vi.spyOn(Storage.prototype, 'setItem');
  const unsaved = vi.fn();
  vi.mocked(api)
    .mockResolvedValueOnce({ remaining: 0 })
    .mockResolvedValueOnce({ codes: ['TDR1-SYNTHETIC-CODE'], remaining: 10 });
  render(<LoginRecoveryCodes onUnsavedChange={unsaved} />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Generate recovery codes' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Generate recovery codes' }));
  await screen.findByText('TDR1-SYNTHETIC-CODE');
  expect(withStepUp).toHaveBeenCalledTimes(1);
  expect(unsaved).toHaveBeenLastCalledWith(true);
  expect(
    (screen.getByRole('button', { name: 'Hide saved codes' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /I saved my codes/ }));
  expect(unsaved).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: 'Hide saved codes' }));
  expect(screen.queryByText('TDR1-SYNTHETIC-CODE')).toBeNull();
  expect(screen.getByText(/invalidates all previous recovery codes/)).toBeTruthy();
  expect(stored).not.toHaveBeenCalled();
  stored.mockRestore();
});

it('does not generate replacement codes automatically when setup already exists', async () => {
  vi.mocked(api).mockResolvedValue({ remaining: 9 });
  render(<LoginRecoveryCodes />);
  await screen.findByText('9 unused recovery codes available.');
  expect(api).toHaveBeenCalledExactlyOnceWith('/v1/auth/login-recovery/codes', { store: false });
  expect(withStepUp).not.toHaveBeenCalled();
});
