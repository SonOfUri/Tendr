// The order value behind the per-payment caps (final wave, Task 11 MUST check): a session priced in
// its settlement asset is valued in USD at the token-list price, never as if its asset amount were
// dollars.
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import { orderUsd, setFeeDeps } from './fees.js';
import { planNetworkFee } from './quote-fee.js';

const ETH_BASE = 'nep141:base.omft.near';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const TOKENS: TokenInfo[] = [
  { assetId: ETH_BASE, symbol: 'ETH', blockchain: 'base', decimals: 18, priceUsd: '2500' },
  { assetId: USDC_BASE, symbol: 'USDC', blockchain: 'base', decimals: 6, priceUsd: '1.00' },
  { assetId: 'nep141:unpriced.near', symbol: 'X', blockchain: 'near', decimals: 6 },
];

describe('order value in USD', () => {
  beforeEach(() => {
    setFeeDeps({ tokens: async () => new Map(TOKENS.map((t) => [t.assetId, t])) });
  });
  afterEach(() => setFeeDeps(null));

  it('USD sessions are their amount; settlement-asset sessions use the token price', async () => {
    const d = (s: string) => new Prisma.Decimal(s);
    expect(await orderUsd({ amount: d('25.00'), amountCurrency: 'USD' }, false)).toBe('25');
    expect(await orderUsd({ amount: d('0.01'), amountCurrency: ETH_BASE }, false)).toBe('25');
    expect(await orderUsd({ amount: d('0.0000001234567'), amountCurrency: ETH_BASE }, false)).toBe(
      '0.000308',
    ); // rounded down
    expect(
      await orderUsd({ amount: d('5'), amountCurrency: 'nep141:unpriced.near' }, false),
    ).toBeNull();
  });

  const hookSession = (amount: string, amountCurrency: string) => ({
    id: 'ses_x',
    amount: new Prisma.Decimal(amount),
    amountCurrency,
    gasSponsor: 'buyer' as const,
    gasMaxUsd: null,
    delivery: 'HOOK' as const,
    destChain: 'eth',
  });
  const plan = (session: ReturnType<typeof hookSession>) =>
    planNetworkFee({
      livemode: false,
      merchantId: 'mer_x',
      session,
      origin: { assetId: USDC_BASE, blockchain: 'base', symbol: 'USDC' },
    });

  it('the 10 % hook cap is taken of the USD value, not the asset amount', async () => {
    // 0.01 ETH = $25: the simulated eth hook ($1.44) is 5.76 % → allowed.
    await expect(plan(hookSession('0.01', ETH_BASE))).resolves.toMatchObject({ hookUsd: '1.44' });
    // 0.004 ETH = $10: 14.4 % → refused.
    await expect(plan(hookSession('0.004', ETH_BASE))).rejects.toMatchObject({
      code: 'QUOTE_TOO_SMALL',
    });
    // Unpriced asset: the cap cannot be checked → unavailable, never assumed.
    await expect(plan(hookSession('100', 'nep141:unpriced.near'))).rejects.toMatchObject({
      code: 'NETWORK_FEE_UNAVAILABLE',
    });
  });
});
