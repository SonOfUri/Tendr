// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIDEPOOL_TOKENS } from '@tendr/contracts';
import type { Quote, SessionView, Token } from '@/lib/checkout/api';
import { tendrShopperTheme } from '@/lib/checkout/brand';
import { forgetClientSecrets } from '@/lib/checkout/secret';
import { DemoStatusCard } from '@/components/demo/DemoStatusCard';
import { buildDemoAssetOptions } from '@/lib/demo-assets';
import { Checkout } from './Checkout';
import type { WalletConnectProps } from './WalletConnect';

vi.mock('@/components/QrImage', () => ({ QrImage: () => <span>Deposit QR</span> }));
vi.mock('@/components/checkout/CheckoutAiFab', () => ({ CheckoutAiFab: () => null }));
vi.mock('@/lib/demo/confetti', () => ({ burstDemoConfetti: () => undefined }));
vi.mock('./WalletConnect', () => ({
  WalletConnect: (props: WalletConnectProps) => (
    <button
      data-testid="wallet"
      data-testnet={String(props.testnet)}
      data-live={String(props.livemode)}
    >
      Wallet transfer
    </button>
  ),
}));

const id = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const token: Token = {
  asset_id: TIDEPOOL_TOKENS.baseUsdc.assetId,
  blockchain: 'base',
  symbol: 'USDC',
  decimals: 6,
  price_usd: '1',
  popular: true,
};
function session(provider: SessionView['test_provider'], livemode = false): SessionView {
  const deadline = new Date(Date.now() + 600_000).toISOString();
  const quote: Quote = {
    id: 'quo_provider',
    origin_asset: token.asset_id,
    deposit_address: '0x' + 'a'.repeat(40),
    amount_in: '1000000',
    amount_in_usd: '1',
    deadline,
    expired: false,
    refund: 'origin_chain',
    refund_address: null,
    fee_lines: [],
    small_overpay_notice: false,
    small_overpay_usd: 1,
  };
  return {
    id,
    livemode,
    test_provider: provider,
    merchant: { name: 'Provider test store' },
    theme: tendrShopperTheme('Provider test store'),
    line_items: [],
    checkout_domains: [],
    amount: '1',
    amount_currency: 'USD',
    settlement_asset: TIDEPOOL_TOKENS.nearUsdc.assetId,
    status: 'PENDING_DEPOSIT',
    expires_at: deadline,
    fee_payer: 'merchant',
    gas_payer: 'shopper',
    success_url: null,
    cancel_url: null,
    quote,
    payments: [],
    refunds: [],
    needs_email: false,
    topup: null,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  window.history.replaceState(null, '', `/pay/${id}#cs=${id}_secret_${'a'.repeat(32)}`);
  window.sessionStorage.clear();
  forgetClientSecrets();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mockCheckoutApi(view: SessionView) {
  const fetcher = vi.fn(async (url: string) => {
    const path = new URL(url, 'https://api.example').pathname;
    if (path.endsWith('/session')) return Response.json(view);
    if (path.endsWith('/tokens')) return Response.json({ tokens: [token] });
    if (path.endsWith('/quote')) return Response.json(view.quote);
    throw new Error(`Unexpected checkout request: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function openCheckout(view: SessionView) {
  const fetcher = mockCheckoutApi(view);
  render(<Checkout sessionId={id} />);
  await screen.findByText('Deposit address');
  return fetcher;
}

describe('the active hosted checkout provider', () => {
  it('offers real Tidepool transfer instructions and testnet wallet payments without simulation', async () => {
    const fetcher = await openCheckout(session('tidepool'));
    expect(screen.queryByText(/Simulate a payment/)).toBeNull();
    expect(screen.queryByText(/address is fake/)).toBeNull();
    expect(screen.getAllByText('Base Sepolia').length).toBeGreaterThan(0);
    expect(screen.getByText(/test network fees/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Connect wallet' }));
    expect(screen.getByTestId('wallet').getAttribute('data-testnet')).toBe('true');
    expect(screen.getByTestId('wallet').getAttribute('data-live')).toBe('false');
    expect(screen.queryByText(/Simulate a payment/)).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => url.includes('/simulate'))).toBe(false);
  });

  it('keeps simulation only for an explicitly simulated provider', async () => {
    await openCheckout(session('simulated'));
    expect(screen.getAllByText(/Simulate a payment/).length).toBeGreaterThan(0);
    expect(screen.getByText(/address is fake/)).toBeTruthy();
  });

  it.each([undefined, null])(
    'does not infer simulation from a missing provider (%s)',
    async (provider) => {
      await openCheckout(session(provider));
      expect(screen.queryByText(/Simulate a payment/)).toBeNull();
      expect(screen.queryByText(/address is fake/)).toBeNull();
    },
  );

  it('keeps Live checkout free of simulator and testnet instructions', async () => {
    await openCheckout(session(null, true));
    expect(screen.queryByText(/Simulate a payment/)).toBeNull();
    expect(screen.queryByText(/test network fees/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Connect wallet' }));
    expect(screen.getByTestId('wallet').getAttribute('data-testnet')).toBe('false');
    expect(screen.getByTestId('wallet').getAttribute('data-live')).toBe('true');
  });

  it('labels all Tidepool asset-picker networks as test networks', () => {
    const tokens: Token[] = Object.values(TIDEPOOL_TOKENS).map((t) => ({
      asset_id: t.assetId,
      blockchain: t.blockchain,
      symbol: t.symbol,
      decimals: 6,
      price_usd: '1',
      popular: true,
    }));
    const options = buildDemoAssetOptions(tokens, true);
    for (const option of options) {
      expect(option.chainVariants.map((v) => v.name).sort()).toEqual(
        ['Base Sepolia', 'NEAR testnet', 'Solana devnet'].sort(),
      );
    }
    expect(buildDemoAssetOptions([token])[0]?.detail).toBe('Base');
  });
});

describe('hosted confirmation progress', () => {
  it('waits for API settlement in the full checkout instead of completing the Test flow on a timer', async () => {
    vi.useFakeTimers();
    const view = session('tidepool');
    view.status = 'PROCESSING';
    view.payments = [
      {
        id: 'pay_test',
        state: 'detected',
        amount_received: '1000000',
        overpaid_amount: null,
        refunded_amount: null,
        kept_small_overpayment: false,
        origin_tx_hash: 'testTx',
        created_at: new Date().toISOString(),
      },
    ];
    mockCheckoutApi(view);
    const { container } = await act(async () => render(<Checkout sessionId={id} />));
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(screen.queryByText('All set')).toBeNull();
    expect(container.querySelectorAll('li[data-done="true"]').length).toBe(1);
    view.status = 'SETTLED';
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    expect(screen.getByText('All set')).toBeTruthy();
  });

  it('never marks settlement complete on a timer while the API is still confirming', async () => {
    vi.useFakeTimers();
    const props = {
      variant: 'confirming' as const,
      skin: 'ecommerce' as const,
      merchantName: 'Store',
      merchantLogoUrl: '',
      payEyebrow: 'Paying',
      amountLabel: '$1',
      confirmationStep: 0 as const,
    };
    const { container, rerender } = render(<DemoStatusCard {...props} />);
    const done = () => container.querySelectorAll('li[data-done="true"]').length;
    expect(done()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(done()).toBe(0);
    rerender(<DemoStatusCard {...props} confirmationStep={1} />);
    expect(done()).toBe(1);
    rerender(<DemoStatusCard {...props} confirmationStep={2} />);
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(done()).toBe(2);
    expect(screen.queryByText('All set')).toBeNull();
    rerender(<DemoStatusCard {...props} variant="success" />);
    expect(screen.getByText('All set')).toBeTruthy();
  });
});
