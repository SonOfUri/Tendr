// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ApiKeysPage from './page';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('@/lib/webauthn', () => ({ withStepUp: <T,>(fn: () => Promise<T>) => fn() }));
const dashboard = { store: { role: 'owner' }, context: { merchantId: 'mer_one', livemode: false } };
vi.mock('@/components/dashboard/DashboardShell', () => ({ useDashboard: () => dashboard }));
const key = {
  id: 'key_one',
  name: 'Backend',
  kind: 'secret',
  livemode: false,
  prefix: 'tdr_test_abcd',
  scopes: ['sessions:read'],
  created_at: '2026-11-07T12:00:00Z',
  last_used_at: null,
  revoked_at: null as string | null,
};
const secret = 'tdr_test_only_for_this_test';
let keys: (typeof key)[];
beforeEach(() => {
  keys = [];
  dashboard.store.role = 'owner';
  dashboard.context = { merchantId: 'mer_one', livemode: false };
  vi.clearAllMocks();
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      keys = [{ ...key }];
      return { api_key: key, secret } as never;
    }
    if (init?.method === 'DELETE') {
      keys = [{ ...key, revoked_at: '2026-11-07T12:01:00Z' }];
      return { api_key: keys[0] } as never;
    }
    return {
      api_keys:
        (init?.store as { merchantId: string; livemode: boolean }).livemode ||
        (init?.store as { merchantId: string }).merchantId !== 'mer_one'
          ? []
          : keys,
    } as never;
  });
});
afterEach(cleanup);

async function create() {
  fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Backend' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create test key' }));
  await screen.findByLabelText('Secret API key');
}

it('uses explicit store/mode and selected scopes, shows a key once, and requires revoke confirmation', async () => {
  render(<ApiKeysPage />);
  await screen.findByText('No API keys in test mode yet.');
  await create();
  expect(vi.mocked(api)).toHaveBeenCalledWith(
    '/v1/api_keys',
    expect.objectContaining({
      method: 'POST',
      store: { merchantId: 'mer_one', livemode: false },
      json: {
        name: 'Backend',
        scopes: ['sessions:read', 'sessions:write', 'payments:read', 'events:read'],
      },
    }),
  );
  expect((screen.getByLabelText('Secret API key') as HTMLInputElement).value).toBe(secret);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(secret);
  fireEvent.click(screen.getByRole('button', { name: 'I’ve saved this key' }));
  expect(screen.queryByLabelText('Secret API key')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke Backend' }));
  expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke Backend' })).toBeNull());
  expect(screen.getByText(/Revoked/)).toBeTruthy();
});

it.each(['mode', 'store'])(
  'forgets one-time secrets and metadata when switching %s',
  async (kind) => {
    const page = render(<ApiKeysPage />);
    await create();
    dashboard.context =
      kind === 'mode'
        ? { merchantId: 'mer_one', livemode: true }
        : { merchantId: 'mer_two', livemode: false };
    page.rerender(<ApiKeysPage />);
    expect(screen.queryByLabelText('Secret API key')).toBeNull();
    expect(screen.queryByText('Backend')).toBeNull();
    await screen.findByText(`No API keys in ${kind === 'mode' ? 'live' : 'test'} mode yet.`);
    dashboard.context = { merchantId: 'mer_one', livemode: false };
    page.rerender(<ApiKeysPage />);
    await screen.findByText('Backend');
    expect(screen.queryByLabelText('Secret API key')).toBeNull();
  },
);

it('does not fetch or expose management controls to finance/viewer users', () => {
  dashboard.store.role = 'finance';
  render(<ApiKeysPage />);
  expect(screen.getByText('Only owners and admins can manage API keys.')).toBeTruthy();
  expect(vi.mocked(api)).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Create test key' })).toBeNull();
});
