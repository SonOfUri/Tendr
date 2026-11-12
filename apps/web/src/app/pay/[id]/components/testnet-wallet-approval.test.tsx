// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TIDEPOOL_TOKENS } from '@tendr/contracts';
import { DemoCheckoutPanel } from '@/components/demo/DemoCheckoutPanel';
import type { Quote, SessionView, Token } from '@/lib/checkout/api';
import { encodeErc20Transfer } from '@/lib/wallets/evm';

vi.mock('@/lib/env', async (original) => {
  const imported = await original<typeof import('@/lib/env')>();
  return { ...imported, publicEnv: { ...imported.publicEnv, e2eInjectedWallet: true } };
});
vi.mock('@/components/QrImage', () => ({ QrImage: () => null }));
vi.mock('@/components/checkout/CheckoutAiFab', () => ({ CheckoutAiFab: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('connects a Tidepool wallet, enables Pay, switches to Base Sepolia and requests transaction approval', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  const address = '0x' + '1'.repeat(40);
  const deposit = '0x' + '2'.repeat(40);
  const token: Token = {
    asset_id: TIDEPOOL_TOKENS.baseUsdc.assetId,
    blockchain: 'base',
    symbol: 'USDC',
    decimals: 6,
    price_usd: '1',
    popular: true,
  };
  let quote: Quote = {
    id: 'quo_wallet',
    origin_asset: token.asset_id,
    deposit_address: deposit,
    amount_in: '1000000',
    amount_in_usd: '1',
    deadline: new Date(Date.now() + 600000).toISOString(),
    expired: false,
    refund: 'origin_chain',
    refund_address: null,
    fee_lines: [],
    small_overpay_notice: false,
    small_overpay_usd: 1,
  };
  const session = {
    id: 'ses_wallet',
    livemode: false,
    test_provider: 'tidepool',
    amount: '1',
    status: 'PENDING_DEPOSIT',
    expires_at: quote.deadline,
    payments: [],
    refunds: [],
    quote,
  } as unknown as SessionView;
  let chainId = '0x1';
  const requests: { method: string; params?: unknown }[] = [];
  vi.stubGlobal('ethereum', {
    request: vi.fn(async (request: { method: string; params?: unknown }) => {
      requests.push(request);
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts')
        return [address];
      if (request.method === 'eth_chainId') return chainId;
      if (request.method === 'wallet_switchEthereumChain') {
        chainId = (request.params as { chainId: string }[])[0]!.chainId;
        return null;
      }
      if (request.method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
      throw new Error('Unexpected wallet request: ' + request.method);
    }),
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/quote')) {
      const body = JSON.parse(String(init?.body));
      quote = { ...quote, refund_address: body.refund_address };
      return Response.json(quote);
    }
    if (url.endsWith('/deposit')) return Response.json({ submitted: true });
    if (url.endsWith('/session')) return Response.json(session);
    throw new Error('Unexpected checkout API request');
  });
  vi.stubGlobal('fetch', fetcher);
  const checkBeforeSend = vi.fn(async () => 'ok' as const);
  render(
    <DemoCheckoutPanel
      sessionId={session.id}
      clientSecret="fixture-only"
      productName="Test purchase"
      merchantName="Store"
      merchantLogoUrl=""
      payEyebrow="Paying"
      skin="ecommerce"
      bootstrap={{ session, tokens: [token], tokenId: token.asset_id, quote }}
      onClose={() => {}}
      onComplete={() => {}}
      checkBeforeSend={checkBeforeSend}
    />,
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Connect wallet' }));
  const pay = await screen.findByRole('button', { name: 'Pay 1 USDC' });
  await waitFor(() => expect((pay as HTMLButtonElement).disabled).toBe(false));
  expect(requests.some((r) => r.method === 'eth_requestAccounts')).toBe(true);
  expect(requests.some((r) => r.method === 'eth_sendTransaction')).toBe(false);
  fireEvent.click(pay);
  await waitFor(() =>
    expect(requests.filter((r) => r.method === 'eth_sendTransaction')).toHaveLength(1),
  );
  expect(checkBeforeSend).toHaveBeenCalledOnce();
  expect(requests.find((r) => r.method === 'wallet_switchEthereumChain')?.params).toEqual([
    { chainId: '0x14a34' },
  ]);
  expect(requests.find((r) => r.method === 'eth_sendTransaction')?.params).toEqual([
    {
      from: address,
      to: TIDEPOOL_TOKENS.baseUsdc.contract,
      value: '0x0',
      chainId: '0x14a34',
      data: encodeErc20Transfer(deposit, 1000000n),
    },
  ]);
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/deposit'))).toBe(true),
  );
  // The refresh immediately after submission still says PENDING_DEPOSIT. It must
  // not reopen Pay while the provider is catching up and allow another send.
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Pay 1 USDC' })).toBeNull();
  expect(screen.getByText('Confirming')).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/simulate'))).toBe(false);
});
