// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvoicePortal } from './portal';

const USDC = 'nep141:usdc.near';
const ETH = 'nep141:eth.omft.near';
vi.mock('@/components/demo/DemoAssetModal', () => ({
  DemoAssetModal: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <select aria-label="Receiving token" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={USDC}>USDC</option>
      <option value={ETH}>ETH</option>
    </select>
  ),
}));
vi.mock('@/components/TendrLogo', () => ({ TendrLogo: () => <span>Tendr</span> }));
beforeEach(() => window.history.replaceState({}, '', '/invoice/business'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps the dollar breakdown unchanged when switching receiving tokens and submits explicit USD', async () => {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
    Response.json(
      init?.method === 'POST'
        ? { accepted: true }
        : {
            business: { name: 'Business', slug: 'business' },
            amountCurrency: 'USD',
            amountDecimals: 2,
            tokens: [
              { assetId: USDC, symbol: 'USDC', decimals: 6, blockchain: 'near' },
              { assetId: ETH, symbol: 'ETH', decimals: 18, blockchain: 'eth' },
            ],
          },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  render(<InvoicePortal business="business" />);
  await screen.findByText('Send an invoice');
  fireEvent.change(screen.getByLabelText('Item 1 description'), { target: { value: 'Design' } });
  fireEvent.change(screen.getByLabelText('Item 1 amount'), { target: { value: '125.00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
  fireEvent.change(screen.getByLabelText('Item 2 description'), { target: { value: 'Revisions' } });
  fireEvent.change(screen.getByLabelText('Item 2 amount'), { target: { value: '25.50' } });
  expect(screen.getByLabelText('Invoice total').textContent).toBe('$150.50');
  fireEvent.change(screen.getByLabelText('Receiving token'), { target: { value: ETH } });
  expect(screen.getByLabelText('Invoice total').textContent).toBe('$150.50');
  expect(screen.getAllByText('Amount (USD)')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Your name or business'), {
    target: { value: 'Contractor' },
  });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'contractor@example.com' } });
  fireEvent.change(screen.getByLabelText('Invoice reference'), { target: { value: 'INV-1' } });
  fireEvent.change(screen.getByLabelText('Receiving wallet address'), {
    target: { value: `0x${'12'.repeat(20)}` },
  });
  fireEvent.submit(screen.getByLabelText('Item 1 amount').closest('form')!);
  await screen.findByText('Check your email');
  const body = JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string);
  expect(body).toMatchObject({
    amountCurrency: 'USD',
    destinationAsset: ETH,
    items: [
      { description: 'Design', amount: '125.00' },
      { description: 'Revisions', amount: '25.50' },
    ],
  });
  expect(body.amount).toBeUndefined();
});

it('shows dollar amounts on email verification while keeping the receiving token separate', async () => {
  window.history.replaceState({}, '', '/invoice/business#token=private-test-link');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        id: 'bill_test',
        reference: 'INV-2',
        contractorName: 'Contractor',
        email: 'c@example.com',
        status: 'awaiting_verification',
        amountCurrency: 'USD',
        amount: '10025',
        items: [{ description: 'Work', amount: '10025' }],
        symbol: 'ETH',
        decimals: 18,
        destinationAsset: ETH,
        destinationChain: 'eth',
        destination: `0x${'12'.repeat(20)}`,
        payout: null,
      }),
    ),
  );
  render(<InvoicePortal business="business" />);
  await screen.findByText('Invoice INV-2');
  expect(screen.getAllByText('$100.25').length).toBeGreaterThanOrEqual(2);
  expect(screen.getByRole('columnheader', { name: 'Amount (USD)' })).toBeTruthy();
  expect(screen.getByText('ETH')).toBeTruthy();
});
