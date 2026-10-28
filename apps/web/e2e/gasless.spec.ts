// End to end: gasless wallet payments (project 5a) on the pay page, in test mode with the
// simulated relayer. The shopper's EVM wallet is a test wallet injected as `window.ethereum`
// (NEXT_PUBLIC_E2E_INJECTED_WALLET, set by playwright.config.ts): it signs EIP-712 typed data with
// an ethers key in this Node process, so the API verifies real signatures. Nothing leaves the
// machine: the relay, 1Click and the chain are all simulated.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { Wallet, type TypedDataField } from 'ethers';
import { formatUnits } from '../src/lib/checkout/format';
import { blockExternal } from './support/network';
import { API_URL, E2E_CODE_HASH } from './support/urls';

const API_DIR = resolve(__dirname, '../../api');
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const MISMATCH =
  "This payment request doesn't match your price, so we didn't ask your wallet to sign it.";

interface Store {
  merchantId: string;
  secretKey: string;
}

function seedStore(): Store {
  const out = execFileSync(
    'npx',
    ['tsx', 'scripts/e2e-checkout-seed.ts', JSON.stringify({ checkoutDomains: [] })],
    {
      cwd: API_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, MERCHANT_ACCOUNT_CODE_HASH_TEST: E2E_CODE_HASH },
    },
  );
  return JSON.parse(out.trim().split('\n').at(-1)!) as Store;
}

async function api(path: string, method: string, key: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

/** A test-mode store that sponsors gas (policy on) or not, and one session for $25. */
async function storeAndSession(gasPayer: 'merchant' | 'shopper') {
  const store = seedStore();
  if (gasPayer === 'merchant') {
    const p = await api('/v1/gas-policy', 'PUT', store.secretKey, { enabled: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  const s = await api('/v1/checkout/sessions', 'POST', store.secretKey, {
    amount: '25.00',
    amount_currency: 'USD',
    external_ref: `order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    gas_payer: gasPayer,
    success_url: 'https://shop.example/thanks',
    cancel_url: 'https://shop.example/cart',
  });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return { store, session: s.body as { id: string; url: string; client_secret: string } };
}

/** Injects the test wallet; returns how many typed-data signatures it gave, and their domains. */
async function injectWallet(page: Page, opts: { balanceWei?: bigint } = {}) {
  const wallet = Wallet.createRandom();
  let signatures = 0;
  const domains: Record<string, unknown>[] = [];
  await page.exposeFunction('__e2eSignTypedData', async (json: string) => {
    signatures++;
    const td = JSON.parse(json) as {
      domain: Record<string, unknown>;
      types: Record<string, TypedDataField[]>;
      message: Record<string, unknown>;
    };
    domains.push(td.domain);
    const { EIP712Domain: _domain, ...types } = td.types;
    return wallet.signTypedData(td.domain, types, td.message);
  });
  await page.addInitScript(
    ({ address, balance }) => {
      const w = window as unknown as {
        ethereum: unknown;
        __e2eSignTypedData: (json: string) => Promise<string>;
      };
      w.ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [address];
            case 'eth_chainId':
              return '0x2105';
            case 'wallet_switchEthereumChain':
              return null;
            case 'eth_getCode':
              return '0x';
            case 'eth_getBalance':
              return balance;
            case 'eth_signTypedData_v4':
              return w.__e2eSignTypedData(String(params![1]));
            default:
              throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
          }
        },
      };
    },
    { address: wallet.address, balance: '0x' + (opts.balanceWei ?? 0n).toString(16) },
  );
  return { wallet, signatures: () => signatures, domains: () => domains };
}

/** Requests the page made to the API, by path suffix. */
function recordRequests(page: Page) {
  const seen: Request[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(API_URL)) seen.push(r);
  });
  return (suffix: string) => seen.filter((r) => new URL(r.url()).pathname.endsWith(suffix));
}

async function chooseUsdcAndConnect(page: Page) {
  await page.getByRole('button', { name: 'USDC Base', exact: true }).click();
  await expect(page.getByText('You send')).toBeVisible();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByText(/Paying from/)).toBeVisible();
}

const payButton = (page: Page) => page.getByRole('button', { name: /^Pay [\d.]+ USDC$/ });

test.describe('gasless wallet payments (test mode, simulated relayer)', () => {
  test.beforeEach(async ({ context }) => {
    await blockExternal(context);
  });

  test('sponsored EVM USDC: "Network fee: paid by …", one signature, relayed, paid', async ({
    page,
  }) => {
    const { session } = await storeAndSession('merchant');
    const w = await injectWallet(page);
    const requests = recordRequests(page);
    await page.goto(session.url);
    await chooseUsdcAndConnect(page);

    await expect(page.getByText(/^Network fee: paid by E2E Shop /)).toBeVisible();
    await expect(page.getByText('Pay the fee in')).toHaveCount(0);
    // The wallet-path quote names the wallet and the method; the copy-address note stays below.
    const quote = requests('/quote').at(-1)!;
    expect(JSON.parse(quote.postData()!)).toMatchObject({
      origin_asset: USDC_BASE,
      wallet_address: w.wallet.address,
      gasless_method: 'eip3009',
    });
    await expect(page.getByText('You pay the network fee from your wallet')).toBeVisible();
    // The signing step says it is a test payment (ruling T10-f).
    await expect(page.getByText(/Test mode: your wallet signs a test payment/)).toBeVisible();

    await payButton(page).click();
    await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
      timeout: 60_000,
    });
    expect(w.signatures()).toBe(1);
    expect(requests('/gasless/submit')).toHaveLength(1);
    // What the wallet signed can never be executed on a real chain: the test domain at the
    // code-less sentinel, never USDC's own domain.
    expect(w.domains()).toEqual([
      {
        name: 'Tendr test payment',
        version: '1',
        chainId: 8453,
        verifyingContract: '0x7E57000000000000000000000000000000007E57',
      },
    ]);
  });

  test('shopper pays in the token: the "+… USDC" fee line, two signatures, paid', async ({
    page,
  }) => {
    const { session } = await storeAndSession('shopper');
    const w = await injectWallet(page);
    const requests = recordRequests(page);
    await page.goto(session.url);
    await chooseUsdcAndConnect(page);

    // Both ways are possible: the choice, the token selected by default (no ETH in the wallet).
    const inToken = page.getByRole('radio', { name: /Pay the fee in USDC/ });
    await expect(inToken).toBeChecked();
    await expect(page.getByText(/\(\+0\.\d+ USDC\)/)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Pay the fee in ETH' })).not.toBeChecked();
    expect(JSON.parse(requests('/quote').at(-1)!.postData()!)).toMatchObject({
      gasless_method: 'eip3009',
      fee_mode: 'token',
    });
    // The pay button shows the total: the payment plus the fee (I1).
    const quote = await api('/v1/checkout/client/session', 'GET', session.client_secret);
    const q = quote.body.quote as { amount_in: string; fee_amount: string };
    const total = formatUnits(BigInt(q.amount_in) + BigInt(q.fee_amount), 6);
    await expect(payButton(page)).toHaveText(`Pay ${total} USDC`);

    await payButton(page).click();
    await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
      timeout: 60_000,
    });
    // The payment and the fee authorization.
    expect(w.signatures()).toBe(2);
  });

  test('paying the fee in ETH re-quotes for a normal send: nothing is prepared or signed', async ({
    page,
  }) => {
    const { session } = await storeAndSession('shopper');
    const w = await injectWallet(page);
    const requests = recordRequests(page);
    await page.goto(session.url);
    await chooseUsdcAndConnect(page);

    await page.getByRole('radio', { name: 'Pay the fee in ETH' }).check();
    await expect(page.getByRole('radio', { name: 'Pay the fee in ETH' })).toBeChecked();
    await expect
      .poll(() => JSON.parse(requests('/quote').at(-1)!.postData()!).fee_mode)
      .toBe('native');
    // The normal send: in test mode wallets never send; the test controls stand in for it.
    await expect(
      page.getByText("Test mode: payments aren't sent from wallets. Use the test controls below."),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Pay the exact amount' }).click();
    await expect(page.getByRole('heading', { name: /Payment complete/ })).toBeVisible({
      timeout: 60_000,
    });
    expect(requests('/gasless/prepare')).toHaveLength(0);
    expect(w.signatures()).toBe(0);
  });

  test('a wallet holding twice the coin fee starts on "Pay the fee in ETH"', async ({ page }) => {
    const { session } = await storeAndSession('shopper');
    const requests = recordRequests(page);
    await injectWallet(page, { balanceWei: 10n ** 19n });
    await page.goto(session.url);
    await chooseUsdcAndConnect(page);
    await expect(page.getByRole('radio', { name: 'Pay the fee in ETH' })).toBeChecked();
    expect(JSON.parse(requests('/quote').at(-1)!.postData()!)).toMatchObject({
      gasless_method: 'eip3009',
      fee_mode: 'native',
    });
  });

  test('a prepared payment that does not match the quote is never signed or relayed', async ({
    page,
  }) => {
    const { session } = await storeAndSession('merchant');
    const w = await injectWallet(page);
    const requests = recordRequests(page);
    // The prepare answer is tampered with on its way: another destination.
    await page.route('**/v1/checkout/client/gasless/prepare', async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as {
        to_sign: { typed_data: { message: Record<string, string> } }[];
      };
      json.to_sign[0]!.typed_data.message.to = '0x000000000000000000000000000000000000bEEF';
      await route.fulfill({ response: res, json });
    });
    await page.goto(session.url);
    await chooseUsdcAndConnect(page);
    await payButton(page).click();

    await expect(page.getByText(MISMATCH, { exact: false })).toBeVisible();
    expect(w.signatures()).toBe(0);
    expect(requests('/gasless/submit')).toHaveLength(0);
    // Nothing happened: the session still waits for a payment, the manual send stays on offer.
    const view = await api('/v1/checkout/client/session', 'GET', session.client_secret);
    expect(view.body.status).toBe('PENDING_DEPOSIT');
    await expect(page.getByText('or send it yourself')).toBeVisible();
  });
});
