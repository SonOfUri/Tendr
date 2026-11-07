import { api } from '@/lib/api';

export interface IntentsToken {
  asset: string;
  symbol: string;
  chain: string;
  decimals: number;
}

export interface IntentsCatalog {
  tokens: IntentsToken[];
  chains: string[];
}

/**
 * The live 1Click catalog. Saved addresses, withdrawals, and Create Link settlement use it in
 * either dashboard mode: test mode's own token list is only the checkout fixture.
 */
export async function loadIntentsCatalog(signal?: AbortSignal): Promise<IntentsCatalog> {
  const res = await api<IntentsCatalog & { chains?: string[] }>(
    '/v1/payment_links/settlement-options',
    { livemode: true, signal },
  );
  const chains = res.chains?.length
    ? res.chains
    : [...new Set(res.tokens.map((token) => token.chain))];
  return { tokens: res.tokens, chains };
}
